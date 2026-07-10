import {
  SPAWN_SESSION_ERROR_CODES,
  type BackendTargetRefV2,
  type SessionModelSelectionV1,
} from '@happier-dev/protocol';
import { randomUUID } from 'node:crypto';

import { createAuthenticationHttpStatusError, isAuthenticationStatus } from '@/api/client/httpStatusError';
import { validateStoredAuthTokenAgainstActiveServer } from '@/auth/validateStoredAuthTokenAgainstActiveServer';
import { resolveDaemonSpawnSessionByNonce, spawnDaemonSession } from '@/daemon/controlClient';
import type { Credentials } from '@/persistence';
import { SpawnDaemonSessionRequestSchema } from '@/rpc/handlers/spawnSessionOptionsContract';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import { updateSessionMetadataWithRetry } from '@/session/metadata/updateSessionMetadataWithRetry';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import { summarizeSessionRecord, type SessionSummary } from '@/cli/output/session/sessionSummary';
import { delay } from '@/utils/time';
import { updateSessionStateFieldForTarget } from './updateSessionStateFieldForTarget';

type CreateSpawnedSessionParams = Readonly<{
  credentials: Credentials;
  directory: string;
  machineId?: string;
  backendTarget: BackendTargetRefV2;
  modelSelection?: SessionModelSelectionV1;
  title?: string;
  tag?: string;
  initialMessage?: string;
} & Partial<Pick<
  SpawnSessionOptions,
  | 'permissionMode'
  | 'permissionModeUpdatedAt'
  | 'agentModeId'
  | 'agentModeUpdatedAt'
  | 'accountSettingsVersionHint'
  | 'initialTranscriptAfterSeq'
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
const DEFAULT_SPAWNED_SESSION_NONCE_RESOLUTION_TIMEOUT_MS = 3_000;
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

async function recoverSpawnedSessionFromNonce(params: Readonly<{
  token: string;
  spawnNonce: string;
}>): Promise<Awaited<ReturnType<typeof fetchSessionById>> | null | 'unsupported'> {
  const timeoutMs = resolvePositiveIntFromEnv(
    'HAPPIER_SESSION_SPAWN_NONCE_RESOLUTION_TIMEOUT_MS',
    DEFAULT_SPAWNED_SESSION_NONCE_RESOLUTION_TIMEOUT_MS,
  );
  const pollIntervalMs = resolvePositiveIntFromEnv(
    'HAPPIER_SESSION_SPAWN_RECOVERY_POLL_INTERVAL_MS',
    DEFAULT_SPAWNED_SESSION_FETCH_POLL_INTERVAL_MS,
  );
  const deadlineMs = Date.now() + timeoutMs;

  while (true) {
    const resolved = await resolveDaemonSpawnSessionByNonce(params.spawnNonce);
    if (resolved.status === 'unsupported') return 'unsupported';
    if (resolved.status === 'success') {
      const recovered = await fetchSessionById({
        token: params.token,
        sessionId: resolved.sessionId,
      });
      if (recovered) return recovered;
    }
    if (Date.now() >= deadlineMs) return null;
    await delay(Math.max(25, pollIntervalMs));
  }
}

export async function createSpawnedSession(
  params: CreateSpawnedSessionParams,
): Promise<Readonly<{ created: true; sessionId: string; session: SessionSummary }>> {
  const spawnNonce = randomUUID();
  const spawnRequest = SpawnDaemonSessionRequestSchema.parse({
    directory: params.directory,
    spawnNonce,
    ...(params.machineId ? { machineId: params.machineId } : {}),
    backendTarget: params.backendTarget,
    ...(params.modelSelection ? { modelSelection: params.modelSelection } : {}),
    ...(typeof params.initialMessage === 'string' && params.initialMessage.trim().length > 0
      ? { initialPrompt: params.initialMessage }
      : {}),
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
    ...(params.sessionConfigOptionOverrides ? { sessionConfigOptionOverrides: params.sessionConfigOptionOverrides } : {}),
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
  await assertStoredAuthTokenValidForSpawn(params.credentials.token);
  const spawnResponse = await spawnDaemonSession(spawnRequest);
  let sessionId = '';
  if (spawnResponse?.success === true && typeof spawnResponse.sessionId === 'string') {
    sessionId = spawnResponse.sessionId.trim();
  } else if (isTransientSpawnFailure(spawnResponse)) {
    const recoveredFromNonce = await recoverSpawnedSessionFromNonce({
      token: params.credentials.token,
      spawnNonce,
    });
    if (recoveredFromNonce && recoveredFromNonce !== 'unsupported' && recoveredFromNonce.id) {
      sessionId = recoveredFromNonce.id;
    } else if (recoveredFromNonce === 'unsupported') {
      const error = new Error(
        'Spawn recovery requires daemon nonce-resolution support (/spawn-session/resolve). Please update the daemon and retry.',
      );
      (error as { code?: string }).code = 'spawn_recovery_unsupported';
      (error as { details?: unknown }).details = spawnResponse ?? null;
      throw error;
    } else {
      const error = new Error(
        'Deterministic spawn recovery did not resolve a session id before timeout. Retry session creation.',
      );
      (error as { code?: string }).code = 'spawn_recovery_not_found';
      (error as { details?: unknown }).details = spawnResponse ?? null;
      throw error;
    }
  }

  if (!sessionId) {
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
