import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';
import { ArtifactOrganizationHeaderV1Schema, normalizeArtifactTagsV1 } from '../../artifacts/artifactOrganizationV1.js';
import { createStoredReadSchema, defineStoredReadProjection } from '../../json/storedReadSchema.js';

export const PromptFolderEntryV1Schema = lazyZodSchema(() => z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  parentId: z.string().min(1).nullable().optional(),
}).passthrough());
export type PromptFolderEntryV1 = z.infer<typeof PromptFolderEntryV1Schema>;

export const PromptFoldersV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  folders: z.array(PromptFolderEntryV1Schema).default([]),
  artifactHeadersById: z.record(z.string().min(1), ArtifactOrganizationHeaderV1Schema).optional(),
}).passthrough());
export type PromptFoldersV1 = z.infer<typeof PromptFoldersV1Schema>;
export const StoredPromptFoldersV1Schema = createStoredReadSchema(PromptFoldersV1Schema);

/** Catalog transfer preserves predecessor topology; it does not author or repair a tree. */
export const PromptFoldersV1RecordSchema = defineStoredReadProjection(lazyZodSchema(() => z.object({
  v: z.literal(1),
  folders: z.array(PromptFolderEntryV1Schema.strict()),
  artifactHeadersById: z.record(z.string().min(1), ArtifactOrganizationHeaderV1Schema).optional(),
}).strict()), () => StoredPromptFoldersV1Schema);

