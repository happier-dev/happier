import { z } from 'zod';

// Canonical envelope for JSON-like content that may be plaintext or opaque ciphertext.
//
// Notes:
// - The envelope is used for server-stored "blob" payloads (settings, credentials, templates).
// - It intentionally does NOT encode storage-at-rest policies (e.g. server-sealed). Those are internal.
export const StoredJsonContentEnvelopeSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('plain'),
    v: z.unknown(),
  }),
  z.object({
    t: z.literal('encrypted'),
    c: z.string().min(1),
  }),
]);

export type StoredJsonContentEnvelope = z.infer<typeof StoredJsonContentEnvelopeSchema>;

