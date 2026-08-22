import {
  resolveSessionMetadataAgentIdentity,
} from '@happier-dev/agents';
import {
  readRuntimeDescriptorV1FromMetadata,
} from '@happier-dev/protocol';

import { PersistedProviderResumeBindingError } from '@/providers/lifecycle/readPersistedResumeSelection';
import { isCatalogAgentId } from '@/agent/catalog/resolution';
import { resolveBackendTargetFromSessionMetadata } from '@/session/backendTargets/resolveBackendTargetFromSessionMetadata';
import { resolveSessionMachineWorkspacePath } from '@/session/machineControlLocality';
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

/**
 * Resolves the exact Agent this inactive Session must be resumed as.
 *
 * Identity precedence is owned by `resolveSessionMetadataAgentIdentity`: a
 * declared runtime/linked identity wins, then `flavor`, then exactly one flat
 * vendor resume key. Deriving it here from a union of every piece of evidence
 * would be a second decision-maker, and the union's unanimity rule made any
 * Session that had ever carried two flat resume keys permanently unresumable —
 * `REQ-STATE-01` allows at most one key on an active view, so a second key is
 * legacy residue, not a competing identity.
 *
 * Ambiguity still fails closed: several flat keys with no higher authority
 * resolve to no Agent rather than to the first Agent in catalog order.
 */
function resolveExactPersistedBackendIdentity(metadata: Record<string, unknown>): Readonly<{
  backendTarget: NonNullable<SpawnSessionOptions['backendTarget']>;
  runtimeDescriptorV1?: SpawnSessionOptions['runtimeDescriptorV1'];
}> | null {
  const backendTarget = resolveBackendTargetFromSessionMetadata(metadata);
  if (!backendTarget) return null;

  const runtimeDescriptorV1 = readRuntimeDescriptorV1FromMetadata(metadata);
  const identity = resolveSessionMetadataAgentIdentity(metadata);

  if (backendTarget.sourceKind === 'configured') {
    // A configured ACP backend must carry no built-in Agent evidence at all;
    // any is a contradiction between the persisted target and the identity.
    if (identity.agentId || identity.vendorResumeKeyAgentIds.length > 0 || runtimeDescriptorV1) return null;
  } else {
    if (!isCatalogAgentId(backendTarget.backendId)) return null;
    if (!identity.agentId || identity.agentId !== backendTarget.backendId) return null;
    if (
      runtimeDescriptorV1
      && isCatalogAgentId(runtimeDescriptorV1.agentId)
      && runtimeDescriptorV1.agentId !== identity.agentId
    ) return null;
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

  const persistedDirectory = selectCanonicalPersistedDirectory(rawDirectory, metadataDirectory);
  const machineId = rawMachineId ?? metadataMachineId ?? readNonEmptyString(params.fallbackMachineId);
  const runtimeIdentity = resolveExactPersistedBackendIdentity(params.metadata);
  if (!persistedDirectory || !machineId || !runtimeIdentity) return null;
  const directory = resolveSessionMachineWorkspacePath({
    metadata: params.metadata,
    currentMachineId: machineId,
    candidatePath: persistedDirectory,
  });
  if (!directory) return null;

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
