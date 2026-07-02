import { isAbsolute } from 'node:path';

import { resolveVendorResumeIdFromSessionMetadata } from '@happier-dev/agents';
import type { ConnectedServiceMaterializationIdentityV1 } from '@happier-dev/protocol';

import { resolveConnectedServiceCandidatePersistedSessionFile } from '@/backends/catalog';
import type { CatalogAgentId } from '@/backends/types';
import type { TrackedSession } from '@/daemon/types';
import {
  readConnectedServiceMaterializationIdentityFromMetadata,
  readConnectedServiceMaterializationIdentityFromSpawnOptions,
} from '@/daemon/connectedServices/materialization/identity';
import { resolveConnectedServiceSwitchTargetMaterializedContext } from '@/daemon/connectedServices/materialize/resolveConnectedServiceSwitchTargetMaterializedContext';

type ContinuityTrackedSession = Pick<
  TrackedSession,
  'happySessionMetadataFromLocalWebhook' | 'spawnOptions' | 'vendorResumeId'
>;

type ResolvedTrackedResumeContext = Readonly<{
  vendorResumeId: string | null;
  candidatePersistedSessionFile: string | null;
}>;

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function normalizeOptionalAbsolutePath(value: unknown): string | null {
  const normalized = normalizeOptionalString(value);
  return normalized && isAbsolute(normalized) ? normalized : null;
}

export function resolveTrackedConnectedServiceMaterializationIdentity(input: Readonly<{
  tracked: ContinuityTrackedSession | null;
  connectedServiceMaterializationIdentityV1?: ConnectedServiceMaterializationIdentityV1 | null;
  persistedSessionMetadata?: unknown;
}>): ConnectedServiceMaterializationIdentityV1 | null {
  return readConnectedServiceMaterializationIdentityFromSpawnOptions(
    input.tracked?.spawnOptions ?? null,
  )
    ?? input.connectedServiceMaterializationIdentityV1
    ?? readConnectedServiceMaterializationIdentityFromMetadata(input.persistedSessionMetadata ?? null)
    ?? readConnectedServiceMaterializationIdentityFromMetadata(
      input.tracked?.happySessionMetadataFromLocalWebhook ?? null,
    );
}

export function resolveTrackedConnectedServiceVendorResumeId(input: Readonly<{
  agentId: CatalogAgentId;
  tracked: ContinuityTrackedSession | null;
  vendorResumeId?: string | null;
}>): string | null {
  const metadata = input.tracked?.happySessionMetadataFromLocalWebhook ?? null;
  return normalizeOptionalString(input.tracked?.vendorResumeId)
    ?? normalizeOptionalString(input.tracked?.spawnOptions?.resume)
    ?? resolveVendorResumeIdFromSessionMetadata(input.agentId, metadata)
    ?? normalizeOptionalString(input.vendorResumeId);
}

