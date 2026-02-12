import { SPAWN_SESSION_ERROR_CODES, type SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';
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

  const trackedSessionId = typeof tracked.happySessionId === 'string' ? tracked.happySessionId.trim() : '';
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
