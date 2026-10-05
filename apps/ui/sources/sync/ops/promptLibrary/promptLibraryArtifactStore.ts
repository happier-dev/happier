import type { PromptLibraryArtifactStore } from '@happier-dev/protocol';

import { storage } from '@/sync/domains/state/storage';
import type { ArtifactHeader } from '@/sync/domains/artifacts/artifactTypes';
import { sync } from '@/sync/sync';
import { throwIfAborted } from '@/utils/runtime/abortSignals';
import { randomUUID } from '@/platform/randomUUID';

export const uiPromptLibraryArtifactStore: PromptLibraryArtifactStore = {
  list: async (options) => {
    throwIfAborted(options?.signal);
    const state = storage.getState();
    return {
      items: Object.values(state.artifacts).map((artifact) => ({
        id: artifact.id, header: artifact.rawHeader ?? artifact.header ?? null, updatedAtMs: artifact.updatedAt,
      })),
      // The sync projection is a paginated window, even after its first load.
      coverage: 'partial',
    };
  },
  read: async (artifactId, options) => {
    throwIfAborted(options?.signal);
    const local = storage.getState().artifacts[artifactId] ?? null;
    if (local?.body === undefined || local.bodyVersion === undefined) {
      const full = await sync.fetchArtifactWithBody(artifactId);
      if (full) storage.getState().updateArtifact(full);
    }
    throwIfAborted(options?.signal);
    const artifact = storage.getState().artifacts[artifactId] ?? null;
    if (!artifact) return null;
    if (artifact.bodyVersion === undefined) throw new Error('artifact_missing_revision');
    return {
      id: artifactId,
      revision: { headerVersion: artifact.headerVersion, bodyVersion: artifact.bodyVersion },
      header: artifact.rawHeader ?? artifact.header ?? null,
      body: typeof artifact.body === 'string' ? artifact.body : null,
    };
  },
  update: async ({ artifactId, expectedRevision, header, body, signal }) => {
    throwIfAborted(signal);
    await sync.updateArtifactWithHeader(artifactId, header as ArtifactHeader, body, { expectedRevision, signal });
    throwIfAborted(signal);
  },
  create: async ({ header, body, signal }) => {
    throwIfAborted(signal);
    const artifactId = await sync.createArtifactWithHeader(header as ArtifactHeader, body);
    throwIfAborted(signal);
    return artifactId;
  },
};

/** The Action host already owns an exact Account Artifact transport and CAS. */
export function createUiPromptLibraryArtifactStore(
  artifacts: import('@happier-dev/protocol/actions').WorkflowDefinitionArtifactOperations,
): PromptLibraryArtifactStore {
  return {
    read: async (id, options) => {
      const artifact = await artifacts.read(id, options);
      return artifact ? { id: artifact.artifactId, revision: artifact.revision, header: artifact.header,
        body: typeof artifact.body === 'string' ? artifact.body : null } : null;
    },
    create: async (input) => {
      const artifactId = randomUUID();
      await artifacts.create({ ...input, artifactId });
      return artifactId;
    },
    update: async (input) => {
      const result = await artifacts.update(input);
      if (!result.ok) throw Object.assign(new Error(result.error), { code: result.errorCode });
    },
    list: async (options) => {
      const page = await artifacts.list(options ?? {});
      return { items: page.items.map((item) => ({ id: item.artifactId, header: item.header, updatedAtMs: item.updatedAt })),
        coverage: 'complete', ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
    },
  };
}
