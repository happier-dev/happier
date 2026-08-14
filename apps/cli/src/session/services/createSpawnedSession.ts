import type {
  AcpConfigOptionOverridesV1,
  BackendTargetRefV1,
  ConnectedServiceBindingsV1,
  SessionMcpSelectionV1,
} from '@happier-dev/protocol';
import { randomUUID } from 'node:crypto';
import { createPendingFirstInput } from '@/daemon/spawn/pendingFirstInput';

import { resolveDaemonSpawnSessionByNonce, spawnDaemonSession } from '@/daemon/controlClient';
import type { Credentials } from '@/persistence';
import { SPAWN_SESSION_ERROR_CODES } from '@/rpc/handlers/registerSessionHandlers';
import { SpawnDaemonSessionRequestSchema, type SpawnDaemonSessionRequest } from '@/rpc/handlers/spawnSessionOptionsContract';
import { updateSessionMetadataWithRetry } from '@/session/metadata/updateSessionMetadataWithRetry';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import { summarizeSessionRecord, type SessionSummary } from '@/cli/output/session/sessionSummary';
import { delay } from '@/utils/time';
import { abandonSpawnedSessionBestEffort, awaitSpawnedSessionId } from './awaitSpawnedSessionId';
import { requestSessionStop } from './requestSessionStop';
import { archiveSessionByIdBestEffort } from './setSessionArchivedState';

export type CreateSpawnedSessionParams = Readonly<{
  credentials: Credentials;
  directory: string;
  machineId?: string;
  backendTarget: BackendTargetRefV1;
  modelId?: string;
  modelUpdatedAt?: number;
  permissionMode?: string;
  permissionModeUpdatedAt?: number;
  agentModeId?: string;
  agentModeUpdatedAt?: number;
  sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1;
  title?: string;
  tag?: string;
  initialMessage?: string;
  profileId?: string;
  environmentVariables?: Record<string, string>;
  connectedServices?: ConnectedServiceBindingsV1;
  connectedServicesUpdatedAt?: number;
  mcpSelection?: SessionMcpSelectionV1;
  transcriptStorage?: 'persisted' | 'direct';
  terminal?: SpawnDaemonSessionRequest['terminal'];
  windowsRemoteSessionLaunchMode?: SpawnDaemonSessionRequest['windowsRemoteSessionLaunchMode'];
  windowsRemoteSessionConsole?: SpawnDaemonSessionRequest['windowsRemoteSessionConsole'];
  windowsTerminalWindowName?: string;
  codexBackendMode?: SpawnDaemonSessionRequest['codexBackendMode'];
  agentRuntimeDescriptorV1?: SpawnDaemonSessionRequest['agentRuntimeDescriptorV1'];
  approvedNewDirectoryCreation?: boolean;
  /** Stable caller-owned identity for one launch attempt. */
  spawnNonce?: string;
  /** Resolve an already-submitted launch attempt without sending another spawn. */
  resumeOnly?: boolean;
}>;

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
    (spawnResponse as { status?: unknown }).status === 'pending' &&
    (spawnResponse as { errorCode?: unknown }).errorCode === SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT
  ) {
    return true;
  }
  const message = typeof (spawnResponse as { error?: unknown }).error === 'string'
    ? (spawnResponse as { error: string }).error
    : '';
  if (!message) return false;
  return SPAWN_TRANSIENT_ERROR_MARKERS.some((marker) => message.includes(marker));
}

