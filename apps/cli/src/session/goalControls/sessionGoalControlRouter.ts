import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import { SessionWorkStateV1Schema as SessionStateWorkStateValueSchema } from '@happier-dev/protocol/sessions/work/state/sessionWorkStateV1';
import type { SessionGoalSetRequestV1 } from '@happier-dev/protocol';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';

import { resolveInactiveSessionGoalControls } from '@/agent/catalog/sessionControlAdapters';
import type { CatalogAgentId } from '@/agent/catalog/ids';
import type { StoredCredentials } from '@/persistence';
import {
  resolveMachineControlLocalityProof,
  resolveSessionMachineWorkspacePath,
} from '@/session/machineControlLocality';
import { splitDurableRegisteredSessionStateMetadata } from '@/agent/runtime/registry/pluginMetadataDurability';
import type { DaemonWorkStateFieldMutation } from '@/api/session/client/transport/mutations/sessionClientDurableMutationTypes';
import type { SessionStoredContentCryptoContext } from '@/session/transport/encryption/sessionEncryptionContext';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import type {
  ResolveSessionGoalControlAdapter,
  SessionGoalControlAdapterParams,
  SessionGoalControlOperation,
} from './sessionGoalControlTypes';

type RouteSessionGoalControlParams = Readonly<{
  token: string;
  credentials?: StoredCredentials;
  sessionId: string;
  rawSession: RawSessionRecord;
  metadata: Record<string, unknown> | null;
  currentMachineId: string | null;
  currentMachineHost?: string | null;
  currentMachineHomeDir?: string | null;
  operation: SessionGoalControlOperation;
  request?: SessionGoalSetRequestV1;
  callLiveSessionRpc: () => Promise<unknown>;
  resolveAdapter?: ResolveSessionGoalControlAdapter;
  stageWorkStateMutation?: (mutation: DaemonWorkStateFieldMutation) => Promise<void>;
}> & SessionStoredContentCryptoContext;

