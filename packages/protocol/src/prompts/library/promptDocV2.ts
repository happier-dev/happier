import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';
import { ArtifactOrganizationHeaderV1Schema } from '../../artifacts/artifactOrganizationV1.js';
import { ArtifactRevisionV1Schema, type ArtifactRevisionV1 } from '../../artifacts/artifactActionsV1.js';

export const PromptDocRevisionV1Schema = ArtifactRevisionV1Schema;
export type PromptDocRevisionV1 = ArtifactRevisionV1;

export const PromptDocBodyV1Schema = lazyZodSchema(() => z
  .object({
    v: z.literal(1),
    markdown: z.string(),
    createdAtMs: z.number().int().min(0),
    updatedAtMs: z.number().int().min(0),
  })
  .strip());

export type PromptDocBodyV1 = z.infer<typeof PromptDocBodyV1Schema>;

export const PromptDocArtifactHeaderV1Schema = lazyZodSchema(() => z
  .object({
    v: z.literal(1),
    kind: z.literal('prompt_doc.v2'),
    title: z.string().min(1),
    ...ArtifactOrganizationHeaderV1Schema.shape,
    origin: z.enum(['built_in', 'user', 'imported']).optional(),
    locked: z.boolean().optional(),
    favorite: z.boolean().optional(),
  })
  .strip());

export type PromptDocArtifactHeaderV1 = z.infer<typeof PromptDocArtifactHeaderV1Schema>;
