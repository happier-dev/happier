/**
 * The one admission boundary between admitted bytes and a renderable image.
 *
 * Two facts make this a boundary rather than a helper.
 *
 * **It is not a render-time derivation.** Encoding a data URI is linear in the
 * byte length, and the admitted Resource ceiling is 16 MiB: converting those
 * bytes inside a React render froze the UI for 8.2 s on this host (measured on
 * Node 22 with the predecessor encoder). Materialization therefore happens
 * exactly where the bytes are admitted — the Resource store's read resolution
 * and the host brand reader's async resolve — both of which are already off the
 * render path. The presentation layer only *reads* what those owners recorded,
 * so no render can pay for a conversion even once.
 *
 * **A byte bound is not a decode bound.** PNG is compressed, so a small file
 * can still declare an enormous canvas; a 16 MiB PNG may decode to gigabytes of
 * RGBA. The declared canvas is in the IHDR header, thirty-three bytes in, so
 * this owner reads it and refuses anything past the product ceiling before a
 * platform image host is ever handed a source. One ceiling, shared by every
 * platform and every renderer; a renderer never invents its own.
 *
 * Rejection is not an error state: an unrenderable mark falls back to the same
 * neutral text presentation an absent mark already uses.
 */

/**
 * A platform image source derived from one admitted byte identity.
 *
 * The whole object is retained rather than the URI string, because a fresh
 * `{ uri }` on every render re-enters the native image host's source diff and
 * defeats memoization on `react-native-web`.
 */
export type HappierRenderableImageSource = Readonly<{ uri: string }>;

/** The one renderable packaged image type; `SDK-BRAND-ASSET` declares PNG. */
export const HAPPIER_RENDERABLE_IMAGE_CONTENT_TYPE = 'image/png';

/**
 * The product ceiling on an admitted renderable image's encoded size.
 *
 * Derived from what the shipped marks actually are, not from the Resource
 * ceiling: the largest first-party packaged mark is 135 511 B
 * (`plugins/inspector/assets/brand.png`), and the rest are under 8 KiB. This
 * leaves roughly four times that headroom while keeping the one-time
 * materialization at 275 ms at the ceiling and 7 ms for that largest real
 * mark, measured with the encoder below.
 */
export const HAPPIER_MAX_RENDERABLE_IMAGE_BYTES = 512 * 1024;

/**
 * The product ceiling on an admitted renderable image's decoded canvas.
 *
 * A bounded image renders at most `large` — 72 pt, so 216 device pixels at 3x —
 * and the largest first-party mark is 1024x1024. Four megapixels is four times
 * that, and caps decoded RGBA at 16 MiB on every platform.
 */
export const HAPPIER_MAX_RENDERABLE_IMAGE_PIXELS = 4_194_304;

