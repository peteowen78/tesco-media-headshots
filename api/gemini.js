import { timingSafeEqual } from 'node:crypto';

/* ─── Gemini proxy ───
   The page sends only the selfie and the chosen clothing option. The prompt
   and the model are decided HERE, on the server, so this endpoint cannot be
   used as a general-purpose image generator on the project's API key.

   Environment variables (Vercel → Settings → Environment Variables):
     GEMINI_API_KEY  required — Google AI Studio key
     APP_PASSCODE    optional — if set, every request must send it in the
                     x-app-passcode header (the page asks for it once)
     GEMINI_MODEL    optional — override the image model without a code change */

const DEFAULT_MODEL   = 'gemini-2.5-flash-image';
const ALLOWED_MIMES   = ['image/jpeg', 'image/png', 'image/webp'];
const CLOTHING        = ['smart-casual', 'keep'];
const MAX_BASE64_CHARS = 6 * 1024 * 1024; // ≈4.5 MB image — the page sends ~0.5 MB

export function buildPrompt(clothing) {
  const clothingText = clothing === 'keep'
    ? 'Keep the subject\'s existing clothing exactly as worn — do not replace or change it. Subtly smarten: remove creases, tidy the collar, ensure it looks well-fitted and polished.'
    : 'Base the clothing on what the subject is actually wearing in the selfie — same garment types, same colours, recognisably their own look. Present it at its best: freshly laundered and pressed, no creases or stains, collar and seams sitting neatly, well-fitted. Only if a garment is clearly unsuitable for a professional headshot (heavily worn, stained, or gym wear), replace it with the nearest smarter equivalent in the same style and colour — a tired t-shirt becomes a clean well-fitted plain t-shirt, a hoodie becomes a smart knit. Do NOT add a blazer, suit jacket or tie unless the subject is already wearing one, and do not change the overall style of their outfit.';

  // Composition is deliberately a little loose: the page measures the face
  // afterwards and crops every headshot to the same size and position, so the
  // model only needs to leave clean backdrop around a complete subject.
  return `[COMPOSITION — follow exactly]
- Output is a portrait crop, 3:4 aspect ratio
- Classic head-and-shoulders framing: the frame cuts off at mid-chest
- The face must be centred horizontally, head upright and level, looking straight at the camera
- Leave clear empty backdrop above the top of the hair — roughly 10% of the frame height
- The head (chin to top of hair) should fill roughly half of the frame height
- Both shoulders and upper arms must be complete and fully visible inside the frame, with background visible to the left and right of them — never cut the subject off at the left or right edges

[CAMERA & LIGHTING]
High-end full-frame digital camera, 85mm portrait prime lens. Soft directional studio light, gentle fill on opposite side. Deep depth of field — the ENTIRE subject must be in crisp sharp focus, including both shoulders and all clothing. No blur, haze, mist, smoke, fog, vignette or soft shadow effects anywhere in the image.

[STYLE]
Clean editorial studio headshot. Modern, confident, approachable. High-end professional portrait photography.

[SUBJECT]
Transform this selfie into a crisp professional headshot. The face is SACRED — reproduce it with absolute pixel-perfect fidelity. Do NOT smooth skin, slim the face, alter jaw shape, resize eyes, change nose shape, whiten teeth, or modify any facial feature in any way whatsoever. The face in the output must be identical to the face in the input. Same wrinkles, same pores, same asymmetries, same glasses, same expression. Hair and skin tone must also be exactly preserved. ${clothingText} Natural, confident posture, slight forward lean. The selfie may crop off the shoulders or upper arms at the photo edges — you MUST reconstruct the missing shoulders, arms and clothing naturally and completely, matching the visible clothing, pose and body proportions, so the whole head-and-shoulders subject is present in the output. Never leave shoulders missing, incomplete or faded.

[BACKGROUND]
Fill the entire background with a single flat, solid, uniform very pale icy sky blue — approximately hex #E4F3FF. No gradients, no texture, no shadows, no vignette.

[REFINEMENT]
No heavy retouching. No lens distortion. No oversaturation. Do not change the person's identity.`;
}

function fail(res, status, error, code) {
  return res.status(status).json(code ? { error, code } : { error });
}

// Browsers always send Origin on a cross-site POST. If it is present it must
// be this deployment's own address; other websites are refused.
function isForeignOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  try { return new URL(origin).host !== host; } catch { return true; }
}

function passcodeOk(req) {
  const expected = process.env.APP_PASSCODE;
  if (!expected) return true; // passcode protection not switched on
  const a = Buffer.from(String(req.headers['x-app-passcode'] || ''));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return fail(res, 405, 'Method not allowed');
  if (isForeignOrigin(req))  return fail(res, 403, 'This service can only be used from its own website.');
  if (!passcodeOk(req))      return fail(res, 401, 'A passcode is required to use this tool.', 'PASSCODE_REQUIRED');

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return fail(res, 500, 'GEMINI_API_KEY is not set on the server.');

  const { imgBase64, imgMime, clothing } = req.body || {};
  if (typeof imgBase64 !== 'string' || !imgBase64) return fail(res, 400, 'No photo was sent.');
  if (imgBase64.length > MAX_BASE64_CHARS)          return fail(res, 413, 'That photo is too large — please use a smaller one.');
  if (!ALLOWED_MIMES.includes(imgMime))             return fail(res, 400, 'Unsupported photo type — please use JPG, PNG or WEBP.');
  if (!CLOTHING.includes(clothing))                 return fail(res, 400, 'Unknown clothing option.');

  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  let data, status;
  try {
    const geminiRes = await fetch(geminiUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: buildPrompt(clothing) },
            { inlineData: { mimeType: imgMime, data: imgBase64 } }
          ]
        }],
        generationConfig: { responseModalities: ['IMAGE', 'TEXT'] }
      })
    });
    status = geminiRes.status;
    data   = await geminiRes.json().catch(() => ({}));
  } catch (err) {
    return fail(res, 502, `Could not reach the image service: ${err.message}`);
  }

  if (status >= 400) {
    const reason = data?.error?.message || `status ${status}`;
    return fail(res, 502, `The image service returned an error: ${reason}`, 'UPSTREAM');
  }

  const candidate = data?.candidates?.[0];
  const imgPart   = (candidate?.content?.parts || []).find(p => p.inlineData?.data);
  if (!imgPart) {
    const reason = candidate?.finishReason || data?.promptFeedback?.blockReason;
    if (reason && /SAFETY|RECITATION|BLOCK|PROHIBITED/i.test(reason)) {
      return fail(res, 422, 'The request was blocked by safety filters. Please try a different photo.', 'BLOCKED');
    }
    return fail(res, 502, 'No image came back from the model — please try again.', 'NO_IMAGE');
  }

  return res.status(200).json({
    image: { base64: imgPart.inlineData.data, mime: imgPart.inlineData.mimeType || 'image/png' }
  });
}
