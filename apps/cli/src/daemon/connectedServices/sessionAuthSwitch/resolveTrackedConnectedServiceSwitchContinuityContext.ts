import { isAbsolute } from 'node:path';

import { resolveVendorResumeIdFromSessionMetadata } from '@happier-dev/agents';
import {
  readConnectedServiceMaterializationIdentityV1FromMetadata,
  type ConnectedServiceMaterializationIdentityV1,
} from '@happier-dev/protocol';

import type { CatalogAgentId } from '@/backends/types';
import type { TrackedSession } from '@/daemon/types';
import {
  readConnectedServiceMaterializationIdentityV1,
} from '@/daemon/connectedServices/materialize/createConnectedServiceMaterializationIdentity';
import {
  resolveConnectedServiceSwitchTargetMaterializedContext,
} from '@/daemon/connectedServices/materialize/resolveConnectedServiceSwitchTargetMaterializedContext';

type ContinuityTrackedSession = Pick<
  TrackedSession,
  'happySessionMetadataFromLocalWebhook' | 'spawnOptions' | 'vendorResumeId'
>;

type ResolvedTrackedResumeContext = Readonly<{
  vendorResumeId: string | null;
  candidatePersistedSessionFile: string | null;
}>;

type ResolveConnectedServiceCandidatePersistedSessionFile = (
  agentId: CatalogAgentId,
  metadata: unknown,
) => string | null;

export function resolveTrackedConnectedServiceMaterializationIdentity(input: Readonly<{
  tracked: ContinuityTrackedSession | null;
  connectedServiceMaterializationIdentityV1?: ConnectedServiceMaterializationIdentityV1 | null;
  persistedSessionMetadata?: unknown;
}>): ConnectedServiceMaterializationIdentityV1 | null {
  return readConnectedServiceMaterializationIdentityV1(
    input.tracked?.spawnOptions?.connectedServiceMaterializationIdentityV1,
  ) ?? input.connectedServiceMaterializationIdentityV1
    ?? readConnectedServiceMaterializationIdentityV1FromMetadata(input.persistedSessionMetadata ?? null)
    ?? readConnectedServiceMaterializationIdentityV1FromMetadata(
      input.tracked?.happySessionMetadataFromLocalWebhook ?? null,
    );
}

export function resolveTrackedConnectedServiceVendorResumeId(input: Readonly<{
  agentId: CatalogAgentId;
  tracked: ContinuityTrackedSession | null;
  vendorResumeId?: string | null;
}>): string | null {
  return normalizeOptionalString(input.tracked?.vendorResumeId)
    ?? normalizeOptionalString(input.tracked?.spawnOptions?.resume)
    ?? resolveVendorResumeIdFromSessionMetadata(
      input.agentId,
      input.tracked?.happySessionMetadataFromLocalWebhook ?? null,
    )
    ?? normalizeOptionalString(input.vendorResumeId);
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function normalizeOptionalAbsolutePath(value: unknown): string | null {
  const normalized = normalizeOptionalString(value);
  return normalized && isAbsolute(normalized) ? normalized : null;
}

function resolveTrackedConnectedServiceResumeContext(input: Readonly<{
  agentId: CatalogAgentId;
  tracked: ContinuityTrackedSession | null;
  persistedSessionMetadata?: unknown;
  vendorResumeId?: string | null;
  candidatePersistedSessionFile?: string | null;
  resolveCandidatePersistedSessionFile?: ResolveConnectedServiceCandidatePersistedSessionFile;
}>): ResolvedTrackedResumeContext {
  const trackedMetadata = input.tracked?.happySessionMetadataFromLocalWebhook ?? null;
  const persistedMetadata = input.persistedSessionMetadata ?? null;
  const resolveCandidatePersistedSessionFile = input.resolveCandidatePersistedSessionFile;
  const trackedMetadataVendorResumeId = resolveVendorResumeIdFromSessionMetadata(input.agentId, trackedMetadata);
  const trackedMetadataCandidatePersistedSessionFile = trackedMetadata && resolveCandidatePersistedSessionFile
    ? resolveCandidatePersistedSessionFile(input.agentId, trackedMetadata)
    : null;
  const persistedMetadataVendorResumeId = resolveVendorResumeIdFromSessionMetadata(input.agentId, persistedMetadata);
  const persistedMetadataCandidatePersistedSessionFile = persistedMetadata && resolveCandidatePersistedSessionFile
    ? resolveCandidatePersistedSessionFile(input.agentId, persistedMetadata)
    : null;
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
    candidatePersistedSessionFile: explicitCandidatePersistedSessionFile
      ?? (explicitVendorResumeId === null
        ? persistedMetadataCandidatePersistedSessionFile ?? trackedMetadataCandidatePersistedSessionFile
        : null),
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
  resolveCandidatePersistedSessionFile?: ResolveConnectedServiceCandidatePersistedSessionFile;
  /**
   * Freshly materialized runtime-auth selection (opaque), when the switch rematerialized the target
   * BEFORE continuity. Its materialized env/root take precedence over the tracked session's
   * inherited (pre-switch) env so the Rule-A proof evaluates the POST-materialization target the
   * next spawn reads (RD-SW-2 — a vacuous old-home proof can strand the session).
   */
  runtimeAuthSelection?: unknown;
}>): Readonly<{
  connectedServiceMaterializationIdentityV1: ConnectedServiceMaterializationIdentityV1 | null;
  targetMaterializedRoot: string | null;
  targetMaterializedEnv: Readonly<Record<string, string>> | null;
  vendorResumeId: string | null;
  cwd: string | null;
  candidatePersistedSessionFile: string | null;
}> {
  const resumeContext = resolveTrackedConnectedServiceResumeContext({
    agentId: input.agentId,
    tracked: input.tracked,
    persistedSessionMetadata: input.persistedSessionMetadata,
    vendorResumeId: input.vendorResumeId,
    candidatePersistedSessionFile: input.candidatePersistedSessionFile,
    resolveCandidatePersistedSessionFile: input.resolveCandidatePersistedSessionFile,
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
      runtimeAuthSelection: input.runtimeAuthSelection,
    });
  return {
    connectedServiceMaterializationIdentityV1: effectiveIdentity,
    targetMaterializedRoot,
    targetMaterializedEnv,
    vendorResumeId: resumeContext.vendorResumeId,
    cwd: normalizeOptionalString(input.tracked?.spawnOptions?.directory)
      ?? normalizeOptionalString(input.cwd),
    candidatePersistedSessionFile: resumeContext.candidatePersistedSessionFile,
  };
}