const PNG_SIGNATURE = Object.freeze([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Signature (8) + IHDR length/type (8) + width (4) + height (4). */
const PNG_IHDR_MINIMUM_BYTES = 24;

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/**
 * Every twelve-bit group as its two-character encoding. Halving the loop's
 * iterations and its string appends is what keeps the bounded conversion in the
 * tens of milliseconds instead of the hundreds.
 */
const BASE64_TWELVE_BIT_PAIRS: readonly string[] = Object.freeze(
  Array.from({ length: 4096 }, (_unused, value) => (
    BASE64_ALPHABET[(value >>> 6) & 63]! + BASE64_ALPHABET[value & 63]!
  )),
);
/** Flush point for the accumulating rope; keeps peak intermediate strings small. */
const BASE64_CHUNK_CHARS = 32_768;

function bytesToBase64(bytes: Uint8Array): string {
  const length = bytes.length;
  const remainder = length % 3;
  const triples = length - remainder;
  const chunks: string[] = [];
  let buffer = '';
  for (let index = 0; index < triples; index += 3) {
    const group = (bytes[index]! << 16) | (bytes[index + 1]! << 8) | bytes[index + 2]!;
    buffer += BASE64_TWELVE_BIT_PAIRS[group >>> 12]! + BASE64_TWELVE_BIT_PAIRS[group & 4095]!;
    if (buffer.length >= BASE64_CHUNK_CHARS) {
      chunks.push(buffer);
      buffer = '';
    }
  }
  if (remainder === 1) {
    const group = bytes[triples]! << 16;
    buffer += `${BASE64_TWELVE_BIT_PAIRS[group >>> 12]!}==`;
  } else if (remainder === 2) {
    const group = (bytes[triples]! << 16) | (bytes[triples + 1]! << 8);
    buffer += `${BASE64_TWELVE_BIT_PAIRS[group >>> 12]!}${BASE64_ALPHABET[(group >>> 6) & 63]!}=`;
  }
  if (buffer.length > 0) chunks.push(buffer);
  return chunks.join('');
}

function readUint32BigEndian(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! * 0x1000000)
    + ((bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!)
  );
}

/**
 * The declared canvas of a PNG, or `null` when these are not PNG bytes.
 *
 * The signature check is the content-type authority here: a declared MIME type
 * is a claim about bytes, and the bytes themselves answer for what a platform
 * image host will try to decode.
 */
export function readHappierPngPixelCount(bytes: Uint8Array): number | null {
  if (bytes.byteLength < PNG_IHDR_MINIMUM_BYTES) return null;
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (bytes[index] !== PNG_SIGNATURE[index]) return null;
  }
  // The IHDR chunk is required to be first, so its width/height sit at fixed
  // offsets; anything else is not a decodable PNG for our purposes.
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) return null;
  const width = readUint32BigEndian(bytes, 16);
  const height = readUint32BigEndian(bytes, 20);
  if (width <= 0 || height <= 0) return null;
  return width * height;
}

/**
 * One derived source per admitted byte identity.
 *
 * Keyed weakly on the byte array because the Resource store already collapses
 * digest-equal reads onto one retained `ResourceContent`, which makes the array
 * itself the admitted identity. A derived source therefore lives exactly as
 * long as the bytes some owner still holds: no lifecycle, no eviction policy,
 * no capacity, and no ability to answer for bytes nobody is holding.
 */
const SOURCE_BY_ADMITTED_BYTES = new WeakMap<Uint8Array, HappierRenderableImageSource>();

/**
 * Admit one byte identity as a renderable image and record its source.
 *
 * Called by the owners that acquire bytes, never from a render. Returns `null`
 * when the bytes are not a renderable image or exceed a product ceiling, which
 * is the neutral-fallback outcome rather than a failure.
 */
export function materializeHappierRenderableImage(
  bytes: Uint8Array,
): HappierRenderableImageSource | null {
  const existing = SOURCE_BY_ADMITTED_BYTES.get(bytes);
  if (existing) return existing;
  if (bytes.byteLength === 0 || bytes.byteLength > HAPPIER_MAX_RENDERABLE_IMAGE_BYTES) return null;
  const pixels = readHappierPngPixelCount(bytes);
  if (pixels === null || pixels > HAPPIER_MAX_RENDERABLE_IMAGE_PIXELS) return null;
  const source = Object.freeze({
    uri: `data:${HAPPIER_RENDERABLE_IMAGE_CONTENT_TYPE};base64,${bytesToBase64(bytes)}`,
  });
  SOURCE_BY_ADMITTED_BYTES.set(bytes, source);
  return source;
}

/**
 * The renderable source an owner already admitted for these bytes.
 *
 * Deliberately pure: it cannot derive, so no render can be made to pay for a
 * conversion by passing bytes no owner admitted. Bytes that were never admitted
 * — or that a ceiling refused — read as `undefined` and present the same
 * neutral fallback an absent mark uses.
 */
export function readHappierRenderableImageSource(
  bytes: Uint8Array | undefined,
): HappierRenderableImageSource | undefined {
  return bytes === undefined ? undefined : SOURCE_BY_ADMITTED_BYTES.get(bytes);
}
