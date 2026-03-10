import {
  PromptBundleBodyV1Schema,
  validatePromptBundleBodyV1AgainstSchemaId,
  type PromptBundleBodyV1,
  type PromptBundleEntryV1,
  type PromptBundleSchemaIdV1,
} from '@happier-dev/protocol';

import { encodeBase64, decodeBase64 } from '@/encryption/base64';
import { sync } from '@/sync/sync';
import { storage } from '@/sync/domains/state/storage';
import type { ArtifactHeader } from '@/sync/domains/artifacts/artifactTypes';
import { normalizePromptTags } from './promptFolders';

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

function upsertPromptBundleEntry(entries: PromptBundleEntryV1[], nextEntry: PromptBundleEntryV1): PromptBundleEntryV1[] {
  const next = entries.slice();
  const idx = next.findIndex((e) => e.path === nextEntry.path);
  if (idx >= 0) {
    next[idx] = { ...next[idx], ...nextEntry };
    return next;
  }
  return [...next, nextEntry];
}

function upsertSkillMdEntry(entries: PromptBundleEntryV1[], content: string): PromptBundleEntryV1[] {
  const encoded = encodeUtf8Base64(content);
  const entry: PromptBundleEntryV1 = { path: 'SKILL.md', contentBase64: encoded, contentKind: 'utf8' };
  const withoutSkillMd = entries.filter((item) => item.path !== 'SKILL.md');
  return [entry, ...withoutSkillMd];
}

export function listPromptBundleSupportingEntries(body: PromptBundleBodyV1): PromptBundleEntryV1[] {
  return body.entries
    .filter((entry) => entry.path !== 'SKILL.md')
    .slice()
    .sort((left, right) => left.path.localeCompare(right.path, undefined, { sensitivity: 'base' }));
}

export function readPromptBundleUtf8Entry(body: PromptBundleBodyV1, path: string): string | null {
  const entry = body.entries.find((item) => item.path === path);
  if (!entry || entry.contentKind !== 'utf8') return null;
  try {
    return decodeUtf8Base64(entry.contentBase64);
  } catch {
    return null;
  }
}

export function upsertPromptBundleUtf8Entry(entries: PromptBundleEntryV1[], params: Readonly<{ path: string; content: string }>): PromptBundleEntryV1[] {
  return upsertPromptBundleEntry(entries, {
    path: params.path,
    contentBase64: encodeUtf8Base64(params.content),
    contentKind: 'utf8',
  });
}

export function removePromptBundleEntry(entries: PromptBundleEntryV1[], path: string): PromptBundleEntryV1[] {
  return entries.filter((entry) => entry.path !== path);
}

function readPromptBundleArtifactTitle(artifact: { header?: ArtifactHeader | null; title?: string | null } | null): string {
  const headerTitle = typeof artifact?.header?.title === 'string' ? artifact.header.title : null;
  if (headerTitle && headerTitle.trim().length > 0) return headerTitle;
  const legacyTitle = typeof artifact?.title === 'string' ? artifact.title : null;
  if (legacyTitle && legacyTitle.trim().length > 0) return legacyTitle;
  return '';
}

export function readSkillMarkdownFromPromptBundleBody(body: PromptBundleBodyV1): string | null {
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
  return hasSkillPromptMarkdownContent(value) ? value : DEFAULT_SKILL_PROMPT_MARKDOWN;
}

export async function createPromptBundleArtifact(params: Readonly<{
  title: string;
  bundleSchemaId: PromptBundleSchemaIdV1;
  entries: PromptBundleEntryV1[];
  folderId?: string | null;
  tags?: readonly string[];
  origin?: 'built_in' | 'user' | 'imported';
}>): Promise<string> {
  const now = Date.now();
  const body: PromptBundleBodyV1 = {
    v: 1,
    entries: params.entries.slice(),
    createdAtMs: now,
    updatedAtMs: now,
  };

  PromptBundleBodyV1Schema.parse(body);

  const validation = validatePromptBundleBodyV1AgainstSchemaId({ bundleSchemaId: params.bundleSchemaId, body });
  if (!validation.ok) throw new Error(validation.errorCode);

  const header: ArtifactHeader = {
    v: 1,
    kind: 'prompt_bundle.v2',
    title: params.title,
    bundleSchemaId: params.bundleSchemaId,
    folderId: params.folderId ?? null,
    tags: normalizePromptTags(params.tags ?? []),
    origin: params.origin ?? 'user',
    locked: false,
  };

  return await sync.createArtifactWithHeader(header, JSON.stringify(body));
}

