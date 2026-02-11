import { SPAWN_SESSION_ERROR_CODES, type SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';
import type { TrackedSession } from '@/daemon/types';

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

  const fallbackSessionId = tracked.happySessionId ?? `PID-${params.pid}`;
  tracked.happySessionId = fallbackSessionId;
  params.warn(`[DAEMON RUN] Session webhook timeout for PID ${params.pid}; continuing with fallback session id ${fallbackSessionId}`);
  return { type: 'success', sessionId: fallbackSessionId };
}
