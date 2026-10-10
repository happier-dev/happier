import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { ArtifactRevisionV1Schema } from '../../artifacts/artifactRevisionV1.js';
import { PromptFolderEntryV1Schema } from './promptFoldersV1.js';

const revision = lazyZodSchema(() => z.union([z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), z.literal('absent')]));
const id = lazyZodSchema(() => z.string().min(1));
export const ARTIFACT_FOLDER_ACTION_INPUT_SCHEMAS_V1 = {
  'artifact.folders.list': lazyZodSchema(() => z.object({}).strict()),
  'artifact.folders.read': lazyZodSchema(() => z.object({ folderId: id }).strict()),
  'artifact.folders.create': lazyZodSchema(() => z.object({ id, name: id, parentId: id.nullable().optional(), expectedRevision: revision }).strict()),
  'artifact.folders.rename': lazyZodSchema(() => z.object({ folderId: id, name: id, expectedRevision: revision }).strict()),
  'artifact.folders.move': lazyZodSchema(() => z.object({ folderId: id, parentId: id.nullable(), expectedRevision: revision }).strict()),
  'artifact.folders.delete': lazyZodSchema(() => z.object({ folderId: id, expectedRevision: revision }).strict()),
  'artifact.folder.set': lazyZodSchema(() => z.object({ artifactId: id, folderId: id.nullable().optional(), tags: z.array(id).optional(),
    expectedRevision: revision }).strict().refine(value => value.folderId !== undefined || value.tags !== undefined, { message: 'Organization change required' })),
} as const;
const unavailable = lazyZodSchema(() => z.object({ status: z.literal('unavailable'), reason: z.string().min(1) }).strict());
export const ArtifactFolderRowV1Schema = lazyZodSchema(() => PromptFolderEntryV1Schema.extend({ parentId: id.nullable() }).strict());
export const ArtifactFolderListResultV1Schema = lazyZodSchema(() => z.union([
  z.object({ status: z.literal('ready'), items: z.array(ArtifactFolderRowV1Schema), revision,
    coverage: z.literal('complete'), nextCursor: z.null() }).strict(),
  unavailable,
]));
export type ArtifactFolderListResultV1 = z.infer<typeof ArtifactFolderListResultV1Schema>;
export const ArtifactFolderReadResultV1Schema = lazyZodSchema(() => z.union([
  z.object({ status: z.literal('ready'), item: ArtifactFolderRowV1Schema, revision, coverage: z.literal('complete') }).strict(),
  z.object({ status: z.literal('not_found'), revision, coverage: z.literal('complete') }).strict(),
  unavailable,
]));
export type ArtifactFolderReadResultV1 = z.infer<typeof ArtifactFolderReadResultV1Schema>;
export const ArtifactFolderMutationResultV1Schema = lazyZodSchema(() => z.union([
  z.object({ status: z.literal('updated'), revision: z.number().int().nonnegative() }).strict(),
  z.object({ status: z.literal('conflict'), revision: z.number().int().min(-1) }).strict(),
  unavailable,
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
  'artifact.folders.list': ArtifactFolderListResultV1Schema,
  'artifact.folders.read': ArtifactFolderReadResultV1Schema,
  'artifact.folders.create': ArtifactFolderMutationResultV1Schema,
  'artifact.folders.rename': ArtifactFolderMutationResultV1Schema,
  'artifact.folders.move': ArtifactFolderMutationResultV1Schema,
  'artifact.folders.delete': ArtifactFolderMutationResultV1Schema,
  'artifact.folder.set': ArtifactFolderMutationResultV1Schema,
} as const;