export async function createSkillPromptBundle(params: Readonly<{
  title: string;
  skillMarkdown: string;
  folderId?: string | null;
  tags?: readonly string[];
}>): Promise<string> {
  return await createPromptBundleArtifact({
    title: params.title,
    bundleSchemaId: 'skills.skill_md_v1',
    entries: upsertSkillMdEntry([], normalizeNewSkillPromptMarkdown(params.skillMarkdown)),
    folderId: params.folderId ?? null,
    tags: params.tags ?? [],
    origin: 'user',
  });
}

export async function updateSkillPromptBundle(params: Readonly<{
  artifactId: string;
  title: string;
  skillMarkdown: string;
  folderId?: string | null;
  tags?: readonly string[];
}>): Promise<void> {
  const artifactId = String(params.artifactId ?? '').trim();
  if (!artifactId) throw new Error('invalid_artifact_id');

  const existing = storage.getState().artifacts[artifactId] ?? null;
  const ensureBody = async (): Promise<string> => {
    if (existing?.body === undefined) {
      const full = await sync.fetchArtifactWithBody(artifactId);
      if (full) storage.getState().updateArtifact(full);
      const next = storage.getState().artifacts[artifactId] ?? null;
      if (typeof next?.body === 'string') return next.body;
      throw new Error('prompt_bundle_missing_body');
    }
    if (typeof existing?.body === 'string') return existing.body;
    throw new Error('prompt_bundle_missing_body');
  };

  const bodyRaw = await ensureBody();
  const parsed = PromptBundleBodyV1Schema.safeParse(JSON.parse(bodyRaw));
  if (!parsed.success) throw new Error('prompt_bundle_invalid_body');

  const now = Date.now();
  const nextBody: PromptBundleBodyV1 = {
    ...parsed.data,
    entries: upsertSkillMdEntry(parsed.data.entries, params.skillMarkdown),
    updatedAtMs: now,
  };
  PromptBundleBodyV1Schema.parse(nextBody);

  const validation = validatePromptBundleBodyV1AgainstSchemaId({ bundleSchemaId: 'skills.skill_md_v1', body: nextBody });
  if (!validation.ok) throw new Error(validation.errorCode);

  const baseHeader = existing?.header ?? { v: 1, kind: 'prompt_bundle.v2', title: existing?.title ?? null };
  const header: ArtifactHeader = {
    ...baseHeader,
    v: 1,
    kind: 'prompt_bundle.v2',
    title: params.title,
    bundleSchemaId: 'skills.skill_md_v1',
    folderId: params.folderId ?? null,
    tags: normalizePromptTags(params.tags ?? (Array.isArray((baseHeader as any).tags) ? (baseHeader as any).tags : [])),
  };

  await sync.updateArtifactWithHeader(artifactId, header, JSON.stringify(nextBody));
}

export async function duplicatePromptBundle(artifactId: string): Promise<string> {
  const existing = storage.getState().artifacts[artifactId] ?? null;
  const ensureBody = async (): Promise<string> => {
    if (existing?.body === undefined) {
      const full = await sync.fetchArtifactWithBody(artifactId);
      if (full) storage.getState().updateArtifact(full);
      const next = storage.getState().artifacts[artifactId] ?? null;
      if (typeof next?.body === 'string') return next.body;
      throw new Error('prompt_bundle_missing_body');
    }
    if (typeof existing?.body === 'string') return existing.body;
    throw new Error('prompt_bundle_missing_body');
  };

  const bodyRaw = await ensureBody();
  const parsed = PromptBundleBodyV1Schema.safeParse(JSON.parse(bodyRaw));
  if (!parsed.success) throw new Error('prompt_bundle_invalid_body');

  const baseTitle = typeof existing?.header?.title === 'string'
    ? existing.header.title
    : existing?.title ?? '';

  return await createPromptBundleArtifact({
    title: `${baseTitle || 'Skill'} Copy`,
    bundleSchemaId: 'skills.skill_md_v1',
    entries: parsed.data.entries,
    folderId: typeof existing?.header?.folderId === 'string' ? existing.header.folderId : null,
    tags: Array.isArray(existing?.header?.tags) ? existing.header.tags : [],
    origin: 'user',
  });
}

