import { PromptDocBodyV1Schema } from '@happier-dev/protocol/prompts/library/promptDocV2';
import { updatePromptDocInLibrary, createPromptDocInLibrary } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';

import { sync } from '@/sync/sync';
import { storage } from '@/sync/domains/state/storage';
import { uiPromptLibraryArtifactStore } from './promptLibraryArtifactStore';
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
  favorite?: boolean;
  signal?: AbortSignal;
}>): Promise<string> {
  const { signal, ...request } = params;
  const result = await createPromptDocInLibrary({ store: uiPromptLibraryArtifactStore, request, ...(signal ? { signal } : {}) });
  return result.artifactId;
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
  await updatePromptDocInLibrary({
    store: uiPromptLibraryArtifactStore,
    request: { ...params, artifactId },
  });
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
