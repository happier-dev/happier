import {
  SPAWN_SESSION_ERROR_CODES,
  normalizeSpawnSessionNonceResolution,
  type BackendTargetRefV2,
  type SessionModelSelectionV1,
  type SpawnSessionNonceResolution,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { isRpcMethodNotAvailableError, isRpcMethodNotFoundError } from '@happier-dev/protocol/rpcErrors';
import { randomUUID } from 'node:crypto';

import { createAuthenticationHttpStatusError, isAuthenticationStatus } from '@/api/client/httpStatusError';
import { validateStoredAuthTokenAgainstActiveServer } from '@/auth/validateStoredAuthTokenAgainstActiveServer';
import { resolveDaemonSpawnSessionByNonce, spawnDaemonSession } from '@/daemon/controlClient';
import { createPendingFirstInput } from '@/daemon/spawn/pendingFirstInput';
import type { Credentials } from '@/persistence';
import { SpawnDaemonSessionRequestSchema } from '@/rpc/handlers/spawnSessionOptionsContract';
import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';
import { updateSessionMetadataWithRetry } from '@/session/metadata/updateSessionMetadataWithRetry';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import { callMachineRpc } from '@/session/transport/rpc/machineRpc';
import { summarizeSessionRecord, type SessionSummary } from '@/cli/output/session/sessionSummary';
import { delay } from '@/utils/time';
import { updateSessionStateFieldForTarget } from './updateSessionStateFieldForTarget';
import { abandonSpawnedSessionBestEffort, awaitSpawnedSessionId } from './awaitSpawnedSessionId';
import { archiveSessionOnceInactive } from './archiveSessionOnceInactive';
import { requestSessionStop } from './requestSessionStop';

export type CreateSpawnedSessionParams = Readonly<{
  credentials: Credentials;
  directory: string;
  machineId?: string;
  backendTarget: BackendTargetRefV2;
  modelSelection?: SessionModelSelectionV1;
  title?: string;
  tag?: string;
  initialMessage?: string;
  /** Stable caller-owned identity for one launch attempt. */
  spawnNonce?: string;
  /** Resolve an already-submitted launch attempt without sending another spawn. */
  resumeOnly?: boolean;
} & Partial<Pick<
  SpawnSessionOptions,
  | 'permissionMode'
  | 'permissionModeUpdatedAt'
  | 'agentModeId'
  | 'agentModeUpdatedAt'
  | 'accountSettingsVersionHint'
  | 'initialTranscriptAfterSeq'
  | 'executionAuthorization'
  | 'sessionConfigOptionOverrides'
  | 'profileId'
  | 'environmentVariables'
  | 'connectedServices'
  | 'connectedServicesUpdatedAt'
  | 'mcpSelection'
  | 'transcriptStorage'
  | 'terminal'
  | 'windowsRemoteSessionLaunchMode'
  | 'windowsRemoteSessionConsole'
  | 'windowsTerminalWindowName'
  | 'runtimeDescriptorV1'
  | 'backendMode'
  | 'codexBackendMode'
>>>;

const DEFAULT_SPAWNED_SESSION_FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_SPAWNED_SESSION_FETCH_POLL_INTERVAL_MS = 200;
const SPAWN_TRANSIENT_ERROR_MARKERS = [
  'Request failed: /spawn-session, The socket connection was closed unexpectedly',
] as const;

function resolvePositiveIntFromEnv(key: string, fallback: number): number {
  const raw = String(process.env[key] ?? '').trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

async function waitForSpawnedSessionVisibility(params: Readonly<{
  token: string;
  sessionId: string;
  timeoutMs: number;
  pollIntervalMs: number;
}>): Promise<Awaited<ReturnType<typeof fetchSessionById>> | null> {
  const deadlineMs = Date.now() + params.timeoutMs;
  let attempt = 0;
  while (true) {
    attempt += 1;
    const session = await fetchSessionById({ token: params.token, sessionId: params.sessionId });
    if (session) return session;
    if (Date.now() >= deadlineMs) return null;
    // Avoid tight loops when callers set absurdly low env overrides.
    await delay(Math.max(25, params.pollIntervalMs));
  }
}

function isTransientSpawnFailure(spawnResponse: unknown): boolean {
  if (!spawnResponse || typeof spawnResponse !== 'object') return false;
  if (
    (spawnResponse as { errorCode?: unknown }).errorCode
    === SPAWN_SESSION_ERROR_CODES.CHILD_EXITED_BEFORE_WEBHOOK
  ) {
    return false;
  }
  if (
    (spawnResponse as { status?: unknown }).status === 'pending'
    && (spawnResponse as { errorCode?: unknown }).errorCode === SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT
  ) {
    return true;
  }
  const message = typeof (spawnResponse as { error?: unknown }).error === 'string'
    ? (spawnResponse as { error: string }).error
    : '';
  if (!message) return false;
  return SPAWN_TRANSIENT_ERROR_MARKERS.some((marker) => message.includes(marker));
}

async function assertStoredAuthTokenValidForSpawn(token: string): Promise<void> {
  const validation = await validateStoredAuthTokenAgainstActiveServer(token);
  if (validation.state !== 'invalid') return;

  const status = isAuthenticationStatus(validation.httpStatus) ? validation.httpStatus : 401;
  throw createAuthenticationHttpStatusError(status, `Authentication failed before spawning session (${status})`);
}

function isAcceptedPendingSpawn(spawnResponse: unknown): boolean {
  if (!spawnResponse || typeof spawnResponse !== 'object') return false;
  if ((spawnResponse as { success?: unknown }).success !== true) return false;
  return (spawnResponse as { status?: unknown }).status === 'pending'
    || (spawnResponse as { sessionIdStatus?: unknown }).sessionIdStatus === 'pending';
}

function readSpawnResponseRecord(spawnResponse: unknown): Readonly<Record<string, unknown>> | null {
  return spawnResponse !== null && typeof spawnResponse === 'object' && !Array.isArray(spawnResponse)
    ? spawnResponse as Readonly<Record<string, unknown>>
    : null;
}

function createCodedError(message: string, code: string, details?: unknown): Error {
  const error = new Error(message);
  (error as { code?: string }).code = code;
  if (details !== undefined) {
    (error as { details?: unknown }).details = details;
  }
  return error;
}

export async function createSpawnedSession(
  params: CreateSpawnedSessionParams,
): Promise<Readonly<{ created: true; sessionId: string; session: SessionSummary }>> {
  const callerOwnedSpawnNonce = typeof params.spawnNonce === 'string' && params.spawnNonce.trim().length > 0
    ? params.spawnNonce.trim()
    : null;
  const spawnNonce = callerOwnedSpawnNonce ?? randomUUID();
  const spawnRequest = SpawnDaemonSessionRequestSchema.parse({
    directory: params.directory,
    spawnNonce,
    ...(params.machineId ? { machineId: params.machineId } : {}),
    backendTarget: params.backendTarget,
    ...(params.modelSelection ? { modelSelection: params.modelSelection } : {}),
    ...(params.permissionMode ? { permissionMode: params.permissionMode } : {}),
    ...(typeof params.permissionModeUpdatedAt === 'number' && Number.isFinite(params.permissionModeUpdatedAt)
      ? { permissionModeUpdatedAt: params.permissionModeUpdatedAt }
      : {}),
    ...(params.agentModeId ? { agentModeId: params.agentModeId } : {}),
    ...(typeof params.agentModeUpdatedAt === 'number' && Number.isFinite(params.agentModeUpdatedAt)
      ? { agentModeUpdatedAt: params.agentModeUpdatedAt }
      : {}),
    ...(typeof params.accountSettingsVersionHint === 'number' && Number.isFinite(params.accountSettingsVersionHint)
      ? { accountSettingsVersionHint: params.accountSettingsVersionHint }
      : {}),
    ...(typeof params.initialTranscriptAfterSeq === 'number' && Number.isFinite(params.initialTranscriptAfterSeq)
      ? { initialTranscriptAfterSeq: params.initialTranscriptAfterSeq }
      : {}),
    ...(params.executionAuthorization ? { executionAuthorization: params.executionAuthorization } : {}),
    ...(params.sessionConfigOptionOverrides ? { sessionConfigOptionOverrides: params.sessionConfigOptionOverrides } : {}),
    ...(typeof params.initialMessage === 'string' && params.initialMessage.trim().length > 0
      ? { pendingFirstInput: createPendingFirstInput({ text: params.initialMessage, spawnNonce }) }
      : {}),
    ...(typeof params.profileId === 'string' ? { profileId: params.profileId } : {}),
    ...(params.environmentVariables ? { environmentVariables: params.environmentVariables } : {}),
    ...(params.connectedServices ? { connectedServices: params.connectedServices } : {}),
    ...(typeof params.connectedServicesUpdatedAt === 'number' && Number.isFinite(params.connectedServicesUpdatedAt)
      ? { connectedServicesUpdatedAt: params.connectedServicesUpdatedAt }
      : {}),
    ...(params.mcpSelection ? { mcpSelection: params.mcpSelection } : {}),
    ...(params.transcriptStorage ? { transcriptStorage: params.transcriptStorage } : {}),
    ...(params.terminal ? { terminal: params.terminal } : {}),
    ...(params.windowsRemoteSessionLaunchMode ? { windowsRemoteSessionLaunchMode: params.windowsRemoteSessionLaunchMode } : {}),
    ...(params.windowsRemoteSessionConsole ? { windowsRemoteSessionConsole: params.windowsRemoteSessionConsole } : {}),
    ...(params.windowsTerminalWindowName ? { windowsTerminalWindowName: params.windowsTerminalWindowName } : {}),
    ...(params.runtimeDescriptorV1 ? { runtimeDescriptorV1: params.runtimeDescriptorV1 } : {}),
    ...(params.backendMode ? { backendMode: params.backendMode } : {}),
    ...(params.codexBackendMode ? { codexBackendMode: params.codexBackendMode } : {}),
  });
  const providerMachineId = spawnRequest.modelSelection?.ref.providerConnectionId != null
    ? (typeof spawnRequest.machineId === 'string' ? spawnRequest.machineId.trim() : '')
    : null;
  if (providerMachineId !== null && !providerMachineId) {
    throw createCodedError(
      'Provider-bound session creation requires an exact machine target',
      SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
    );
  }
  await assertStoredAuthTokenValidForSpawn(params.credentials.token);
  let spawnResponse: unknown;
  if (params.resumeOnly === true) {
    spawnResponse = { success: true as const, status: 'pending' as const, sessionIdStatus: 'pending' as const, spawnNonce };
  } else if (providerMachineId !== null) {
    try {
      spawnResponse = await callMachineRpc({
        credentials: params.credentials,
        machineId: providerMachineId,
        method: RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
        request: spawnRequest,
      });
    } catch (error) {
      if (isRpcMethodNotAvailableError(error) || isRpcMethodNotFoundError(error)) {
        throw createCodedError(
          'Provider-bound session creation is unavailable because the selected machine does not support this request',
          SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
        );
      }
      if (error && typeof error === 'object' && (error as { code?: unknown }).code === 'MACHINE_RPC_TIMEOUT') {
        (error as { details?: unknown }).details = { spawnNonce };
      }
      throw error;
    }
  } else {
    spawnResponse = await spawnDaemonSession(spawnRequest);
  }
  const resolveSpawnSessionByNonce = providerMachineId === null
    ? resolveDaemonSpawnSessionByNonce
    : async (nonce: string): Promise<SpawnSessionNonceResolution> => {
      try {
        return normalizeSpawnSessionNonceResolution(await callMachineRpc({
          credentials: params.credentials,
          machineId: providerMachineId,
          method: RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE,
          request: { spawnNonce: nonce },
        }));
      } catch (error) {
        if (isRpcMethodNotAvailableError(error) || isRpcMethodNotFoundError(error)) {
          return { status: 'unsupported' };
        }
        throw error;
      }
    };
  const spawnResponseRecord = readSpawnResponseRecord(spawnResponse);
  const directSessionId = typeof spawnResponseRecord?.sessionId === 'string'
    ? spawnResponseRecord.sessionId.trim()
    : '';
  const acceptedWithoutSessionId = isAcceptedPendingSpawn(spawnResponse)
    || isTransientSpawnFailure(spawnResponse)
    || (spawnResponseRecord?.type === 'success' && !directSessionId);
  const hasDirectSessionId = (spawnResponseRecord?.success === true || spawnResponseRecord?.type === 'success')
    && directSessionId.length > 0;
  if (!acceptedWithoutSessionId && !hasDirectSessionId) {
    const responseError = typeof spawnResponseRecord?.errorMessage === 'string' && spawnResponseRecord.errorMessage.trim().length > 0
      ? spawnResponseRecord.errorMessage
      : typeof spawnResponseRecord?.error === 'string' && spawnResponseRecord.error.trim().length > 0
        ? spawnResponseRecord.error
        : 'Failed to spawn session';
    throw createCodedError(
      responseError,
      spawnResponseRecord?.requiresUserApproval === true || spawnResponseRecord?.type === 'requestToApproveDirectoryCreation'
        ? 'conflict'
        : typeof spawnResponseRecord?.errorCode === 'string' && spawnResponseRecord.errorCode.trim().length > 0
          ? spawnResponseRecord.errorCode
          : 'unknown_error',
      spawnResponse ?? null,
    );
  }
  const settledSpawn = await awaitSpawnedSessionId({
    result: acceptedWithoutSessionId
      ? { type: 'success', spawnNonce, sessionIdStatus: 'pending' }
      : spawnResponse,
    spawnNonce,
    resolveSpawnSessionByNonce,
  });
  if (settledSpawn.type === 'error') {
    if (
      acceptedWithoutSessionId
      && !callerOwnedSpawnNonce
      && params.resumeOnly !== true
      && settledSpawn.errorCode !== SPAWN_SESSION_ERROR_CODES.UNEXPECTED
    ) {
      abandonSpawnedSessionBestEffort({
        spawnNonce,
        reason: settledSpawn.errorMessage,
        resolveSpawnSessionByNonce,
        stopSession: async (sessionId) => {
          const stopped = await requestSessionStop({ credentials: params.credentials, idOrPrefix: sessionId });
          return stopped.ok && stopped.stopped;
        },
        archiveSession: async (sessionId) => {
          await archiveSessionOnceInactive({ token: params.credentials.token, sessionId });
        },
      });
    }
    const error = new Error(
      settledSpawn.errorMessage
      || (typeof spawnResponseRecord?.error === 'string' && spawnResponseRecord.error.trim().length > 0
        ? spawnResponseRecord.error
        : 'Failed to spawn session'),
    );
    (error as { code?: string }).code = settledSpawn.errorCode;
    (error as { details?: unknown }).details = {
      spawnResponse: spawnResponse ?? null,
      ...(acceptedWithoutSessionId ? { spawnNonce } : {}),
    };
    throw error;
  }
  const sessionId = settledSpawn.sessionId;

  const fetchTimeoutMs = resolvePositiveIntFromEnv('HAPPIER_SESSION_SPAWN_FETCH_TIMEOUT_MS', DEFAULT_SPAWNED_SESSION_FETCH_TIMEOUT_MS);
  const pollIntervalMs = resolvePositiveIntFromEnv('HAPPIER_SESSION_SPAWN_FETCH_POLL_INTERVAL_MS', DEFAULT_SPAWNED_SESSION_FETCH_POLL_INTERVAL_MS);
  let rawSession = await waitForSpawnedSessionVisibility({
    token: params.credentials.token,
    sessionId,
    timeoutMs: fetchTimeoutMs,
    pollIntervalMs,
  });
  if (!rawSession) {
    const error = new Error(`Timed out waiting for spawned session ${sessionId} to appear on the server`);
    (error as { code?: string }).code = 'timeout';
    (error as { details?: unknown }).details = { sessionId, timeoutMs: fetchTimeoutMs };
    throw error;
  }

  const normalizedTitle = typeof params.title === 'string' ? params.title.trim() : '';
  const normalizedTag = typeof params.tag === 'string' ? params.tag.trim() : '';
  if (normalizedTag) {
    await updateSessionMetadataWithRetry({
      token: params.credentials.token,
      credentials: params.credentials,
      sessionId,
      rawSession,
      updater: (metadata) => {
        return {
          ...metadata,
          tag: normalizedTag,
        };
      },
    });
  }

  if (normalizedTitle) {
    const result = await updateSessionStateFieldForTarget({
      credentials: params.credentials,
      idOrPrefix: sessionId,
      fieldId: 'display.title',
      value: {
        title: normalizedTitle,
        staleBehavior: 'bump-if-value-changed',
      },
      metadataReason: 'spawned-session-title',
    });
    if (!result.ok) {
      const error = new Error(`Failed to update spawned session title: ${result.code}`);
      (error as { code?: string }).code = result.code;
      (error as { details?: unknown }).details = { sessionId, stage: 'title_update' };
      throw error;
    }
  }

  if (normalizedTitle || normalizedTag) {
    rawSession = await waitForSpawnedSessionVisibility({
      token: params.credentials.token,
      sessionId,
      timeoutMs: fetchTimeoutMs,
      pollIntervalMs,
    });
    if (!rawSession) {
      const error = new Error(`Timed out waiting for spawned session ${sessionId} after metadata update`);
      (error as { code?: string }).code = 'timeout';
      (error as { details?: unknown }).details = { sessionId, timeoutMs: fetchTimeoutMs, stage: 'metadata_update' };
      throw error;
    }
  }

  return {
    created: true,
    sessionId,
    session: summarizeSessionRecord({ credentials: params.credentials, session: rawSession }),
  };
}
