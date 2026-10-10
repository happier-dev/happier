import type { RuntimeAuthRecoveryScheduler } from './RuntimeAuthRecoveryScheduler';

export async function checkRuntimeAuthUsageLimitRecovery(input: Readonly<{
  scheduler: RuntimeAuthRecoveryScheduler | null;
  sessionId: string;
  attemptId: string;
}>): Promise<unknown> {
  const scheduler = input.scheduler;
  const current = scheduler?.readForSession(input.sessionId).find((intent) => intent.attemptId === input.attemptId);
  if (!scheduler || !current) return { ok: false, errorCode: 'session_usage_limit_recovery_control_inactive' };
  const result = await scheduler.wake({ sessionId: input.sessionId, attemptId: input.attemptId, reason: 'manual' });
  const settled = scheduler.readForSession(input.sessionId).find((intent) => intent.attemptId === input.attemptId);
  // Provider activity can settle the attempt while Pending admission/attachment is in flight.
  if (settled?.status === 'recovered') return { ok: true, status: 'resumed' };
  if (result.status === 'waiting' && settled
    && (settled.status === 'waiting' || settled.status === 'checking' || settled.status === 'resumed_awaiting_proof')) {
    return { ok: true, status: 'waiting' };
  }
  return { ok: false, errorCode: 'session_usage_limit_recovery_control_inactive' };
}
