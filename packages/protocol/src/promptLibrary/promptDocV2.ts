import { z } from 'zod';

export const PromptDocBodyV1Schema = z
  .object({
    v: z.literal(1),
    markdown: z.string(),
    createdAtMs: z.number().int().min(0),
    updatedAtMs: z.number().int().min(0),
  })
  .strict();

export type PromptDocBodyV1 = z.infer<typeof PromptDocBodyV1Schema>;

export const PromptDocArtifactHeaderV1Schema = z
  .object({
    v: z.literal(1),
    kind: z.literal('prompt_doc.v2'),
    title: z.string().min(1),
    folderId: z.string().min(1).nullable().optional(),
    tags: z.array(z.string().min(1)).optional(),
    origin: z.enum(['built_in', 'user', 'imported']).optional(),
    locked: z.boolean().optional(),
  })
  .passthrough();

export type PromptDocArtifactHeaderV1 = z.infer<typeof PromptDocArtifactHeaderV1Schema>;