/** New folder mutations require a valid tree, independently of retained storage admission. */
export const PromptFoldersV1WriteSchema = defineStoredReadProjection(lazyZodSchema(() => PromptFoldersV1RecordSchema.superRefine((value, context) => {
  const byId = new Map(value.folders.map(folder => [folder.id, folder]));
  if (byId.size !== value.folders.length) {
    context.addIssue({ code: 'custom', path: ['folders'], message: 'folder_already_exists' });
  }
  for (const [index, folder] of value.folders.entries()) {
    if (folder.parentId && !byId.has(folder.parentId)) {
      context.addIssue({ code: 'custom', path: ['folders', index, 'parentId'], message: 'folder_parent_not_found' });
    }
  }
  const visited = new Set<string>();
  for (const folder of value.folders) {
    const chain = new Set<string>();
    let current: PromptFolderEntryV1 | undefined = folder;
    while (current && !visited.has(current.id)) {
      if (chain.has(current.id)) {
        context.addIssue({ code: 'custom', path: ['folders'], message: 'folder_cycle' });
        break;
      }
      chain.add(current.id);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    for (const id of chain) visited.add(id);
  }
  for (const [artifactId, header] of Object.entries(value.artifactHeadersById ?? {})) {
    if (header.folderId && !byId.has(header.folderId)) {
      context.addIssue({ code: 'custom', path: ['artifactHeadersById', artifactId, 'folderId'], message: 'folder_not_found' });
    }
  }
})), () => StoredPromptFoldersV1Schema);

export function normalizePromptFolderNameV1(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

export function findPromptFolderByNameV1(current: PromptFoldersV1 | null | undefined, name: string): PromptFolderEntryV1 | null {
  const key = normalizePromptFolderNameV1(name).toLocaleLowerCase();
  return key ? current?.folders.find(folder => normalizePromptFolderNameV1(folder.name).toLocaleLowerCase() === key) ?? null : null;
}

function folderFailure(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function currentFolders(current: PromptFoldersV1 | null | undefined): PromptFoldersV1 {
  return StoredPromptFoldersV1Schema.parse(current ?? { v: 1, folders: [] });
}

function writeFolders(next: PromptFoldersV1): PromptFoldersV1 {
  const result = PromptFoldersV1WriteSchema.safeParse(next);
  if (!result.success) throw folderFailure(result.error.issues.find(issue => issue.code === 'custom')?.message ?? 'invalid_folder_data');
  return result.data;
}

function requireFolder(current: PromptFoldersV1, folderId: string): PromptFolderEntryV1 {
  const folder = current.folders.find(entry => entry.id === folderId);
  if (!folder) throw folderFailure('folder_not_found');
  return folder;
}

export function createPromptFolderV1(current: PromptFoldersV1 | null | undefined,
  input: Readonly<{ id: string; name: string; parentId?: string | null }>): PromptFoldersV1 {
  const value = currentFolders(current);
  const name = normalizePromptFolderNameV1(input.name);
  if (!name) throw folderFailure('invalid_folder_name');
  if (value.folders.some(folder => folder.id === input.id)) throw folderFailure('folder_already_exists');
  if (findPromptFolderByNameV1(value, name)) throw folderFailure('duplicate_folder_name');
  if (input.parentId && !value.folders.some(folder => folder.id === input.parentId)) throw folderFailure('folder_parent_not_found');
  return writeFolders({ ...value, folders: [...value.folders, { id: input.id, name, parentId: input.parentId ?? null }] });
}

export function renamePromptFolderV1(current: PromptFoldersV1 | null | undefined,
  input: Readonly<{ folderId: string; name: string }>): PromptFoldersV1 {
  const value = currentFolders(current);
  requireFolder(value, input.folderId);
  const name = normalizePromptFolderNameV1(input.name);
  if (!name) throw folderFailure('invalid_folder_name');
  const duplicate = findPromptFolderByNameV1(value, name);
  if (duplicate && duplicate.id !== input.folderId) throw folderFailure('duplicate_folder_name');
  return writeFolders({ ...value, folders: value.folders.map(folder => folder.id === input.folderId ? { ...folder, name } : folder) });
}

export function movePromptFolderV1(current: PromptFoldersV1 | null | undefined,
  input: Readonly<{ folderId: string; parentId: string | null }>): PromptFoldersV1 {
  const value = currentFolders(current);
  requireFolder(value, input.folderId);
  if (input.parentId !== null && !value.folders.some(folder => folder.id === input.parentId)) throw folderFailure('folder_parent_not_found');
  return writeFolders({ ...value, folders: value.folders.map(folder => folder.id === input.folderId ? { ...folder, parentId: input.parentId } : folder) });
}

export function removePromptFolderV1(current: PromptFoldersV1 | null | undefined,
  input: Readonly<{ folderId: string; artifactIds?: readonly string[] }>): PromptFoldersV1 {
  const value = currentFolders(current);
  const removed = requireFolder(value, input.folderId);
  const artifactHeadersById = { ...value.artifactHeadersById };
  for (const [artifactId, header] of Object.entries(artifactHeadersById)) {
    if (header.folderId === removed.id) artifactHeadersById[artifactId] = { ...header, folderId: null };
  }
  for (const artifactId of input.artifactIds ?? []) {
    if (!artifactId) throw folderFailure('invalid_artifact_id');
    const previous = Object.hasOwn(artifactHeadersById, artifactId) ? artifactHeadersById[artifactId] : {};
    artifactHeadersById[artifactId] = { ...previous, folderId: null };
  }
  return writeFolders({ ...value,
    folders: value.folders.filter(folder => folder.id !== removed.id).map(folder => folder.parentId === removed.id
      ? { ...folder, parentId: removed.parentId ?? null } : folder),
    ...(value.artifactHeadersById || Object.keys(artifactHeadersById).length ? { artifactHeadersById } : {}),
  });
}

export function placeArtifactInPromptFolderV1(current: PromptFoldersV1 | null | undefined,
  input: Readonly<{ artifactId: string; folderId: string | null; tags?: readonly string[] }>): PromptFoldersV1 {
  const value = currentFolders(current);
  if (!input.artifactId) throw folderFailure('invalid_artifact_id');
  if (input.folderId !== null) requireFolder(value, input.folderId);
  const previous = value.artifactHeadersById && Object.hasOwn(value.artifactHeadersById, input.artifactId)
    ? value.artifactHeadersById[input.artifactId] : {};
  return writeFolders({ ...value, artifactHeadersById: { ...value.artifactHeadersById, [input.artifactId]: {
    ...previous, folderId: input.folderId,
    ...(input.tags === undefined ? {} : { tags: normalizeArtifactTagsV1(input.tags) }),
  } } });
}
