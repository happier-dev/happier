import type { DecryptedArtifact } from '../../domains/artifacts/artifactTypes';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { StoreGet, StoreSet } from './_shared';

function retainOpenedContent(previous: DecryptedArtifact | undefined, incoming: DecryptedArtifact): DecryptedArtifact {
  if (!previous?.isDecrypted || !incoming.isDecrypted || incoming.body !== undefined || previous.body === undefined
    || incoming.bodyVersion === undefined || incoming.bodyVersion !== previous.bodyVersion
    || incoming.headerVersion !== previous.headerVersion || incoming.storageMode !== previous.storageMode
    || incoming.access === undefined || incoming.access !== previous.access
    || !incoming.ownerAccountId || incoming.ownerAccountId !== previous.ownerAccountId
    || !sameStrictJsonValue(incoming.rawHeader, previous.rawHeader)) return incoming;

  const sameCustody = incoming.storageMode === 'plain' || (incoming.storageMode === 'e2ee'
    && incoming.storageIdentity !== undefined && previous.storageIdentity !== undefined
    && sameStrictJsonValue(incoming.storageIdentity, previous.storageIdentity));
  if (!sameCustody) return incoming;
  return { ...incoming, body: previous.body };
}

function reconcileArtifacts(
  previous: Record<string, DecryptedArtifact>,
  incoming: readonly DecryptedArtifact[],
): Readonly<{ artifacts: Record<string, DecryptedArtifact>; storageChanged: boolean }> {
  let next = previous;
  let storageChanged = false;
  for (const incomingArtifact of incoming) {
    const before = next[incomingArtifact.id];
    // Content-only socket events have no grant projection. Only HTTP/grant
    // producers can replace known access; content must neither erase nor grant it.
    const missingKnownAccess = before && (
      (incomingArtifact.access === undefined && before.access !== undefined)
      || (incomingArtifact.ownerAccountId === undefined && before.ownerAccountId !== undefined)
    );
    const withKnownAccess = missingKnownAccess ? {
      ...incomingArtifact,
      ...(before.access !== undefined ? { access: incomingArtifact.access ?? before.access } : {}),
      ...(before.ownerAccountId !== undefined ? { ownerAccountId: incomingArtifact.ownerAccountId ?? before.ownerAccountId } : {}),
    } : incomingArtifact;
    const artifact = retainOpenedContent(before, withKnownAccess);
    if (sameStrictJsonValue(before, artifact)) continue;
    if (!before || before.headerVersion !== artifact.headerVersion || before.bodyVersion !== artifact.bodyVersion
      || before.storageMode !== artifact.storageMode) storageChanged = true;
    if (next === previous) next = { ...previous };
    next[artifact.id] = artifact;
  }
  return { artifacts: next, storageChanged };
}

export type ArtifactsDomain = {
  artifacts: Record<string, DecryptedArtifact>;
  artifactsLoaded: boolean;
  /** Invalidates the storage projection, not local hydration or grant-only changes. */
  artifactsStorageRevision: number;
  applyArtifacts: (artifacts: DecryptedArtifact[]) => void;
  addArtifact: (artifact: DecryptedArtifact) => void;
  updateArtifact: (artifact: DecryptedArtifact) => void;
  deleteArtifact: (artifactId: string) => void;
};

export function createArtifactsDomain<S extends ArtifactsDomain>({
  set,
}: {
  set: StoreSet<S>;
  get: StoreGet<S>;
}): ArtifactsDomain {
  return {
    artifacts: {},
    artifactsLoaded: false,
    artifactsStorageRevision: 0,
    applyArtifacts: (artifacts) =>
      set((state) => {
        const merged = reconcileArtifacts(state.artifacts, artifacts);
        if (merged.artifacts === state.artifacts && state.artifactsLoaded) return state;
        return {
          ...state,
          artifacts: merged.artifacts,
          artifactsLoaded: true,
          artifactsStorageRevision: state.artifactsStorageRevision + Number(merged.storageChanged),
        };
      }),
    addArtifact: (artifact) =>
      set((state) => {
        const updated = reconcileArtifacts(state.artifacts, [artifact]);
        if (updated.artifacts === state.artifacts) return state;
        return {
          ...state,
          artifacts: updated.artifacts,
          artifactsStorageRevision: state.artifactsStorageRevision + Number(updated.storageChanged),
        };
      }),
    updateArtifact: (artifact) =>
      set((state) => {
        const updated = reconcileArtifacts(state.artifacts, [artifact]);
        if (updated.artifacts === state.artifacts) return state;
        return {
          ...state,
          artifacts: updated.artifacts,
          artifactsStorageRevision: state.artifactsStorageRevision + Number(updated.storageChanged),
        };
      }),
    deleteArtifact: (artifactId) =>
      set((state) => {
        if (!Object.prototype.hasOwnProperty.call(state.artifacts, artifactId)) return state;
        const { [artifactId]: _, ...remainingArtifacts } = state.artifacts;

        return {
          ...state,
          artifacts: remainingArtifacts,
          artifactsStorageRevision: state.artifactsStorageRevision + 1,
        };
      }),
  };
}
