import { inferAgentIdFromSessionMetadata } from '@happier-dev/agents';
import {
  readAcpConfiguredBackendV1FromMetadata,
  readRuntimeDescriptorV1FromMetadata,
} from '@happier-dev/protocol';

import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';

import { resolveSessionRuntimeSnapshot } from './resolveSessionRuntimeSnapshot';

export type BuildInactiveUsageLimitResumeSpawnOptionsParams = Readonly<{
  fallbackMachineId: string;
  sessionId: string;
  rawSession: unknown;
  metadata: Record<string, unknown>;
}>;

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function resolveBackendTargetFromMetadata(
  metadata: Record<string, unknown>,
): SpawnSessionOptions['backendTarget'] | null {
  const configuredBackendId = readNonEmptyString(
    readAcpConfiguredBackendV1FromMetadata(metadata)?.backendId,
  );
  if (configuredBackendId) {
    return {
      kind: 'backend',
      backendId: configuredBackendId,
      configuredBackendId,
      sourceKind: 'configured',
    };
  }

  const agentId = inferAgentIdFromSessionMetadata(metadata);
  return agentId
    ? { kind: 'backend', backendId: agentId, sourceKind: 'built_in' }
    : null;
}

export function buildInactiveUsageLimitResumeSpawnOptions(
  params: BuildInactiveUsageLimitResumeSpawnOptionsParams,
): SpawnSessionOptions | null {
  const rawSession = params.rawSession && typeof params.rawSession === 'object' && !Array.isArray(params.rawSession)
    ? params.rawSession as Record<string, unknown>
    : {};
  const directory = readNonEmptyString(rawSession.path) ?? readNonEmptyString(params.metadata.path);
  const machineId =
    readNonEmptyString(rawSession.machineId)
    ?? readNonEmptyString(params.metadata.machineId)
    ?? readNonEmptyString(params.fallbackMachineId);
  const backendTarget = resolveBackendTargetFromMetadata(params.metadata);
  if (!directory || !machineId || !backendTarget) return null;

  const runtimeDescriptorV1 = readRuntimeDescriptorV1FromMetadata(params.metadata);
  const baseOptions: SpawnSessionOptions = {
    existingSessionId: params.sessionId,
    machineId,
    directory,
    backendTarget,
    approvedNewDirectoryCreation: true,
    ...(runtimeDescriptorV1 ? { runtimeDescriptorV1 } : {}),
  };

  return resolveSessionRuntimeSnapshot({
    incomingOptions: baseOptions,
    persistedMetadata: params.metadata,
  }).spawnOptions;
}