export async function updateSkillPromptBundleWithEntry(params: Readonly<{
  artifactId: string;
  path: string;
  content: string;
}>): Promise<void> {
  const artifactId = String(params.artifactId ?? '').trim();
  if (!artifactId) throw new Error('invalid_artifact_id');

  const existing = storage.getState().artifacts[artifactId] ?? null;
  const ensureBody = async (): Promise<string> => {
    if (existing?.body === undefined) {
      const full = await sync.fetchArtifactWithBody(artifactId);
      if (full) storage.getState().updateArtifact(full);
      const next = storage.getState().artifacts[artifactId] ?? null;
      if (typeof next?.body === 'string') return next.body;
      throw new Error('prompt_bundle_missing_body');
    }
    if (typeof existing?.body === 'string') return existing.body;
    throw new Error('prompt_bundle_missing_body');
  };

  const bodyRaw = await ensureBody();
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

  const validation = validatePromptBundleBodyV1AgainstSchemaId({ bundleSchemaId: 'skills.skill_md_v1', body: nextBody });
  if (!validation.ok) throw new Error(validation.errorCode);

  const currentArtifact = storage.getState().artifacts[artifactId] ?? existing ?? null;
  const headerTitle = readPromptBundleArtifactTitle(currentArtifact);
  const baseHeader = currentArtifact?.header ?? { v: 1, kind: 'prompt_bundle.v2', title: currentArtifact?.title ?? null };
  const header: ArtifactHeader = {
    ...baseHeader,
    v: 1,
    kind: 'prompt_bundle.v2',
    title: headerTitle,
    bundleSchemaId: 'skills.skill_md_v1',
  };

  await sync.updateArtifactWithHeader(artifactId, header, JSON.stringify(nextBody));
}

export async function removeSkillPromptBundleEntry(params: Readonly<{
  artifactId: string;
  path: string;
}>): Promise<void> {
  const artifactId = String(params.artifactId ?? '').trim();
  if (!artifactId) throw new Error('invalid_artifact_id');

  const existing = storage.getState().artifacts[artifactId] ?? null;
  const ensureBody = async (): Promise<string> => {
    if (existing?.body === undefined) {
      const full = await sync.fetchArtifactWithBody(artifactId);
      if (full) storage.getState().updateArtifact(full);
      const next = storage.getState().artifacts[artifactId] ?? null;
      if (typeof next?.body === 'string') return next.body;
      throw new Error('prompt_bundle_missing_body');
    }
    if (typeof existing?.body === 'string') return existing.body;
    throw new Error('prompt_bundle_missing_body');
  };

  const bodyRaw = await ensureBody();
  const parsed = PromptBundleBodyV1Schema.safeParse(JSON.parse(bodyRaw));
  if (!parsed.success) throw new Error('prompt_bundle_invalid_body');

  const now = Date.now();
  const nextBody: PromptBundleBodyV1 = {
    ...parsed.data,
    entries: removePromptBundleEntry(parsed.data.entries, params.path),
    updatedAtMs: now,
  };
  PromptBundleBodyV1Schema.parse(nextBody);

  const validation = validatePromptBundleBodyV1AgainstSchemaId({ bundleSchemaId: 'skills.skill_md_v1', body: nextBody });
  if (!validation.ok) throw new Error(validation.errorCode);

  const currentArtifact = storage.getState().artifacts[artifactId] ?? existing ?? null;
  const headerTitle = readPromptBundleArtifactTitle(currentArtifact);
  const baseHeader = currentArtifact?.header ?? { v: 1, kind: 'prompt_bundle.v2', title: currentArtifact?.title ?? null };
  const header: ArtifactHeader = {
    ...baseHeader,
    v: 1,
    kind: 'prompt_bundle.v2',
    title: headerTitle,
    bundleSchemaId: 'skills.skill_md_v1',
  };

  await sync.updateArtifactWithHeader(artifactId, header, JSON.stringify(nextBody));
}
