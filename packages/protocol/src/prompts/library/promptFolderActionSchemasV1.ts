import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { ArtifactRevisionV1Schema } from '../../artifacts/artifactRevisionV1.js';
import { PromptFolderEntryV1Schema } from './promptFoldersV1.js';

const revision = lazyZodSchema(() => z.union([z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)), z.literal('absent')]));
const id = lazyZodSchema(() => z.string().check(z.minLength(1)));
export const ARTIFACT_FOLDER_ACTION_INPUT_SCHEMAS_V1 = {
  'artifact.folders.list': lazyZodSchema(() => z.strictObject({})),
  'artifact.folders.read': lazyZodSchema(() => z.strictObject({ folderId: id })),
  'artifact.folders.create': lazyZodSchema(() => z.strictObject({ id, name: id, parentId: z.optional(z.nullable(id)), expectedRevision: revision })),
  'artifact.folders.rename': lazyZodSchema(() => z.strictObject({ folderId: id, name: id, expectedRevision: revision })),
  'artifact.folders.move': lazyZodSchema(() => z.strictObject({ folderId: id, parentId: z.nullable(id), expectedRevision: revision })),
  'artifact.folders.delete': lazyZodSchema(() => z.strictObject({ folderId: id, expectedRevision: revision })),
  'artifact.folder.set': lazyZodSchema(() => z.strictObject({ artifactId: id, folderId: z.optional(z.nullable(id)), tags: z.optional(z.array(id)),
    expectedRevision: revision }).check(z.refine(value => value.folderId !== undefined || value.tags !== undefined, { message: 'Organization change required' }))),
} as const;
export type ArtifactFolderCreateActionInputV1 = z.infer<typeof ARTIFACT_FOLDER_ACTION_INPUT_SCHEMAS_V1['artifact.folders.create']>;

/** A Save reviews the exact folder effect together with its content assignment. */
export const PromptLibrarySaveOrganizationFieldsV1 = {
  folderId: lazyZodSchema(() => z.optional(z.nullable(z.string()))),
  tags: lazyZodSchema(() => z.optional(z.array(z.string()))),
  createFolder: z.optional(ARTIFACT_FOLDER_ACTION_INPUT_SCHEMAS_V1['artifact.folders.create']),
} as const;
export function isPromptLibrarySaveFolderAssignmentV1(input: Readonly<{
  folderId?: string | null; createFolder?: ArtifactFolderCreateActionInputV1;
}>): boolean {
  return input.createFolder === undefined || input.folderId === input.createFolder.id;
}
const unavailable = lazyZodSchema(() => z.strictObject({ status: z.literal('unavailable'), reason: z.string().check(z.minLength(1)) }));
export const ArtifactFolderRowV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(PromptFolderEntryV1Schema, { parentId: z.nullable(id) })));
export const ArtifactFolderListResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.literal('ready'), items: z.array(ArtifactFolderRowV1Schema), revision,
    coverage: z.literal('complete'), nextCursor: z.null() }),
  unavailable,
]));
export type ArtifactFolderListResultV1 = z.infer<typeof ArtifactFolderListResultV1Schema>;
export const ArtifactFolderReadResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.literal('ready'), item: ArtifactFolderRowV1Schema, revision, coverage: z.literal('complete') }),
  z.strictObject({ status: z.literal('not_found'), revision, coverage: z.literal('complete') }),
  unavailable,
]));
export type ArtifactFolderReadResultV1 = z.infer<typeof ArtifactFolderReadResultV1Schema>;
export const ArtifactFolderMutationResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.literal('updated'), revision: z.number().check(z.int(), z.nonnegative()) }),
  z.strictObject({ status: z.literal('conflict'), revision: z.number().check(z.int(), z.minimum(-1)) }),
  unavailable,
]));
export type ArtifactFolderMutationResultV1 = z.infer<typeof ArtifactFolderMutationResultV1Schema>;
export const ArtifactOrganizationMutationFailureDetailsV1Schema = lazyZodSchema(() => z.strictObject({
  artifactId: id,
  contentRevision: z.optional(ArtifactRevisionV1Schema),
  organization: z.union([
    z.strictObject({ status: z.literal('conflict'), revision: z.number().check(z.int(), z.minimum(-1)) }),
    z.strictObject({ status: z.literal('unavailable'), reason: z.string().check(z.minLength(1)) }),
  ]),
}));
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
