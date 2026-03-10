import type { PromptFolderEntryV1, PromptFoldersV1 } from '@happier-dev/protocol';

import { randomUUID } from '@/platform/randomUUID';

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

export function normalizePromptFolderName(value: string): string {
  return normalizeWhitespace(value);
}

export function normalizePromptTags(value: string | readonly string[] | null | undefined): string[] {
  const rawValues = Array.isArray(value) ? value : String(value ?? '').split(',');
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of rawValues) {
    const normalized = normalizeWhitespace(String(raw ?? ''));
    if (!normalized) continue;
    const dedupeKey = normalized.toLocaleLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    tags.push(normalized);
  }
  return tags;
}

export function formatPromptTags(tags: readonly string[] | null | undefined): string {
  return (tags ?? []).join(', ');
}

export function findPromptFolderById(
  promptFolders: PromptFoldersV1 | null | undefined,
  folderId: string | null | undefined,
): PromptFolderEntryV1 | null {
  const normalizedId = String(folderId ?? '').trim();
  if (!normalizedId) return null;
  return (promptFolders?.folders ?? []).find((folder) => folder.id === normalizedId) ?? null;
}

export function findPromptFolderByName(
  promptFolders: PromptFoldersV1 | null | undefined,
  folderName: string | null | undefined,
): PromptFolderEntryV1 | null {
  const normalizedName = normalizePromptFolderName(String(folderName ?? ''));
  if (!normalizedName) return null;
  const lookupKey = normalizedName.toLocaleLowerCase();
  return (promptFolders?.folders ?? []).find((folder) => folder.name.toLocaleLowerCase() === lookupKey) ?? null;
}

export function ensurePromptFolderByName(
  promptFolders: PromptFoldersV1 | null | undefined,
  folderName: string | null | undefined,
): Readonly<{
  promptFoldersV1: PromptFoldersV1;
  folderId: string | null;
}> {
  const current = promptFolders ?? { v: 1, folders: [] };
  const normalizedName = normalizePromptFolderName(String(folderName ?? ''));
  if (!normalizedName) {
    return { promptFoldersV1: current, folderId: null };
  }

  const existing = findPromptFolderByName(current, normalizedName);
  if (existing) {
    return { promptFoldersV1: current, folderId: existing.id };
  }

  const created: PromptFolderEntryV1 = {
    id: randomUUID(),
    name: normalizedName,
    parentId: null,
  };
  return {
    promptFoldersV1: { v: 1, folders: [...current.folders, created] },
    folderId: created.id,
  };
}

export function renamePromptFolder(
  promptFolders: PromptFoldersV1 | null | undefined,
  folderId: string,
  nextName: string,
): PromptFoldersV1 {
  const current = promptFolders ?? { v: 1, folders: [] };
  const normalizedId = String(folderId ?? '').trim();
  const normalizedName = normalizePromptFolderName(nextName);
  if (!normalizedId || !normalizedName) return current;
  const duplicate = current.folders.find((folder) => (
    folder.id !== normalizedId && folder.name.toLocaleLowerCase() === normalizedName.toLocaleLowerCase()
  ));
  if (duplicate) return current;
  return {
    v: 1,
    folders: current.folders.map((folder) => (
      folder.id === normalizedId ? { ...folder, name: normalizedName } : folder
    )),
  };
}

export function removePromptFolder(
  promptFolders: PromptFoldersV1 | null | undefined,
  folderId: string,
): PromptFoldersV1 {
  const normalizedId = String(folderId ?? '').trim();
  const current = promptFolders ?? { v: 1, folders: [] };
  return {
    v: 1,
    folders: current.folders.filter((folder) => folder.id !== normalizedId),
  };
}
