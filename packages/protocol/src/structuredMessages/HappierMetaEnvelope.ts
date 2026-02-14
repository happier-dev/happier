import { z } from 'zod';

/**
 * Message-level structured meta payload envelope stored under `message.meta.happier`.
 *
 * UI renderers must Zod-parse `payload` by kind and never deep-merge untrusted objects.
 */
export const HappierMetaEnvelopeSchema = z.object({
  kind: z.string().min(1),
  payload: z.unknown(),
});

export type HappierMetaEnvelope = z.infer<typeof HappierMetaEnvelopeSchema>;

