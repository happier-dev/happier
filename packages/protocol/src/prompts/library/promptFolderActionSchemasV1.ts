import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { ArtifactRevisionV1Schema } from '../../artifacts/artifactActionsV1.js';

const revision = lazyZodSchema(() => z.union([z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), z.literal('absent')]));
const id = lazyZodSchema(() => z.string().min(1));
export const ARTIFACT_FOLDER_ACTION_INPUT_SCHEMAS_V1 = {
  'artifact.folders.create': lazyZodSchema(() => z.object({ id, name: id, parentId: id.nullable().optional(), expectedRevision: revision }).strict()),
  'artifact.folders.rename': lazyZodSchema(() => z.object({ folderId: id, name: id, expectedRevision: revision }).strict()),
  'artifact.folders.move': lazyZodSchema(() => z.object({ folderId: id, parentId: id.nullable(), expectedRevision: revision }).strict()),
  'artifact.folders.delete': lazyZodSchema(() => z.object({ folderId: id, expectedRevision: revision }).strict()),
  'artifact.folder.set': lazyZodSchema(() => z.object({ artifactId: id, folderId: id.nullable().optional(), tags: z.array(id).optional(),
    expectedRevision: revision }).strict().refine(value => value.folderId !== undefined || value.tags !== undefined, { message: 'Organization change required' })),
} as const;
export const ArtifactFolderMutationResultV1Schema = lazyZodSchema(() => z.union([
  z.object({ status: z.literal('updated'), revision: z.number().int().nonnegative() }).strict(),
  z.object({ status: z.literal('conflict'), revision: z.number().int().min(-1) }).strict(),
  z.object({ status: z.literal('unavailable'), reason: z.string().min(1) }).strict(),
]));
export type ArtifactFolderMutationResultV1 = z.infer<typeof ArtifactFolderMutationResultV1Schema>;
export const ArtifactOrganizationMutationFailureDetailsV1Schema = lazyZodSchema(() => z.object({
  artifactId: id,
  contentRevision: ArtifactRevisionV1Schema.optional(),
  organization: z.union([
    z.object({ status: z.literal('conflict'), revision: z.number().int().min(-1) }).strict(),
    z.object({ status: z.literal('unavailable'), reason: z.string().min(1) }).strict(),
  ]),
}).strict());
export type ArtifactOrganizationMutationFailureDetailsV1 = z.infer<typeof ArtifactOrganizationMutationFailureDetailsV1Schema>;
export const ARTIFACT_FOLDER_ACTION_OUTPUT_SCHEMAS_V1 = {
  'artifact.folders.create': ArtifactFolderMutationResultV1Schema,
  'artifact.folders.rename': ArtifactFolderMutationResultV1Schema,
  'artifact.folders.move': ArtifactFolderMutationResultV1Schema,
  'artifact.folders.delete': ArtifactFolderMutationResultV1Schema,
  'artifact.folder.set': ArtifactFolderMutationResultV1Schema,
} as const;
