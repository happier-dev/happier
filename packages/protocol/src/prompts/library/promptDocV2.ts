import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';
import { HAPPIER_GUIDE_MARKDOWN, HAPPIER_GUIDE_TITLE } from './happierGuideInstructionsV1.js';
import { ArtifactOrganizationHeaderV1Schema } from '../../artifacts/artifactOrganizationV1.js';
import { ArtifactRevisionV1Schema, type ArtifactRevisionV1 } from '../../artifacts/artifactRevisionV1.js';

/** Public operands cannot assert provenance; only this known static starter derives built_in. */
export const PromptDocCreateActionInputV1Schema = lazyZodSchema(() => z.union([
  z.object({ title: z.string().min(1), markdown: z.string(), folderId: z.string().nullable().optional(),
    tags: z.array(z.string()).optional(), favorite: z.boolean().optional() }).strict(),
  z.object({ starter: z.literal('happier_guide') }).strict(),
]));
export type PromptDocCreateActionInputV1 = z.infer<typeof PromptDocCreateActionInputV1Schema>;

export function resolvePromptDocCreateActionInputV1(input: PromptDocCreateActionInputV1) {
  return 'starter' in input
    ? { title: HAPPIER_GUIDE_TITLE, markdown: HAPPIER_GUIDE_MARKDOWN, origin: 'built_in' as const }
    : input;
}

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
