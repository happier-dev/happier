import {
  PromptBundleBodyV1Schema,
  PromptBundleSchemaIdV1Schema,
  validatePromptBundleBodyV1AgainstSchemaId,
  type PromptBundleBodyV1,
  type PromptBundleEntryV1,
  type PromptBundleSchemaIdV1,
} from '@happier-dev/protocol/prompts/library/promptBundleSchemas';
import {
  updatePromptBundleInLibrary,
  createPromptBundleInLibrary,
  type PromptLibraryArtifactStore,
  type PromptLibraryStoredArtifact,
} from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import { readArtifactOrganizationV1 } from '@happier-dev/protocol/prompts/library/promptFolderActionsV1';

import { encodeBase64, decodeBase64 } from '@/encryption/base64';
import type { ArtifactHeader } from '@/sync/domains/artifacts/artifactTypes';
import { withUiPromptLibraryArtifactStore } from './promptLibraryArtifactStore';

export const DEFAULT_SKILL_PROMPT_MARKDOWN = `---
name: skill
description: Describe when this skill should be used.
---

## When to use
- Explain the situations where this skill applies.

## Instructions
1. Add the exact steps this skill should follow.
`;

function encodeUtf8Base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  return encodeBase64(bytes, 'base64');
}

function decodeUtf8Base64(value: string): string {
  const bytes = decodeBase64(value);
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function upsertPromptBundleEntry(
  entries: PromptBundleEntryV1[],
  nextEntry: PromptBundleEntryV1,
): PromptBundleEntryV1[] {
  const next = entries.slice();
  const idx = next.findIndex((e) => e.path === nextEntry.path);
  if (idx >= 0) {
    next[idx] = { ...next[idx], ...nextEntry };
    return next;
  }
  return [...next, nextEntry];
}

function upsertSkillMdEntry(
  entries: PromptBundleEntryV1[],
  content: string,
): PromptBundleEntryV1[] {
  const encoded = encodeUtf8Base64(content);
  const entry: PromptBundleEntryV1 = {
    path: 'SKILL.md',
    contentBase64: encoded,
    contentKind: 'utf8',
  };
  const withoutSkillMd = entries.filter((item) => item.path !== 'SKILL.md');
  return [entry, ...withoutSkillMd];
}

export function listPromptBundleSupportingEntries(
  body: PromptBundleBodyV1,
): PromptBundleEntryV1[] {
  return body.entries
    .filter((entry) => entry.path !== 'SKILL.md')
    .slice()
    .sort((left, right) =>
      left.path.localeCompare(right.path, undefined, { sensitivity: 'base' }),
    );
}

export function readPromptBundleUtf8Entry(
  body: PromptBundleBodyV1,
  path: string,
): string | null {
  const entry = body.entries.find((item) => item.path === path);
  if (!entry || entry.contentKind !== 'utf8') return null;
  try {
    return decodeUtf8Base64(entry.contentBase64);
  } catch {
    return null;
  }
}

export function upsertPromptBundleUtf8Entry(
  entries: PromptBundleEntryV1[],
  params: Readonly<{ path: string; content: string }>,
): PromptBundleEntryV1[] {
  return upsertPromptBundleEntry(entries, {
    path: params.path,
    contentBase64: encodeUtf8Base64(params.content),
    contentKind: 'utf8',
  });
}

export function removePromptBundleEntry(
  entries: PromptBundleEntryV1[],
  path: string,
): PromptBundleEntryV1[] {
  return entries.filter((entry) => entry.path !== path);
}

function readPromptBundleArtifactTitle(
  artifact: { header?: Readonly<Record<string, unknown>> | null } | null,
): string {
  const headerTitle =
    typeof artifact?.header?.title === 'string' ? artifact.header.title : null;
  if (headerTitle && headerTitle.trim().length > 0) return headerTitle;
  return '';
}

export function readSkillMarkdownFromPromptBundleBody(
  body: PromptBundleBodyV1,
): string | null {
  const entry = body.entries.find((e) => e.path === 'SKILL.md');
  if (!entry) return null;
  if (entry.contentKind !== 'utf8') return null;
  try {
    return decodeUtf8Base64(entry.contentBase64);
  } catch {
    return null;
  }
}

export function hasSkillPromptMarkdownContent(value: string): boolean {
  return value.trim().length > 0;
}

function normalizeNewSkillPromptMarkdown(value: string): string {
  return hasSkillPromptMarkdownContent(value)
    ? value
    : DEFAULT_SKILL_PROMPT_MARKDOWN;
}

export async function createPromptBundleArtifact(
  params: Readonly<{
    title: string;
    bundleSchemaId: PromptBundleSchemaIdV1;
    entries: PromptBundleEntryV1[];
    folderId?: string | null;
    tags?: readonly string[];
    origin?: 'built_in' | 'user' | 'imported';
  }>,
  store?: PromptLibraryArtifactStore,
): Promise<string> {
  const create = async (current: PromptLibraryArtifactStore) => {
    const result = await createPromptBundleInLibrary({ store: current, request: params });
    return result.artifactId;
  };
  return store ? create(store) : withUiPromptLibraryArtifactStore(create);
}

export async function createSkillPromptBundle(
  params: Readonly<{
    title: string;
    skillMarkdown: string;
    folderId?: string | null;
    tags?: readonly string[];
  }>,
  store?: PromptLibraryArtifactStore,
): Promise<string> {
  return await createPromptBundleArtifact({
    title: params.title,
    bundleSchemaId: 'skills.skill_md_v1',
    entries: upsertSkillMdEntry(
      [],
      normalizeNewSkillPromptMarkdown(params.skillMarkdown),
    ),
    folderId: params.folderId ?? null,
    tags: params.tags ?? [],
    origin: 'user',
  }, store);
}

export async function updateSkillPromptBundle(
  params: Readonly<{
    artifactId: string;
    title: string;
    skillMarkdown: string;
    expectedRevision?: PromptLibraryStoredArtifact['revision'];
    folderId?: string | null;
    tags?: readonly string[];
  }>,
  store?: PromptLibraryArtifactStore,
): Promise<PromptLibraryStoredArtifact['revision']> {
  const artifactId = String(params.artifactId ?? '').trim();
  if (!artifactId) throw new Error('invalid_artifact_id');
  const update = (current: PromptLibraryArtifactStore) =>
    updatePromptBundleInLibrary({
      store: current,
      request: { ...params, artifactId },
    });
  const accepted = await (store ? update(store) : withUiPromptLibraryArtifactStore(update));
  if (!accepted.revision) throw new Error('prompt_bundle_update_receipt_unavailable');
  return accepted.revision;
}

export async function duplicatePromptBundle(
  artifactId: string,
  options?: Readonly<{ serverId?: string | null; signal?: AbortSignal }>,
): Promise<string> {
  return withUiPromptLibraryArtifactStore(async (store) => {
    const existing = await store.read(artifactId, { signal: options?.signal });
    if (existing?.header?.kind !== 'prompt_bundle.v2')
      throw new Error('prompt_bundle_invalid_kind');
    if (typeof existing.body !== 'string')
      throw new Error('prompt_bundle_missing_body');
    const bodyRaw = existing.body;
    const parsed = PromptBundleBodyV1Schema.safeParse(JSON.parse(bodyRaw));
    if (!parsed.success) throw new Error('prompt_bundle_invalid_body');

    const baseTitle =
      typeof existing?.header?.title === 'string' ? existing.header.title : '';
    if (!store.organization) throw Object.assign(new Error('artifact_organization_unavailable'), { code: 'artifact_organization_unavailable' });
    const organization = await readArtifactOrganizationV1({ port: store.organization, artifactId, signal: options?.signal });
    if (organization.status !== 'ready') throw Object.assign(new Error(organization.reason), { code: organization.reason });

    return await createPromptBundleArtifact(
      {
        title: `${baseTitle || 'Skill'} Copy`,
        bundleSchemaId: PromptBundleSchemaIdV1Schema.parse(existing.header.bundleSchemaId),
        entries: parsed.data.entries,
        folderId: organization.header.folderId ?? null,
        tags: organization.header.tags ?? [],
        origin: 'user',
      },
      store,
    );
  }, options);
}

export async function updateSkillPromptBundleWithEntry(
  params: Readonly<{
    artifactId: string;
    path: string;
    content: string;
    expectedRevision?: PromptLibraryStoredArtifact['revision'];
  }>,
  currentStore?: PromptLibraryArtifactStore,
): Promise<PromptLibraryStoredArtifact['revision']> {
  const artifactId = String(params.artifactId ?? '').trim();
  if (!artifactId) throw new Error('invalid_artifact_id');

  const update = async (store: PromptLibraryArtifactStore) => {
    const artifact = await store.read(artifactId);
    if (artifact?.header?.kind !== 'prompt_bundle.v2')
      throw new Error('prompt_bundle_invalid_kind');
    if (typeof artifact?.body !== 'string')
      throw new Error('prompt_bundle_missing_body');
    const bodyRaw = artifact.body;
    const parsed = PromptBundleBodyV1Schema.safeParse(JSON.parse(bodyRaw));
    if (!parsed.success) throw new Error('prompt_bundle_invalid_body');

    const now = Date.now();
    const nextBody: PromptBundleBodyV1 = {
      ...parsed.data,
      entries: upsertPromptBundleUtf8Entry(parsed.data.entries, {
        path: params.path,
        content: params.content,
      }),
      updatedAtMs: now,
    };
    PromptBundleBodyV1Schema.parse(nextBody);

    const validation = validatePromptBundleBodyV1AgainstSchemaId({
      bundleSchemaId: 'skills.skill_md_v1',
      body: nextBody,
    });
    if (!validation.ok) throw new Error(validation.errorCode);

    const headerTitle = readPromptBundleArtifactTitle({
      header: artifact.header,
    });
    const baseHeader = artifact.header;
    const header: ArtifactHeader = {
      ...baseHeader,
      v: 1,
      kind: 'prompt_bundle.v2',
      title: headerTitle,
      bundleSchemaId: 'skills.skill_md_v1',
    };

    const receipt = await store.update({
      artifactId,
      expectedRevision: params.expectedRevision ?? artifact.revision,
      header,
      body: JSON.stringify(nextBody),
    });
    if (!receipt) throw new Error('prompt_bundle_update_receipt_unavailable');
    return receipt.revision;
  };
  return currentStore ? update(currentStore) : withUiPromptLibraryArtifactStore(update);
}

export async function removeSkillPromptBundleEntry(
  params: Readonly<{
    artifactId: string;
    path: string;
    expectedRevision?: PromptLibraryStoredArtifact['revision'];
  }>,
  currentStore?: PromptLibraryArtifactStore,
): Promise<PromptLibraryStoredArtifact['revision']> {
  const artifactId = String(params.artifactId ?? '').trim();
  if (!artifactId) throw new Error('invalid_artifact_id');

  const remove = async (store: PromptLibraryArtifactStore) => {
    const artifact = await store.read(artifactId);
    if (artifact?.header?.kind !== 'prompt_bundle.v2')
      throw new Error('prompt_bundle_invalid_kind');
    if (typeof artifact?.body !== 'string')
      throw new Error('prompt_bundle_missing_body');
    const bodyRaw = artifact.body;
    const parsed = PromptBundleBodyV1Schema.safeParse(JSON.parse(bodyRaw));
    if (!parsed.success) throw new Error('prompt_bundle_invalid_body');

    const now = Date.now();
    const nextBody: PromptBundleBodyV1 = {
      ...parsed.data,
      entries: removePromptBundleEntry(parsed.data.entries, params.path),
      updatedAtMs: now,
    };
    PromptBundleBodyV1Schema.parse(nextBody);

    const validation = validatePromptBundleBodyV1AgainstSchemaId({
      bundleSchemaId: 'skills.skill_md_v1',
      body: nextBody,
    });
    if (!validation.ok) throw new Error(validation.errorCode);

    const headerTitle = readPromptBundleArtifactTitle({
      header: artifact.header,
    });
    const baseHeader = artifact.header;
    const header: ArtifactHeader = {
      ...baseHeader,
      v: 1,
      kind: 'prompt_bundle.v2',
      title: headerTitle,
      bundleSchemaId: 'skills.skill_md_v1',
    };

    const receipt = await store.update({
      artifactId,
      expectedRevision: params.expectedRevision ?? artifact.revision,
      header,
      body: JSON.stringify(nextBody),
    });
    if (!receipt) throw new Error('prompt_bundle_update_receipt_unavailable');
    return receipt.revision;
  };
  return currentStore ? remove(currentStore) : withUiPromptLibraryArtifactStore(remove);
}
