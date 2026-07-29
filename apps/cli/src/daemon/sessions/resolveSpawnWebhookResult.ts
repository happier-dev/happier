import { SPAWN_SESSION_ERROR_CODES, type SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import type { TrackedSession } from '@/daemon/types';

function isPidPlaceholderSessionId(value: string): boolean {
  return /^PID-\d+$/.test(value);
}

export function resolveSpawnWebhookResult(params: Readonly<{
  pid: number;
  result: SpawnSessionResult;
  pidToTrackedSession: Map<number, TrackedSession>;
  warn: (message: string) => void;
}>): SpawnSessionResult {
  if (params.result.type !== 'error' || params.result.errorCode !== SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT) {
    return params.result;
  }

  const tracked = params.pidToTrackedSession.get(params.pid);
  if (!tracked) {
    return params.result;
  }

  const attachSessionId =
    tracked.spawnOptions && typeof tracked.spawnOptions.existingSessionId === 'string'
      ? tracked.spawnOptions.existingSessionId.trim()
      : '';
  if (attachSessionId) {
    params.warn(
      `[DAEMON RUN] Session webhook timed out for PID ${params.pid} while attaching to ${attachSessionId}; keeping timeout error until webhook or child-exit proof arrives`,
    );
    return params.result;
  }

  const trackedSessionId = typeof tracked.happySessionId === 'string' ? tracked.happySessionId.trim() : '';
  if (typeof tracked.sessionWebhookTimedOutAtMs === 'number') {
    params.warn(
      `[DAEMON RUN] Session webhook startup deadline expired for PID ${params.pid}; keeping timeout error`,
    );
    return params.result;
  }
  if (trackedSessionId && !isPidPlaceholderSessionId(trackedSessionId)) {
    params.warn(
      `[DAEMON RUN] Session webhook timed out for PID ${params.pid}, but canonical session id ${trackedSessionId} is already tracked; continuing`,
    );
    return { type: 'success', sessionId: trackedSessionId };
  }

  params.warn(
    `[DAEMON RUN] Session webhook timeout for PID ${params.pid}; canonical session id not available yet`,
  );
  return params.result;
}
