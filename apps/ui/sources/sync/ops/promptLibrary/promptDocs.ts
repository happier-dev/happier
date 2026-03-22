import {
  PromptDocBodyV1Schema,
  type PromptDocBodyV1,
} from '@happier-dev/protocol';

import { sync } from '@/sync/sync';
import { storage } from '@/sync/domains/state/storage';
import type { ArtifactHeader } from '@/sync/domains/artifacts/artifactTypes';
import { normalizePromptTags } from './promptFolders';
export {
  findPromptExternalLink,
  removePromptExternalLink,
  upsertPromptExternalLink,
} from './promptExternalLinks';

export async function createPromptDoc(params: Readonly<{
  title: string;
  markdown: string;
  folderId?: string | null;
  tags?: readonly string[];
  origin?: 'built_in' | 'user' | 'imported';
}>): Promise<string> {
  const now = Date.now();
  const body: PromptDocBodyV1 = {
    v: 1,
    markdown: params.markdown,
    createdAtMs: now,
    updatedAtMs: now,
  };

  const header: ArtifactHeader = {
    v: 1,
    kind: 'prompt_doc.v2',
    title: params.title,
    folderId: params.folderId ?? null,
    tags: normalizePromptTags(params.tags ?? []),
    origin: params.origin ?? 'user',
    locked: false,
  };

  PromptDocBodyV1Schema.parse(body);

  return await sync.createArtifactWithHeader(header, JSON.stringify(body));
}

export async function updatePromptDoc(params: Readonly<{
  artifactId: string;
  title: string;
  markdown: string;
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
      throw new Error('prompt_doc_missing_body');
    }
    if (typeof existing?.body === 'string') return existing.body;
    throw new Error('prompt_doc_missing_body');
  };

  const bodyRaw = await ensureBody();
  let bodyJson: unknown;
  try {
    bodyJson = JSON.parse(bodyRaw);
  } catch {
    throw new Error('prompt_doc_invalid_body');
  }
  const parsed = PromptDocBodyV1Schema.safeParse(bodyJson);
  if (!parsed.success) throw new Error('prompt_doc_invalid_body');

  const now = Date.now();
  const nextBody: PromptDocBodyV1 = {
    ...parsed.data,
    markdown: params.markdown,
    updatedAtMs: now,
  };
  PromptDocBodyV1Schema.parse(nextBody);

  const baseHeader = existing?.header ?? { v: 1, kind: 'prompt_doc.v2', title: existing?.title ?? null };
  const header: ArtifactHeader = {
    ...baseHeader,
    v: 1,
    kind: 'prompt_doc.v2',
    title: params.title,
    folderId: params.folderId ?? null,
    tags: normalizePromptTags(params.tags ?? (Array.isArray((baseHeader as any).tags) ? (baseHeader as any).tags : [])),
  };

  await sync.updateArtifactWithHeader(artifactId, header, JSON.stringify(nextBody));
}

export async function duplicatePromptDoc(artifactId: string): Promise<string> {
  const existing = storage.getState().artifacts[artifactId] ?? null;
  const ensureBody = async (): Promise<string> => {
    if (existing?.body === undefined) {
      const full = await sync.fetchArtifactWithBody(artifactId);
      if (full) storage.getState().updateArtifact(full);
      const next = storage.getState().artifacts[artifactId] ?? null;
      if (typeof next?.body === 'string') return next.body;
      throw new Error('prompt_doc_missing_body');
    }
    if (typeof existing?.body === 'string') return existing.body;
    throw new Error('prompt_doc_missing_body');
  };

  const bodyRaw = await ensureBody();
  const parsed = PromptDocBodyV1Schema.safeParse(JSON.parse(bodyRaw));
  if (!parsed.success) throw new Error('prompt_doc_invalid_body');

  const baseTitle = typeof existing?.header?.title === 'string'
    ? existing.header.title
    : existing?.title ?? '';

  return await createPromptDoc({
    title: `${baseTitle || 'Prompt'} Copy`,
    markdown: parsed.data.markdown,
    folderId: typeof existing?.header?.folderId === 'string' ? existing.header.folderId : null,
    tags: Array.isArray(existing?.header?.tags) ? existing.header.tags : [],
    origin: 'user',
  });
}
