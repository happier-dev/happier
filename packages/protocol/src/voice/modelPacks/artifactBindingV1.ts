import { z } from '../../zodRuntimePolicy.js';

import { lazyZodSchema } from '../../lazyZodSchema.js';
import { DevelopmentPluginSourceCustodyV1Schema } from '../../plugins/runtime/sourceCustody.js';

/** Canonical closed binding; persisted readers derive their drop projection. */
export const VoiceModelPackArtifactBindingV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({
    kind: z.literal('sourceIntegrity'),
    integrity: z.string().check(z.minLength(1), z.maxLength(1024), z.refine((value) => value.trim() === value)),
  }),
  z.strictObject({
    kind: z.literal('materialization'),
    sourceCustody: DevelopmentPluginSourceCustodyV1Schema,
  }),
]));

export type VoiceModelPackArtifactBindingV1 = z.infer<typeof VoiceModelPackArtifactBindingV1Schema>;
