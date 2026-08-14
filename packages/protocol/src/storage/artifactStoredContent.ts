import { decodeBase64, encodeBase64 } from '../crypto/base64.js';
import { z } from 'zod';

const ArtifactStoredJsonContentEnvelopeSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('plain'),
    v: z.json(),
  }).strict(),
  z.object({
    t: z.literal('encrypted'),
    c: z.string().min(1),
  }).strict(),
]);
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

function decodeStoredJsonContentEnvelope(value: string): ArtifactStoredJsonContentEnvelope | null {
  try {
    const parsed = ArtifactStoredJsonContentEnvelopeSchema.safeParse(
      JSON.parse(new TextDecoder().decode(decodeBase64(value, 'base64'))),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function isPlainArtifactDataKeyMarker(value: string): boolean {
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
