import {
  AGENT_IDS,
  resolveSessionMetadataAgentIdentity,
} from '@happier-dev/agents';
import {
  AgentRuntimeDescriptorV1Schema,
  readAcpConfiguredBackendV1FromMetadata,
} from '@happier-dev/protocol';

import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';

import { resolveSessionRuntimeSnapshot } from './resolveSessionRuntimeSnapshot';

export type BuildInactiveSessionResumeSpawnOptionsParams = Readonly<{
  fallbackMachineId?: string | null;
  sessionId: string;
  rawSession: RawSessionRecord;
  metadata: Record<string, unknown>;
  initialTranscriptAfterSeq?: number;
  executionAuthorization?: import('@happier-dev/protocol').SpawnSessionExecutionAuthorization;
}>;

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function comparableDirectoryIdentity(value: string): string {
  const expanded = expandHomeDirPath(value).trim();
  const normalized = expanded.replaceAll('\\', '/').replace(/\/+$/u, '');
  return /^[a-zA-Z]:\//u.test(normalized) || normalized.startsWith('//')
    ? normalized.toLowerCase()
    : normalized;
}

/**
 * Resolves the exact Agent this inactive Session must be resumed as.
 *
 * Identity precedence is owned by `resolveSessionMetadataAgentIdentity`: a
 * declared runtime identity wins, then `flavor`, then exactly one flat vendor
 * resume key. Deriving it here from a union of every piece of evidence would be
 * a second decision-maker, and the union's unanimity rule made any Session that
 * had ever carried two flat resume keys permanently unresumable — Session
 * metadata holds at most one non-empty flat key, so a second key is legacy
 * residue, not a competing identity.
 *
 * Ambiguity still fails closed: several flat keys with no higher authority
 * resolve to no Agent rather than to the first Agent in catalog order.
 */
function resolveExactPersistedRuntimeIdentity(
  metadata: Record<string, unknown>,
): Readonly<{
  backendTarget: NonNullable<SpawnSessionOptions['backendTarget']>;
  agentRuntimeDescriptorV1?: SpawnSessionOptions['agentRuntimeDescriptorV1'];
}> | null {
  const hasConfiguredBackendMetadata = Object.prototype.hasOwnProperty.call(metadata, 'acpConfiguredBackendV1');
  const configuredBackend = readAcpConfiguredBackendV1FromMetadata(metadata);
  if (hasConfiguredBackendMetadata && !configuredBackend) return null;

  let agentRuntimeDescriptorV1: SpawnSessionOptions['agentRuntimeDescriptorV1'] | undefined;
  if (metadata.agentRuntimeDescriptorV1 !== undefined) {
    const parsed = AgentRuntimeDescriptorV1Schema.safeParse(metadata.agentRuntimeDescriptorV1);
    if (!parsed.success || !(AGENT_IDS as readonly string[]).includes(parsed.data.providerId)) return null;
    agentRuntimeDescriptorV1 = parsed.data;
  }

  const identity = resolveSessionMetadataAgentIdentity(metadata);

  if (configuredBackend) {
    // A configured ACP backend must carry no built-in Agent evidence; any is a
    // contradiction between the persisted target and the identity. Generic ACP
    // identity is not built-in evidence: a configured backend persists
    // `flavor: 'acp:<backendId>'`, which reads back as `customAcp`.
    if (identity.agentId !== null && identity.agentId !== 'customAcp') return null;
    if (identity.vendorResumeKeyAgentIds.some((agentId) => agentId !== 'customAcp')) return null;
    if (agentRuntimeDescriptorV1 && agentRuntimeDescriptorV1.providerId !== 'customAcp') return null;
    return {
      backendTarget: {
        kind: 'configuredAcpBackend',
        backendId: configuredBackend.backendId,
      },
    };
  }

  if (!identity.agentId) return null;
  if (agentRuntimeDescriptorV1 && agentRuntimeDescriptorV1.providerId !== identity.agentId) return null;
  return {
    backendTarget: { kind: 'builtInAgent', agentId: identity.agentId },
    ...(agentRuntimeDescriptorV1 ? { agentRuntimeDescriptorV1 } : {}),
  };
}

/**
 * Canonical provider-neutral inactive-session snapshot composition.
 *
 * This reconstructs only facts already owned by the session snapshot. It never
 * authorizes execution by itself; explicit callers must supply fresh execution
 * authorization and lifecycle owners decide whether the resulting resume may run.
 */
export function buildInactiveSessionResumeSpawnOptions(
  params: BuildInactiveSessionResumeSpawnOptionsParams,
): SpawnSessionOptions | null {
  const rawDirectory = readNonEmptyString(params.rawSession.path);
  const metadataDirectory = readNonEmptyString(params.metadata.path);
  if (
    rawDirectory
    && metadataDirectory
    && comparableDirectoryIdentity(rawDirectory) !== comparableDirectoryIdentity(metadataDirectory)
  ) return null;

  const rawMachineId = readNonEmptyString(params.rawSession.machineId);
  const metadataMachineId = readNonEmptyString(params.metadata.machineId);
  if (rawMachineId && metadataMachineId && rawMachineId !== metadataMachineId) return null;

  const directory = rawDirectory ?? metadataDirectory;
  const machineId = rawMachineId ?? metadataMachineId ?? readNonEmptyString(params.fallbackMachineId);
  const runtimeIdentity = resolveExactPersistedRuntimeIdentity(params.metadata);
  if (!runtimeIdentity || !directory || !machineId) return null;

  const baseOptions: SpawnSessionOptions = {
    existingSessionId: params.sessionId,
    machineId,
    directory,
    backendTarget: runtimeIdentity.backendTarget,
    approvedNewDirectoryCreation: true,
    ...(runtimeIdentity.agentRuntimeDescriptorV1
      ? { agentRuntimeDescriptorV1: runtimeIdentity.agentRuntimeDescriptorV1 }
      : {}),
  };

  const resolved = resolveSessionRuntimeSnapshot({
    incomingOptions: baseOptions,
    persistedMetadata: params.metadata,
  }).spawnOptions;

  // Snapshot resolution deliberately strips request-scoped controls so they
  // cannot enter persisted spawn state. Reattach only the fresh controls from
  // this explicit invocation after canonical snapshot composition.
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
