import type { PromptLibraryArtifactStore } from '@happier-dev/protocol';

import { storage } from '@/sync/domains/state/storage';
import type { ArtifactHeader } from '@/sync/domains/artifacts/artifactTypes';
import { sync } from '@/sync/sync';

export const uiPromptLibraryArtifactStore: PromptLibraryArtifactStore = {
  read: async (artifactId, options) => {
    options?.signal?.throwIfAborted();
    const local = storage.getState().artifacts[artifactId] ?? null;
    if (local?.body === undefined) {
      const full = await sync.fetchArtifactWithBody(artifactId);
      if (full) storage.getState().updateArtifact(full);
    }
    options?.signal?.throwIfAborted();
    const artifact = storage.getState().artifacts[artifactId] ?? null;
    if (!artifact) return null;
    return {
      id: artifactId,
      header: artifact.header ?? null,
      body: typeof artifact.body === 'string' ? artifact.body : null,
    };
  },
  update: async ({ artifactId, header, body, signal }) => {
    signal?.throwIfAborted();
    await sync.updateArtifactWithHeader(artifactId, header as ArtifactHeader, body);
    signal?.throwIfAborted();
  },
  create: async ({ header, body, signal }) => {
    signal?.throwIfAborted();
    const artifactId = await sync.createArtifactWithHeader(header as ArtifactHeader, body);
    signal?.throwIfAborted();
    return artifactId;
  },
};
