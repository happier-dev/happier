import type { BackendTargetRefV1 } from '@happier-dev/protocol';

import { spawnDaemonSession } from '@/daemon/controlClient';
import type { Credentials } from '@/persistence';
import { SpawnDaemonSessionRequestSchema } from '@/rpc/handlers/spawnSessionOptionsContract';
import { updateSessionMetadataWithRetry } from '@/session/metadata/updateSessionMetadataWithRetry';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import { summarizeSessionRecord, type SessionSummary } from '@/cli/output/session/sessionSummary';
import { delay } from '@/utils/time';

type CreateSpawnedSessionParams = Readonly<{
  credentials: Credentials;
  directory: string;
  machineId?: string;
  backendTarget: BackendTargetRefV1;
  modelId?: string;
  title?: string;
  tag?: string;
  initialMessage?: string;
}>;

const DEFAULT_SPAWNED_SESSION_FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_SPAWNED_SESSION_FETCH_POLL_INTERVAL_MS = 200;

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

export async function createSpawnedSession(
  params: CreateSpawnedSessionParams,
): Promise<Readonly<{ created: true; sessionId: string; session: SessionSummary }>> {
  const spawnRequest = SpawnDaemonSessionRequestSchema.parse({
    directory: params.directory,
    ...(params.machineId ? { machineId: params.machineId } : {}),
    backendTarget: params.backendTarget,
    ...(params.modelId ? { modelId: params.modelId, modelUpdatedAt: Date.now() } : {}),
    ...(typeof params.initialMessage === 'string' && params.initialMessage.trim().length > 0
      ? { initialPrompt: params.initialMessage }
      : {}),
  });
  const spawnResponse = await spawnDaemonSession(spawnRequest);

  if (!spawnResponse || spawnResponse.success !== true || typeof spawnResponse.sessionId !== 'string') {
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

  const sessionId = spawnResponse.sessionId.trim();
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
