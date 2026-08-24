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
 * Rejection is not an error state *for the end user*: an unrenderable mark
 * falls back to the same neutral text presentation an absent mark already uses.
 * It is very much one for the AUTHOR, who otherwise cannot tell a refused image
 * from an image they never shipped, so every refusal is returned as an
 * attributable diagnostic and each admitting owner reports it under the
 * identity only that owner knows.
 */
import type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';

type PluginDiagnosticData = Parameters<PluginUiHostApi['diagnostic']>[0];

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
 * leaves roughly four times that headroom. The one-time materialization costs
 * about 3 ms at the ceiling and about 1 ms for that largest real mark, both
 * measured with the encoder below as the minimum CPU time of nine runs.
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

/**
 * Why one byte identity is not renderable.
 *
 * Structurally a `PluginDiagnosticData`, because the author-facing diagnostic
 * channel is what an owner reports it through: the code, the severity and the
 * deciding numbers are decided once, here, so two owners cannot describe the
 * same refusal differently. Only the identity of *which* image was refused is
 * added by the owner that knows it.
 */
export type HappierRenderableImageRefusal = Readonly<{
  code:
  | 'plugin_renderable_image_empty'
  | 'plugin_renderable_image_not_png'
  | 'plugin_renderable_image_too_many_bytes'
  | 'plugin_renderable_image_too_many_pixels';
  severity: 'warning';
  message: string;
  details: Readonly<{
    byteLength: number;
    /** The ceiling the refusal was measured against; absent when no ceiling decided it. */
    limit?: number;
    /** The declared canvas, present once the bytes parsed as a PNG. */
    pixels?: number;
  }>;
}>;

/** Admission is a decision, not an absence: a refusal names the bound that made it. */
export type HappierRenderableImageAdmission =
  | Readonly<{ admitted: true; source: HappierRenderableImageSource }>
  | Readonly<{ admitted: false; refusal: HappierRenderableImageRefusal }>;

function refuse(
  code: HappierRenderableImageRefusal['code'],
  message: string,
  details: HappierRenderableImageRefusal['details'],
): HappierRenderableImageAdmission {
  return Object.freeze({
    admitted: false as const,
    refusal: Object.freeze({
      code,
      severity: 'warning' as const,
      message,
      details: Object.freeze(details),
    }) satisfies PluginDiagnosticData,
  });
}

const PNG_SIGNATURE = Object.freeze([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Signature + complete IHDR (including CRC) + the mandatory terminal IEND chunk. */
const PNG_MINIMUM_COMPLETE_BYTES = 45;

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
// React Native provides neither `btoa` nor `Buffer`, so the portable encoder
// stays local. Direct alphabet indexing avoids a 4,096-entry startup table;
// measurement found no material ordinary-image benefit from that table.
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
    buffer += (
      BASE64_ALPHABET[(group >>> 18) & 63]!
      + BASE64_ALPHABET[(group >>> 12) & 63]!
      + BASE64_ALPHABET[(group >>> 6) & 63]!
      + BASE64_ALPHABET[group & 63]!
    );
    if (buffer.length >= BASE64_CHUNK_CHARS) {
      chunks.push(buffer);
      buffer = '';
    }
  }
  if (remainder === 1) {
    const group = bytes[triples]! << 16;
    buffer += `${BASE64_ALPHABET[(group >>> 18) & 63]!}${BASE64_ALPHABET[(group >>> 12) & 63]!}==`;
  } else if (remainder === 2) {
    const group = (bytes[triples]! << 16) | (bytes[triples + 1]! << 8);
    buffer += (
      `${BASE64_ALPHABET[(group >>> 18) & 63]!}`
      + `${BASE64_ALPHABET[(group >>> 12) & 63]!}`
      + `${BASE64_ALPHABET[(group >>> 6) & 63]!}=`
    );
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
  if (bytes.byteLength < PNG_MINIMUM_COMPLETE_BYTES) return null;
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (bytes[index] !== PNG_SIGNATURE[index]) return null;
  }
  // The IHDR chunk is required to be first, so its width/height sit at fixed
  // offsets; anything else is not a decodable PNG for our purposes.
  if (
    bytes[8] !== 0x00 || bytes[9] !== 0x00 || bytes[10] !== 0x00 || bytes[11] !== 0x0d
    || bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52
  ) return null;
  // PNG requires IEND to be the final chunk. Checking that fixed terminator is
  // enough to reject a truncated prefix without walking chunks or validating CRCs.
  const iend = bytes.byteLength - 12;
  if (
    bytes[iend] !== 0x00 || bytes[iend + 1] !== 0x00 || bytes[iend + 2] !== 0x00 || bytes[iend + 3] !== 0x00
    || bytes[iend + 4] !== 0x49 || bytes[iend + 5] !== 0x45 || bytes[iend + 6] !== 0x4e || bytes[iend + 7] !== 0x44
  ) return null;
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
 * Called by the owners that acquire bytes, never from a render. A refusal is
 * the neutral-fallback outcome for the reader rather than a failure, but it is
 * returned as an attributable diagnostic so the owner that knows which image
 * these bytes are can tell its author which bound refused them and why.
 */
export function materializeHappierRenderableImage(
  bytes: Uint8Array,
): HappierRenderableImageAdmission {
  const existing = SOURCE_BY_ADMITTED_BYTES.get(bytes);
  if (existing) return Object.freeze({ admitted: true as const, source: existing });
  const byteLength = bytes.byteLength;
  if (byteLength === 0) {
    return refuse(
      'plugin_renderable_image_empty',
      'Renderable image bytes are empty.',
      { byteLength },
    );
  }
  if (byteLength > HAPPIER_MAX_RENDERABLE_IMAGE_BYTES) {
    return refuse(
      'plugin_renderable_image_too_many_bytes',
      `Renderable image is ${byteLength} bytes, past the ${HAPPIER_MAX_RENDERABLE_IMAGE_BYTES}-byte ceiling.`,
      { byteLength, limit: HAPPIER_MAX_RENDERABLE_IMAGE_BYTES },
    );
  }
  const pixels = readHappierPngPixelCount(bytes);
  if (pixels === null) {
    return refuse(
      'plugin_renderable_image_not_png',
      `Renderable image bytes are not a PNG; ${HAPPIER_RENDERABLE_IMAGE_CONTENT_TYPE} is the one renderable type.`,
      { byteLength },
    );
  }
  if (pixels > HAPPIER_MAX_RENDERABLE_IMAGE_PIXELS) {
    return refuse(
      'plugin_renderable_image_too_many_pixels',
      `Renderable image declares ${pixels} pixels, past the ${HAPPIER_MAX_RENDERABLE_IMAGE_PIXELS}-pixel decode ceiling.`,
      { byteLength, pixels, limit: HAPPIER_MAX_RENDERABLE_IMAGE_PIXELS },
    );
  }
  const source = Object.freeze({
    uri: `data:${HAPPIER_RENDERABLE_IMAGE_CONTENT_TYPE};base64,${bytesToBase64(bytes)}`,
  });
  SOURCE_BY_ADMITTED_BYTES.set(bytes, source);
  return Object.freeze({ admitted: true as const, source });
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
