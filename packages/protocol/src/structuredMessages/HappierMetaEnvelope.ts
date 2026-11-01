import { z } from 'zod';
import { lazySchema } from '../lazySchema.js';

/**
 * Message-level structured meta payload envelope stored under `message.meta.happier`.
 *
 * UI renderers must Zod-parse `payload` by kind and never deep-merge untrusted objects.
 */
export function createHappierMetaEnvelopeSchema(zod: typeof z) {
  return zod.object({
    kind: zod.string().min(1),
    payload: zod.unknown().optional(),
  });
}

export const HappierMetaEnvelopeSchema = lazySchema(() => createHappierMetaEnvelopeSchema(z));

export type HappierMetaEnvelope = z.infer<typeof HappierMetaEnvelopeSchema>;

