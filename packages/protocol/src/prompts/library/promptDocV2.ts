import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';
import { HAPPIER_GUIDE_MARKDOWN, HAPPIER_GUIDE_TITLE } from './happierGuideInstructionsV1.js';
import { ArtifactOrganizationHeaderV1Schema } from '../../artifacts/artifactOrganizationV1.js';
import { ArtifactSavedByV1Schema } from '../../artifacts/artifactBinaryV1.js';
import { ArtifactRevisionV1Schema, type ArtifactRevisionV1 } from '../../artifacts/artifactRevisionV1.js';
import { PromptLibrarySaveOrganizationFieldsV1, isPromptLibrarySaveFolderAssignmentV1 } from './promptFolderActionSchemasV1.js';

/** Public operands cannot assert provenance; only this known static starter derives built_in. */
export const PromptDocCreateActionInputV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ title: z.string().check(z.minLength(1)), markdown: z.string(), ...PromptLibrarySaveOrganizationFieldsV1,
    favorite: z.optional(z.boolean()) }).check(z.refine(isPromptLibrarySaveFolderAssignmentV1, { message: 'Folder assignment must match the reviewed folder creation' })),
  z.strictObject({ starter: z.literal('happier_guide') }),
]));
export type PromptDocCreateActionInputV1 = z.infer<typeof PromptDocCreateActionInputV1Schema>;

export function resolvePromptDocCreateActionInputV1(input: PromptDocCreateActionInputV1) {
  return 'starter' in input
    ? { title: HAPPIER_GUIDE_TITLE, markdown: HAPPIER_GUIDE_MARKDOWN, origin: 'built_in' as const }
    : input;
}

export const PromptDocRevisionV1Schema = ArtifactRevisionV1Schema;
export type PromptDocRevisionV1 = ArtifactRevisionV1;

export const PromptDocReadResultV1Schema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(true), artifactId: z.string().check(z.minLength(1)), title: z.string().check(z.minLength(1)), markdown: z.string(),
  revision: PromptDocRevisionV1Schema, provenance: z.optional(z.strictObject({ savedBy: ArtifactSavedByV1Schema })),
}));

export const PromptDocBodyV1Schema = lazyZodSchema(() => z
  .object({
    v: z.literal(1),
    markdown: z.string(),
    createdAtMs: z.number().check(z.int(), z.minimum(0)),
    updatedAtMs: z.number().check(z.int(), z.minimum(0)),
  }));

export type PromptDocBodyV1 = z.infer<typeof PromptDocBodyV1Schema>;

export const PromptDocArtifactHeaderV1Schema = lazyZodSchema(() => z
  .object({
    v: z.literal(1),
    kind: z.literal('prompt_doc.v2'),
    title: z.string().check(z.minLength(1)),
    ...ArtifactOrganizationHeaderV1Schema.shape,
    origin: z.optional(z.enum(['built_in', 'user', 'imported'])),
    locked: z.optional(z.boolean()),
    favorite: z.optional(z.boolean()),
  }));

export type PromptDocArtifactHeaderV1 = z.infer<typeof PromptDocArtifactHeaderV1Schema>;
