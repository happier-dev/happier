import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';

export const PromptArtifactKindV1Schema = lazyZodSchema(() => z.enum(['doc', 'bundle']));
export type PromptArtifactKindV1 = z.infer<typeof PromptArtifactKindV1Schema>;

export const PromptArtifactRefV1Schema = lazyZodSchema(() => z.strictObject({
  kind: PromptArtifactKindV1Schema,
  artifactId: z.string().check(z.minLength(1)),
  // Omission addresses the admitted owner's Home; this address confers no access.
  serverId: z.optional(z.string().check(z.minLength(1))),
}));
export type PromptArtifactRefV1 = z.infer<typeof PromptArtifactRefV1Schema>;
export const PromptArtifactRefV1StoredSchema = createStoredReadSchema(PromptArtifactRefV1Schema);

export const PromptDocArtifactRefV1Schema = lazyZodSchema(() => z.extend(PromptArtifactRefV1Schema, {
  kind: z.literal('doc'),
}));
export type PromptDocArtifactRefV1 = z.infer<typeof PromptDocArtifactRefV1Schema>;
