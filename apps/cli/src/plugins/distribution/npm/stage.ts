import {
  cleanupStagedNpmCompatiblePluginArchive,
  stageNpmCompatiblePluginArchive,
  type PluginArchiveStagingRejection,
  type PluginArchiveStagingRejectionCode,
  type StagedNpmCompatiblePluginArchive,
} from '../archive/stage';
import type { PortableArchiveLimits } from '../archive/types';
import type { DownloadedNpmArtifactCandidate } from './types';

export type NpmCandidateStagingRejectionCode = PluginArchiveStagingRejectionCode;
export type NpmCandidateStagingRejection = PluginArchiveStagingRejection;

export type StagedNpmArtifactCandidate = StagedNpmCompatiblePluginArchive & Readonly<{
  source: DownloadedNpmArtifactCandidate['source'];
  registrySignature: DownloadedNpmArtifactCandidate['registrySignature'];
  provenance: DownloadedNpmArtifactCandidate['provenance'];
}>;

export type StageDownloadedNpmArtifactCandidateResult =
  | Readonly<{ ok: true; candidate: StagedNpmArtifactCandidate }>
  | Readonly<{ ok: false; rejection: NpmCandidateStagingRejection }>;

export type StageDownloadedNpmArtifactCandidateParams = Readonly<{
  candidate: DownloadedNpmArtifactCandidate;
  stagingParentPath: string;
  archiveLimits?: Partial<PortableArchiveLimits>;
  signal?: AbortSignal;
}>;

type OwnedNpmCandidateState = {
  readonly archive: StagedNpmCompatiblePluginArchive;
  cleanupPromise: Promise<void> | null;
};

const ownedNpmCandidates = new WeakMap<StagedNpmArtifactCandidate, OwnedNpmCandidateState>();

export async function stageDownloadedNpmArtifactCandidate(
  params: StageDownloadedNpmArtifactCandidateParams,
): Promise<StageDownloadedNpmArtifactCandidateResult> {
  const result = await stageNpmCompatiblePluginArchive({
    archivePath: params.candidate.artifactPath,
    byteLength: params.candidate.byteLength,
    integrity: params.candidate.source.integrity,
    expectedPackage: {
      name: params.candidate.source.packageName,
      version: params.candidate.source.version,
    },
    stagingParentPath: params.stagingParentPath,
    archiveLimits: params.archiveLimits,
    signal: params.signal,
  });
  if (!result.ok) return result;
  const candidate: StagedNpmArtifactCandidate = Object.freeze({
    ...result.candidate,
    source: params.candidate.source,
    registrySignature: params.candidate.registrySignature,
    provenance: params.candidate.provenance,
  });
  ownedNpmCandidates.set(candidate, { archive: result.candidate, cleanupPromise: null });
  return Object.freeze({ ok: true, candidate });
}

export function cleanupStagedNpmArtifactCandidate(candidate: StagedNpmArtifactCandidate): Promise<void> {
  const state = ownedNpmCandidates.get(candidate);
  if (!state) return Promise.reject(new Error('Refusing to clean a path without an operation-owned staged candidate handle'));
  if (state.cleanupPromise) return state.cleanupPromise;
  const cleanupPromise = cleanupStagedNpmCompatiblePluginArchive(state.archive)
    .then(() => { ownedNpmCandidates.delete(candidate); })
    .catch((cause: unknown) => {
      state.cleanupPromise = null;
      throw cause;
    });
  state.cleanupPromise = cleanupPromise;
  return cleanupPromise;
}
