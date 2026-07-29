import type { DecryptedArtifact } from '../../domains/artifacts/artifactTypes';
import { loadSyncTuning } from '../../runtime/syncTuning';
import type { StoreGet, StoreSet } from './_shared';

const ARTIFACT_HEADS_MAX_ENTRIES = loadSyncTuning().artifactHeadsMaxEntries;

function retainNewestArtifacts(
  artifacts: Record<string, DecryptedArtifact>,
): Record<string, DecryptedArtifact> {
  const entries = Object.values(artifacts)
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, ARTIFACT_HEADS_MAX_ENTRIES);
  return Object.fromEntries(entries.map((artifact) => [artifact.id, artifact]));
}

export type ArtifactsDomain = {
  artifacts: Record<string, DecryptedArtifact>;
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
    applyArtifacts: (artifacts) =>
      set((state) => {
        const mergedArtifacts = { ...state.artifacts };
        artifacts.forEach((artifact) => {
          mergedArtifacts[artifact.id] = artifact;
        });

        return {
          ...state,
          artifacts: retainNewestArtifacts(mergedArtifacts),
        };
      }),
    addArtifact: (artifact) =>
      set((state) => {
        const updatedArtifacts = {
          ...state.artifacts,
          [artifact.id]: artifact,
        };

        return {
          ...state,
          artifacts: retainNewestArtifacts(updatedArtifacts),
        };
      }),
    updateArtifact: (artifact) =>
      set((state) => {
        const updatedArtifacts = {
          ...state.artifacts,
          [artifact.id]: artifact,
        };

        return {
          ...state,
          artifacts: retainNewestArtifacts(updatedArtifacts),
        };
      }),
    deleteArtifact: (artifactId) =>
      set((state) => {
        const { [artifactId]: _, ...remainingArtifacts } = state.artifacts;

        return {
          ...state,
          artifacts: remainingArtifacts,
        };
      }),
  };
}