function stableError(errorCode: string): Readonly<{ ok: false; errorCode: string; error: string }> {
  return { ok: false, errorCode, error: errorCode };
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveRawSessionString(rawSession: RawSessionRecord, key: 'path' | 'machineId' | 'host' | 'homeDir'): string | null {
  return readString((rawSession as Partial<Record<typeof key, unknown>>)[key]);
}

function resolveSessionMachineHost(
  metadata: Record<string, unknown>,
  rawSession: RawSessionRecord,
): string | null {
  return readString(metadata.host) ?? resolveRawSessionString(rawSession, 'host');
}

function resolveSessionMachineHomeDir(
  metadata: Record<string, unknown>,
  rawSession: RawSessionRecord,
): string | null {
  return readString(metadata.homeDir) ?? resolveRawSessionString(rawSession, 'homeDir');
}

function resolveAgentId(metadata: Record<string, unknown>): CatalogAgentId | null {
  return resolveAgentIdFromSessionMetadata(metadata);
}

function buildAdapterParams(
  params: RouteSessionGoalControlParams,
  metadata: Record<string, unknown>,
  sessionMachineId: string,
): SessionGoalControlAdapterParams {
  const base = {
    token: params.token,
    ...(params.credentials ? { credentials: params.credentials } : {}),
    sessionId: params.sessionId,
    rawSession: params.rawSession,
    metadata,
    currentMachineId: params.currentMachineId,
    sessionMachineId,
    cwd: resolveSessionMachineWorkspacePath({
      metadata,
      currentMachineId: params.currentMachineId,
      candidatePath: resolveRawSessionString(params.rawSession, 'path') ?? readString(metadata.path),
    }),
  } as const;
  return params.mode === 'plain'
    ? { ...base, mode: params.mode, ctx: params.ctx }
    : { ...base, mode: params.mode, ctx: params.ctx };
}

function readMetadataResult(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const metadata = (value as { metadata?: unknown }).metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  return metadata as Record<string, unknown>;
}

function shouldFallbackFromLiveSessionGoalRpc(result: unknown): boolean {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  const raw = result as Record<string, unknown>;
  const errorCode = typeof raw.errorCode === 'string' ? raw.errorCode : '';
  const error = typeof raw.error === 'string' ? raw.error : '';
  // Fall back to the inactive metadata adapter ONLY on DEFINITIVE capability signals — the live
  // runtime genuinely cannot serve the method. A transient TRANSPORT failure (`session_rpc_failed`,
  // produced when the live-session RPC throws) must NOT fall back: doing so seeds a decorative
  // `status:'active'` metadata goal the running session never started pursuing (`/goal` never
  // reached the provider) — a split-brain between metadata and runtime (G-4). Transport failures
  // surface as typed errors to the caller/UI instead, mirroring the `injectFailedError()` treatment.
  return errorCode === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE
    || errorCode === RPC_ERROR_CODES.METHOD_NOT_FOUND
    || errorCode === 'unsupported_session_runtime_method'
    || error === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE
    || error === RPC_ERROR_CODES.METHOD_NOT_FOUND
    || error === 'unsupported_session_runtime_method';
}

async function persistAdapterMetadataResult(
  params: RouteSessionGoalControlParams,
  result: unknown,
): Promise<unknown> {
  const nextMetadata = readMetadataResult(result);
  if (!nextMetadata || !Object.prototype.hasOwnProperty.call(nextMetadata, 'sessionWorkStateV1')) return result;
  if (nextMetadata.sessionWorkStateV1 !== null
    && !SessionStateWorkStateValueSchema.safeParse(nextMetadata.sessionWorkStateV1).success) {
    throw new Error('invalid_daemon_work_state_mutation');
  }
  const split = splitDurableRegisteredSessionStateMetadata({
    sessionId: params.sessionId,
    current: params.metadata,
    candidate: nextMetadata,
    source: 'daemon',
  });
  const mutations = split.mutations.filter((mutation): mutation is DaemonWorkStateFieldMutation =>
    mutation.fieldId === 'runtime.workState' && mutation.source === 'daemon' && mutation.deliveryClass === 'durable_required');
  if (mutations.length === 0) return result;
  if (!params.stageWorkStateMutation) return stableError('session_goal_control_work_state_custody_unavailable');
  for (const mutation of mutations) await params.stageWorkStateMutation(mutation);
  return result;
}

export async function routeSessionGoalControl(params: RouteSessionGoalControlParams): Promise<unknown> {
  if (params.rawSession.active === true) {
    const liveResult = await params.callLiveSessionRpc();
    if (!shouldFallbackFromLiveSessionGoalRpc(liveResult)) {
      return liveResult;
    }
  }

  const metadata = params.metadata;
  if (!metadata) {
    return stableError('session_goal_control_metadata_unavailable');
  }

  const currentMachineId = readString(params.currentMachineId);
  if (!currentMachineId) {
    return stableError('session_goal_control_current_machine_unknown');
  }

  const sessionMachineId = readString(metadata.machineId) ?? resolveRawSessionString(params.rawSession, 'machineId');
  if (!sessionMachineId) {
    return stableError('session_goal_control_session_machine_unknown');
  }
  if (
    !await resolveMachineControlLocalityProof({
      sessionMachineId,
      currentMachineId,
      sessionHost: resolveSessionMachineHost(metadata, params.rawSession),
      sessionHomeDir: resolveSessionMachineHomeDir(metadata, params.rawSession),
      currentMachineHost: params.currentMachineHost,
      currentMachineHomeDir: params.currentMachineHomeDir,
      credentials: { token: params.token },
    })
  ) {
    return stableError('session_goal_control_remote_unavailable');
  }

  const resolveAdapter = params.resolveAdapter ?? resolveInactiveSessionGoalControls;
  const adapter = await resolveAdapter(resolveAgentId(metadata));
  if (!adapter) {
    return stableError('session_goal_control_unsupported');
  }

  const adapterParams = buildAdapterParams(params, metadata, sessionMachineId);
  let result: unknown;
  if (params.operation === 'get') {
    result = typeof adapter.getGoal === 'function'
      ? await adapter.getGoal(adapterParams)
      : stableError('session_goal_control_unsupported');
    return await persistAdapterMetadataResult(params, result);
  }
  if (params.operation === 'clear') {
    result = typeof adapter.clearGoal === 'function'
      ? await adapter.clearGoal(adapterParams)
      : stableError('session_goal_control_unsupported');
    return await persistAdapterMetadataResult(params, result);
  }
  if (!params.request || typeof adapter.setGoal !== 'function') {
    return stableError('session_goal_control_unsupported');
  }
  result = await adapter.setGoal({
    ...adapterParams,
    request: params.request,
  });
  return await persistAdapterMetadataResult(params, result);
}