function resolveTrackedConnectedServiceResumeContext(input: Readonly<{
  agentId: CatalogAgentId;
  tracked: ContinuityTrackedSession | null;
  persistedSessionMetadata?: unknown;
  vendorResumeId?: string | null;
  candidatePersistedSessionFile?: string | null;
}>): ResolvedTrackedResumeContext {
  const trackedMetadata = input.tracked?.happySessionMetadataFromLocalWebhook ?? null;
  const persistedMetadata = input.persistedSessionMetadata ?? null;
  const trackedMetadataVendorResumeId = resolveVendorResumeIdFromSessionMetadata(input.agentId, trackedMetadata);
  const trackedMetadataCandidatePersistedSessionFile = resolveConnectedServiceCandidatePersistedSessionFile(
    input.agentId,
    trackedMetadata,
  );
  const persistedMetadataVendorResumeId = resolveVendorResumeIdFromSessionMetadata(input.agentId, persistedMetadata);
  const persistedMetadataCandidatePersistedSessionFile = resolveConnectedServiceCandidatePersistedSessionFile(
    input.agentId,
    persistedMetadata,
  );
  const trackedVendorResumeId = normalizeOptionalString(input.tracked?.vendorResumeId);
  const trackedSpawnResume = normalizeOptionalString(input.tracked?.spawnOptions?.resume);
  const trackedSpawnResumeCandidate = normalizeOptionalAbsolutePath(trackedSpawnResume);
  const explicitVendorResumeId = normalizeOptionalString(input.vendorResumeId);
  const explicitCandidatePersistedSessionFile = normalizeOptionalString(input.candidatePersistedSessionFile);

  if (trackedVendorResumeId) {
    return {
      vendorResumeId: trackedVendorResumeId,
      candidatePersistedSessionFile: trackedSpawnResumeCandidate
        ?? (persistedMetadataVendorResumeId === trackedVendorResumeId ? persistedMetadataCandidatePersistedSessionFile : null)
        ?? (trackedMetadataVendorResumeId === trackedVendorResumeId ? trackedMetadataCandidatePersistedSessionFile : null)
        ?? (explicitVendorResumeId === trackedVendorResumeId ? explicitCandidatePersistedSessionFile : null),
    };
  }

  if (trackedSpawnResume) {
    return {
      vendorResumeId: trackedSpawnResume,
      candidatePersistedSessionFile: trackedSpawnResumeCandidate
        ?? (persistedMetadataVendorResumeId === trackedSpawnResume ? persistedMetadataCandidatePersistedSessionFile : null)
        ?? (trackedMetadataVendorResumeId === trackedSpawnResume ? trackedMetadataCandidatePersistedSessionFile : null)
        ?? (explicitVendorResumeId === trackedSpawnResume ? explicitCandidatePersistedSessionFile : null),
    };
  }

  if (persistedMetadataVendorResumeId) {
    return {
      vendorResumeId: persistedMetadataVendorResumeId,
      candidatePersistedSessionFile: persistedMetadataCandidatePersistedSessionFile
        ?? (explicitVendorResumeId === persistedMetadataVendorResumeId ? explicitCandidatePersistedSessionFile : null),
    };
  }

  if (trackedMetadataVendorResumeId) {
    return {
      vendorResumeId: trackedMetadataVendorResumeId,
      candidatePersistedSessionFile: trackedMetadataCandidatePersistedSessionFile
        ?? (explicitVendorResumeId === trackedMetadataVendorResumeId ? explicitCandidatePersistedSessionFile : null),
    };
  }

  return {
    vendorResumeId: explicitVendorResumeId,
    candidatePersistedSessionFile: explicitCandidatePersistedSessionFile,
  };
}

export function resolveTrackedConnectedServiceSwitchContinuityContext(input: Readonly<{
  agentId: CatalogAgentId;
  baseDir: string;
  tracked: ContinuityTrackedSession | null;
  connectedServiceMaterializationIdentityV1?: ConnectedServiceMaterializationIdentityV1 | null;
  persistedSessionMetadata?: unknown;
  vendorResumeId?: string | null;
  cwd?: string | null;
  candidatePersistedSessionFile?: string | null;
}>): Readonly<{
  connectedServiceMaterializationIdentityV1: ConnectedServiceMaterializationIdentityV1 | null;
  targetMaterializedRoot: string | null;
  targetMaterializedEnv: Readonly<Record<string, string>> | null;
  vendorResumeId: string | null;
  cwd: string | null;
  candidatePersistedSessionFile: string | null;
}> {
  const metadata = input.tracked?.happySessionMetadataFromLocalWebhook ?? null;
  const persistedMetadata = input.persistedSessionMetadata ?? null;
  const resumeContext = resolveTrackedConnectedServiceResumeContext({
    agentId: input.agentId,
    tracked: input.tracked,
    persistedSessionMetadata: input.persistedSessionMetadata,
    vendorResumeId: input.vendorResumeId,
    candidatePersistedSessionFile: input.candidatePersistedSessionFile,
  });
  const effectiveIdentity = resolveTrackedConnectedServiceMaterializationIdentity({
    tracked: input.tracked,
    connectedServiceMaterializationIdentityV1: input.connectedServiceMaterializationIdentityV1,
    persistedSessionMetadata: input.persistedSessionMetadata,
  });
  const { targetMaterializedEnv, targetMaterializedRoot } =
    resolveConnectedServiceSwitchTargetMaterializedContext({
      agentId: input.agentId,
      baseDir: input.baseDir,
      inheritedEnv: input.tracked?.spawnOptions?.environmentVariables ?? null,
      effectiveIdentity,
    });
  return {
    connectedServiceMaterializationIdentityV1: effectiveIdentity,
    targetMaterializedRoot,
    targetMaterializedEnv,
    vendorResumeId: resumeContext.vendorResumeId,
    cwd: normalizeOptionalString(input.tracked?.spawnOptions?.directory)
      ?? normalizeOptionalString((metadata as { path?: unknown } | null)?.path)
      ?? normalizeOptionalString(input.cwd)
      ?? normalizeOptionalString((persistedMetadata as { path?: unknown } | null)?.path),
    candidatePersistedSessionFile: resumeContext.candidatePersistedSessionFile,
  };
}
