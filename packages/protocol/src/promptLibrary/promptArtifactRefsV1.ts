import { z } from 'zod';

export const PromptArtifactKindV1Schema = z.enum(['doc', 'bundle']);
export type PromptArtifactKindV1 = z.infer<typeof PromptArtifactKindV1Schema>;

export const PromptArtifactRefV1Schema = z.object({
  kind: PromptArtifactKindV1Schema,
  artifactId: z.string().min(1),
}).passthrough();
export type PromptArtifactRefV1 = z.infer<typeof PromptArtifactRefV1Schema>;

export const PromptDocArtifactRefV1Schema = PromptArtifactRefV1Schema.extend({
  kind: z.literal('doc'),
});
export type PromptDocArtifactRefV1 = z.infer<typeof PromptDocArtifactRefV1Schema>;
