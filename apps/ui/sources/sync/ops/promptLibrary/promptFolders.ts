import type { PromptFolderEntryV1, PromptFoldersV1 } from '@happier-dev/protocol';
import { normalizeArtifactTagsV1 } from '@happier-dev/protocol/artifacts/artifactOrganizationV1';
import { createPromptFolderV1,
  normalizePromptFolderNameV1, findPromptFolderByNameV1 } from '@happier-dev/protocol/prompts/library/promptFoldersV1';

import { randomUUID } from '@/platform/randomUUID';

export const normalizePromptFolderName = normalizePromptFolderNameV1;

export function normalizePromptTags(value: string | readonly string[] | null | undefined): string[] {
  return normalizeArtifactTagsV1(typeof value === 'string' ? value.split(',') : value);
}

export function formatPromptTags(tags: readonly string[] | null | undefined): string {
  return (tags ?? []).join(', ');
}

export function findPromptFolderById(
  promptFolders: PromptFoldersV1 | null | undefined,
  folderId: string | null | undefined,
): PromptFolderEntryV1 | null {
  if (!folderId) return null;
  return (promptFolders?.folders ?? []).find((folder) => folder.id === folderId) ?? null;
}

export function findPromptFolderByName(
  promptFolders: PromptFoldersV1 | null | undefined,
  folderName: string | null | undefined,
): PromptFolderEntryV1 | null {
  return findPromptFolderByNameV1(promptFolders, String(folderName ?? ''));
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
    promptFoldersV1: createPromptFolderV1(current, created),
    folderId: created.id,
  };
}