function isAcceptedPendingSpawn(spawnResponse: unknown): boolean {
  if (!spawnResponse || typeof spawnResponse !== 'object') return false;
  if ((spawnResponse as { success?: unknown }).success !== true) return false;
  return (spawnResponse as { status?: unknown }).status === 'pending'
    || (spawnResponse as { sessionIdStatus?: unknown }).sessionIdStatus === 'pending';
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
    ...(params.permissionMode ? { permissionMode: params.permissionMode } : {}),
    ...(typeof params.permissionModeUpdatedAt === 'number' && Number.isFinite(params.permissionModeUpdatedAt)
      ? { permissionModeUpdatedAt: params.permissionModeUpdatedAt }
      : {}),
    ...(params.agentModeId ? { agentModeId: params.agentModeId } : {}),
    ...(typeof params.agentModeUpdatedAt === 'number' && Number.isFinite(params.agentModeUpdatedAt)
      ? { agentModeUpdatedAt: params.agentModeUpdatedAt }
      : {}),
    ...(params.modelId
      ? {
          modelId: params.modelId,
          modelUpdatedAt: typeof params.modelUpdatedAt === 'number' && Number.isFinite(params.modelUpdatedAt)
            ? params.modelUpdatedAt
            : Date.now(),
        }
      : {}),
    ...(params.sessionConfigOptionOverrides ? { sessionConfigOptionOverrides: params.sessionConfigOptionOverrides } : {}),
    ...(typeof params.initialMessage === 'string' && params.initialMessage.trim().length > 0
      ? { pendingFirstInput: createPendingFirstInput({ text: params.initialMessage, spawnNonce }) }
      : {}),
    ...(params.profileId ? { profileId: params.profileId } : {}),
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
    ...(params.codexBackendMode ? { codexBackendMode: params.codexBackendMode } : {}),
    ...(params.agentRuntimeDescriptorV1 ? { agentRuntimeDescriptorV1: params.agentRuntimeDescriptorV1 } : {}),
    ...(typeof params.approvedNewDirectoryCreation === 'boolean'
      ? { approvedNewDirectoryCreation: params.approvedNewDirectoryCreation }
      : {}),
  });
  const spawnResponse = params.resumeOnly === true
    ? { success: true as const, status: 'pending' as const, sessionIdStatus: 'pending' as const, spawnNonce }
    : await spawnDaemonSession(spawnRequest);
  const acceptedWithoutSessionId = isAcceptedPendingSpawn(spawnResponse) || isTransientSpawnFailure(spawnResponse);
  const hasDirectSessionId = spawnResponse?.success === true
    && typeof spawnResponse.sessionId === 'string'
    && spawnResponse.sessionId.trim().length > 0;
  if (!acceptedWithoutSessionId && !hasDirectSessionId) {
    const error = new Error(
      typeof spawnResponse?.error === 'string' && spawnResponse.error.trim().length > 0
        ? spawnResponse.error
        : 'Failed to spawn session',
    );
    (error as { code?: string }).code =
      spawnResponse?.requiresUserApproval === true
        ? 'conflict'
        : typeof spawnResponse?.errorCode === 'string' && spawnResponse.errorCode.trim().length > 0
          ? spawnResponse.errorCode
          : 'unknown_error';
    (error as { details?: unknown }).details = spawnResponse ?? null;
    throw error;
  }
  const settledSpawn = await awaitSpawnedSessionId({
    result: acceptedWithoutSessionId
      ? { type: 'success', sessionIdStatus: 'pending', spawnNonce }
      : spawnResponse,
    resolveSpawnSessionByNonce: resolveDaemonSpawnSessionByNonce,
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
        resolveSpawnSessionByNonce: resolveDaemonSpawnSessionByNonce,
        stopSession: async (sessionId) => {
          const stopped = await requestSessionStop({
            credentials: params.credentials,
            idOrPrefix: sessionId,
          });
          return stopped.ok && stopped.stopped;
        },
        archiveSession: async (sessionId) => {
          await archiveSessionByIdBestEffort({ token: params.credentials.token, sessionId });
        },
      });
    }
    const error = new Error(
      settledSpawn.errorMessage
      || (typeof spawnResponse?.error === 'string' && spawnResponse.error.trim().length > 0
        ? spawnResponse.error
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
  if (normalizedTitle || normalizedTag) {
    await updateSessionMetadataWithRetry({
      token: params.credentials.token,
      credentials: params.credentials,
      sessionId,
      rawSession,
      updater: (metadata) => ({
        ...metadata,
        ...(normalizedTag ? { tag: normalizedTag } : {}),
        ...(normalizedTitle
          ? {
              summary: {
                text: normalizedTitle,
                updatedAt: Date.now(),
              },
            }
          : {}),
      }),
    });

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
