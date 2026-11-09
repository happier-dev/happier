import { lazyZodSchema } from '../lazyZodSchema.js';
import { decodeBase64, encodeBase64 } from '../crypto/base64.js';
import { z } from 'zod/mini';
import { createStoredReadSchema } from '../json/storedReadSchema.js';

const ArtifactStoredJsonContentEnvelopeSchema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.strictObject({
    t: z.literal('plain'),
    v: z.json(),
  }),
  z.strictObject({
    t: z.literal('encrypted'),
    c: z.string().check(z.minLength(1)),
  }),
]));
type ArtifactStoredJsonContentEnvelope = z.infer<typeof ArtifactStoredJsonContentEnvelopeSchema>;

function encodeStoredJsonContentEnvelope(value: unknown): string {
  const envelope = ArtifactStoredJsonContentEnvelopeSchema.parse({
    t: 'plain',
    v: value,
  });
  return encodeBase64(
    new TextEncoder().encode(JSON.stringify(envelope)),
    'base64',
  );
}

export const ARTIFACT_PLAIN_DATA_KEY_MARKER = encodeStoredJsonContentEnvelope(null);

const LEADING_BASE64_QUANTUM = /^[A-Za-z0-9+/]{4}/;

/**
 * Only text whose first significant character is `{` can become an envelope.
 * Sealed data keys are binary, so readers that ask "is this a plain marker?"
 * per Artifact would otherwise decode, UTF-8 decode and throw out of
 * JSON.parse for every encrypted key. The first full base64 quantum is
 * unaffected by the decoder's permissive normalization, so rejecting on its
 * first byte is exact; whitespace and a UTF-8 BOM keep the full reader.
 */
function cannotBeStoredJsonObject(value: string): boolean {
  if (!LEADING_BASE64_QUANTUM.test(value)) return false;
  const first = decodeBase64(value.slice(0, 4), 'base64')[0];
  return first !== 0x7b && first !== 0x20 && first !== 0x09 && first !== 0x0a && first !== 0x0d && first !== 0xef;
}

function decodeStoredJsonContentEnvelope(value: string): ArtifactStoredJsonContentEnvelope | null {
  if (cannotBeStoredJsonObject(value)) return null;
  try {
    const parsed = createStoredReadSchema(ArtifactStoredJsonContentEnvelopeSchema).safeParse(
      JSON.parse(new TextDecoder().decode(decodeBase64(value, 'base64'))),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function isPlainArtifactDataKeyMarker(value: string): boolean {
  // Exact bytes produced and admitted above are immutable; other stored shapes
  // still pass through the tolerant reader, including additive envelopes.
  if (value === ARTIFACT_PLAIN_DATA_KEY_MARKER) return true;
  const envelope = decodeStoredJsonContentEnvelope(value);
  return envelope?.t === 'plain' && envelope.v === null;
}

export function isPlainArtifactStoredContent(value: string): boolean {
  return decodeStoredJsonContentEnvelope(value)?.t === 'plain';
}

export function encodePlainArtifactStoredContent(value: unknown): string {
  return encodeStoredJsonContentEnvelope(value);
}

export function decodePlainArtifactStoredContent(value: string): unknown | null {
  const envelope = decodeStoredJsonContentEnvelope(value);
  return envelope?.t === 'plain' ? envelope.v : null;
}
