import {
  SPAWN_SESSION_ERROR_CODES,
  type SpawnSessionErrorCode,
  type SpawnSessionNonceResolution,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { buildInactiveSessionResumeSpawnOptions } from '@/daemon/sessions/runtimeSnapshot/buildInactiveSessionResumeSpawnOptions';
import type { Credentials } from '@/persistence';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { callMachineRpc } from '@/session/transport/rpc/machineRpc';
import { awaitSpawnedSessionId } from './awaitSpawnedSessionId';

export type InactiveSessionResumeResult =
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false;
      code: 'session_archived' | 'unsupported' | 'timeout';
      message: string;
    }>;

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readSpawnSessionNonceResolution(value: unknown): SpawnSessionNonceResolution {
  if (!value || typeof value !== 'object') return { status: 'unsupported' };
  const record = value as Record<string, unknown>;
  if (record.status === 'success') {
    const sessionId = readNonEmptyString(record.sessionId);
    return sessionId ? { status: 'success', sessionId } : { status: 'pending' };
  }
  if (record.status === 'pending' || record.status === 'not_found' || record.status === 'unsupported') {
    return { status: record.status };
  }
  if (record.status === 'error') {
    const errorCode = readNonEmptyString(record.errorCode);
    const errorMessage = readNonEmptyString(record.errorMessage);
    if (
      errorCode
      && errorMessage
      && (Object.values(SPAWN_SESSION_ERROR_CODES) as string[]).includes(errorCode)
    ) {
      return {
        status: 'error',
        errorCode: errorCode as SpawnSessionErrorCode,
        errorMessage,
      };
    }
  }
  return { status: 'unsupported' };
}

function buildMachineResumeRequest(
  options: NonNullable<ReturnType<typeof buildInactiveSessionResumeSpawnOptions>>,
  spawnNonce?: string,
) {
  return {
    type: 'resume-session' as const,
    sessionId: options.existingSessionId,
    directory: options.directory,
    backendTarget: options.backendTarget,
    ...(spawnNonce ? { spawnNonce } : {}),
    ...(options.resume ? { resume: options.resume } : {}),
    ...(options.agentRuntimeDescriptorV1 ? { agentRuntimeDescriptorV1: options.agentRuntimeDescriptorV1 } : {}),
    ...(options.connectedServices ? { connectedServices: options.connectedServices } : {}),
    ...(typeof options.connectedServicesUpdatedAt === 'number'
      ? { connectedServicesUpdatedAt: options.connectedServicesUpdatedAt }
      : {}),
    ...(options.transcriptStorage ? { transcriptStorage: options.transcriptStorage } : {}),
    ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
    ...(typeof options.permissionModeUpdatedAt === 'number'
      ? { permissionModeUpdatedAt: options.permissionModeUpdatedAt }
      : {}),
    ...(options.agentModeId ? { agentModeId: options.agentModeId } : {}),
    ...(typeof options.agentModeUpdatedAt === 'number' ? { agentModeUpdatedAt: options.agentModeUpdatedAt } : {}),
    ...(options.modelId ? { modelId: options.modelId } : {}),
    ...(typeof options.modelUpdatedAt === 'number' ? { modelUpdatedAt: options.modelUpdatedAt } : {}),
    ...(typeof options.initialTranscriptAfterSeq === 'number'
      ? { initialTranscriptAfterSeq: options.initialTranscriptAfterSeq }
      : {}),
    ...(options.executionAuthorization ? { executionAuthorization: options.executionAuthorization } : {}),
  };
}

/**
 * Explicit CLI-user-action seam for inactive parent-session delivery.
 * Persisted queue/usage/marker reconstruction has no reference to this service.
 */
