import {
  AGENT_IDS,
  getAgentResumeConfig,
  resolveAgentIdFromSessionMetadata,
  resolveCanonicalAgentIdFromFlavor,
  type AgentId,
} from '@happier-dev/agents';
import { readRuntimeDescriptorV1FromMetadata } from '@happier-dev/protocol';

import { PersistedProviderResumeBindingError } from '@/providers/lifecycle/readPersistedResumeSelection';
import { resolveExplicitBackendTargetFromSessionMetadata } from '@/session/backendTargets/resolveBackendTargetFromSessionMetadata';
import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';
import {
  resolveCanonicalAbsolutePath,
  type CanonicalAbsolutePath,
} from '@/utils/path/expandHomeDirPath';

import { resolveSessionRuntimeSnapshot } from './resolveSessionRuntimeSnapshot';

export type BuildInactiveSessionResumeSpawnOptionsParams = Readonly<{
  fallbackMachineId?: string | null;
  sessionId: string;
  rawSession: unknown;
  metadata: Record<string, unknown>;
  initialTranscriptAfterSeq?: number;
  executionAuthorization?: import('@happier-dev/protocol').SpawnSessionExecutionAuthorization;
}>;

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function resolveCanonicalPersistedDirectory(value: unknown): CanonicalAbsolutePath | null {
  const raw = readNonEmptyString(value);
  if (!raw) return null;
  return resolveCanonicalAbsolutePath(raw);
}

function selectCanonicalPersistedDirectory(
  rawDirectory: CanonicalAbsolutePath | null,
  metadataDirectory: CanonicalAbsolutePath | null,
): string | null {
  if (
    rawDirectory
    && metadataDirectory
    && rawDirectory.comparisonKey !== metadataDirectory.comparisonKey
  ) return null;
  if (!rawDirectory) return metadataDirectory?.path ?? null;
  if (!metadataDirectory) return rawDirectory.path;

  // Windows can preserve different case spellings for one identity. Select a
  // stable preserved spelling independent of which persisted carrier supplied
  // it; never lowercase the execution path merely to obtain a comparison key.
  return rawDirectory.path <= metadataDirectory.path
    ? rawDirectory.path
    : metadataDirectory.path;
}

function resolveExactPersistedBackendIdentity(metadata: Record<string, unknown>): Readonly<{
  backendTarget: NonNullable<SpawnSessionOptions['backendTarget']>;
  runtimeDescriptorV1?: SpawnSessionOptions['runtimeDescriptorV1'];
}> | null {
  const backendTarget = resolveExplicitBackendTargetFromSessionMetadata(metadata);
  if (!backendTarget) return null;

  const runtimeDescriptorV1 = readRuntimeDescriptorV1FromMetadata(metadata);
  const identityCandidates = new Set<AgentId>();
  const resolvedAgentId = resolveAgentIdFromSessionMetadata(metadata);
  if (resolvedAgentId) identityCandidates.add(resolvedAgentId);
  const flavorAgentId = resolveCanonicalAgentIdFromFlavor(metadata.flavor);
  if (flavorAgentId) identityCandidates.add(flavorAgentId);
  if (runtimeDescriptorV1 && (AGENT_IDS as readonly string[]).includes(runtimeDescriptorV1.agentId)) {
    identityCandidates.add(runtimeDescriptorV1.agentId as AgentId);
  }
  for (const candidateAgentId of AGENT_IDS) {
    const resumeField = getAgentResumeConfig(candidateAgentId).vendorResumeIdField ?? null;
    if (resumeField && readNonEmptyString(metadata[resumeField])) {
      identityCandidates.add(candidateAgentId);
    }
  }

  if (backendTarget.sourceKind === 'configured') {
    if (identityCandidates.size > 0 || runtimeDescriptorV1) return null;
  } else {
    if (!(AGENT_IDS as readonly string[]).includes(backendTarget.backendId)) return null;
    identityCandidates.add(backendTarget.backendId as AgentId);
    if (identityCandidates.size !== 1) return null;
  }

  return {
    backendTarget,
    ...(runtimeDescriptorV1 ? { runtimeDescriptorV1 } : {}),
  };
}

/** Canonical provider-neutral inactive-session snapshot composition. */
export function buildInactiveSessionResumeSpawnOptions(
  params: BuildInactiveSessionResumeSpawnOptionsParams,
): SpawnSessionOptions | null {
  const rawSession = params.rawSession && typeof params.rawSession === 'object' && !Array.isArray(params.rawSession)
    ? params.rawSession as Record<string, unknown>
    : {};
  const rawDirectory = resolveCanonicalPersistedDirectory(rawSession.path);
  const metadataDirectory = resolveCanonicalPersistedDirectory(params.metadata.path);

  const rawMachineId = readNonEmptyString(rawSession.machineId);
  const metadataMachineId = readNonEmptyString(params.metadata.machineId);
  if (rawMachineId && metadataMachineId && rawMachineId !== metadataMachineId) return null;

  const directory = selectCanonicalPersistedDirectory(rawDirectory, metadataDirectory);
  const machineId = rawMachineId ?? metadataMachineId ?? readNonEmptyString(params.fallbackMachineId);
  const runtimeIdentity = resolveExactPersistedBackendIdentity(params.metadata);
  if (!directory || !machineId || !runtimeIdentity) return null;

  let resolved: SpawnSessionOptions;
  try {
    resolved = resolveSessionRuntimeSnapshot({
      incomingOptions: {
        existingSessionId: params.sessionId,
        machineId,
        directory,
        backendTarget: runtimeIdentity.backendTarget,
        approvedNewDirectoryCreation: true,
        ...(runtimeIdentity.runtimeDescriptorV1 ? { runtimeDescriptorV1: runtimeIdentity.runtimeDescriptorV1 } : {}),
      },
      persistedMetadata: params.metadata,
    }).spawnOptions;
  } catch (error) {
    if (error instanceof PersistedProviderResumeBindingError) return null;
    throw error;
  }

  // Snapshot resolution intentionally excludes request-scoped controls from
  // durable tracked state. Reattach only this invocation's fresh controls.
  return {
    ...resolved,
    ...(typeof params.initialTranscriptAfterSeq === 'number'
      && Number.isSafeInteger(params.initialTranscriptAfterSeq)
      && params.initialTranscriptAfterSeq >= 0
      ? { initialTranscriptAfterSeq: params.initialTranscriptAfterSeq }
      : {}),
    ...(params.executionAuthorization ? { executionAuthorization: params.executionAuthorization } : {}),
  };
}
