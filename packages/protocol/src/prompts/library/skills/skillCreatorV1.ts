import type { ArtifactRevisionProvenanceV1 } from '../../../artifacts/artifactBinaryV1.js';
import { deriveArtifactCoarseKindV1 } from '../../../artifacts/artifactKindV1.js';
import { readSkillLockV1 } from './skillLibraryItemV1.js';

/** Record attribution stays private and immutable, including legacy absence. */
export function preserveSkillCreatorV1(input: Readonly<{
  header: Readonly<Record<string, unknown>>;
  provenance?: ArtifactRevisionProvenanceV1;
  currentProvenance?: ArtifactRevisionProvenanceV1;
  isCreate: boolean;
}>): ArtifactRevisionProvenanceV1 | undefined {
  if (!input.provenance) return !input.isCreate && input.currentProvenance?.skillCreator
    ? input.currentProvenance : undefined;
  const { skillCreator: _candidateCreator, ...provenance } = input.provenance;
  const skillCreator = input.isCreate
    ? deriveArtifactCoarseKindV1(input.header) === 'skill' && readSkillLockV1(input.header).provenance.kind === 'written'
      ? provenance.savedBy : undefined
    : input.currentProvenance?.skillCreator;
  return skillCreator ? { ...provenance, skillCreator } : provenance;
}