export async function requestInactiveSessionResume(params: Readonly<{
  credentials: Credentials;
  sessionId: string;
  localId: string;
  rawSession: RawSessionRecord;
  metadata: Record<string, unknown>;
  timeoutMs?: number;
  waitForReady?: boolean;
}>): Promise<InactiveSessionResumeResult> {
  const archivedAt = (params.rawSession as { archivedAt?: unknown }).archivedAt;
  if (archivedAt !== null && archivedAt !== undefined) {
    return {
      ok: false,
      code: 'session_archived',
      message: 'Archived sessions must be unarchived before resume',
    };
  }
  const rawSessionId = readNonEmptyString(params.rawSession.id);
  if (!rawSessionId || rawSessionId !== params.sessionId) {
    return {
      ok: false,
      code: 'unsupported',
      message: 'Inactive session identity is inconsistent; pending custody was retained',
    };
  }
  const rawMachineId = readNonEmptyString(params.rawSession.machineId);
  const metadataMachineId = readNonEmptyString(params.metadata.machineId);
  if (rawMachineId && metadataMachineId && rawMachineId !== metadataMachineId) {
    return {
      ok: false,
      code: 'unsupported',
      message: 'Inactive session machine identity is inconsistent; pending custody was retained',
    };
  }
  const machineId = rawMachineId ?? metadataMachineId;
  if (!machineId) {
    return {
      ok: false,
      code: 'unsupported',
      message: 'Inactive session has no exact machine target; pending custody was retained',
    };
  }

  const options = buildInactiveSessionResumeSpawnOptions({
    sessionId: params.sessionId,
    rawSession: params.rawSession,
    metadata: params.metadata,
    executionAuthorization: {
      provenance: 'user_request',
      requestId: params.localId,
    },
    ...(typeof params.rawSession.seq === 'number' ? { initialTranscriptAfterSeq: params.rawSession.seq } : {}),
  });
  if (!options || options.machineId !== machineId || !options.backendTarget) {
    return {
      ok: false,
      code: 'unsupported',
      message: 'Inactive session resume identity is incomplete; pending custody was retained',
    };
  }

  const startedAtMs = Date.now();
  const readinessSpawnNonce = params.waitForReady === true
    ? `inactive-session.resume:${params.sessionId}:${params.localId}`
    : undefined;

  try {
    const response = await callMachineRpc({
      credentials: params.credentials,
      machineId,
      method: RPC_METHODS.SPAWN_HAPPY_SESSION,
      request: buildMachineResumeRequest(options, readinessSpawnNonce),
      ...(params.timeoutMs ? { timeoutMs: params.timeoutMs } : {}),
    });
    const responseSessionId = response && typeof response === 'object'
      ? readNonEmptyString((response as { sessionId?: unknown }).sessionId)
      : null;
    if (
      !response
      || typeof response !== 'object'
      || (response as { type?: unknown }).type !== 'success'
      || responseSessionId !== params.sessionId
    ) {
      const message = response && typeof response === 'object' && typeof (response as { errorMessage?: unknown }).errorMessage === 'string'
        ? (response as { errorMessage: string }).errorMessage
        : 'Inactive session resume was rejected; pending custody was retained';
      return { ok: false, code: 'unsupported', message };
    }
    if (!readinessSpawnNonce) {
      return { ok: true };
    }

    const remainingTimeoutMs = typeof params.timeoutMs === 'number'
      ? Math.max(0, params.timeoutMs - (Date.now() - startedAtMs))
      : undefined;
    if (remainingTimeoutMs === 0) {
      return {
        ok: false,
        code: 'timeout',
        message: 'Timed out waiting for the inactive session to become ready',
      };
    }
    const ready = await awaitSpawnedSessionId({
      result: {
        type: 'success',
        sessionIdStatus: 'pending',
        spawnNonce: readinessSpawnNonce,
      },
      resolveSpawnSessionByNonce: async (nonce, remainingTimeoutMs) => readSpawnSessionNonceResolution(
        await callMachineRpc({
          credentials: params.credentials,
          machineId,
          method: RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE,
          request: { spawnNonce: nonce },
          ...(typeof remainingTimeoutMs === 'number' ? { timeoutMs: remainingTimeoutMs } : {}),
        }),
      ),
      ...(typeof remainingTimeoutMs === 'number' ? { timeoutMs: remainingTimeoutMs } : {}),
    });
    if (ready.type !== 'success' || ready.sessionId !== params.sessionId) {
      return {
        ok: false,
        code: ready.type === 'error' && ready.errorCode === SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT
          ? 'timeout'
          : 'unsupported',
        message: ready.type === 'error'
          ? ready.errorMessage
          : 'Inactive session readiness resolved to a different session',
      };
    }
    return { ok: true };
  } catch (error) {
    const errorCode = error && typeof error === 'object' ? (error as { code?: unknown }).code : null;
    const message = error instanceof Error ? error.message : 'Inactive session resume failed; pending custody was retained';
    return {
      ok: false,
      code: errorCode === 'MACHINE_RPC_TIMEOUT' ? 'timeout' : 'unsupported',
      message,
    };
  }
}
