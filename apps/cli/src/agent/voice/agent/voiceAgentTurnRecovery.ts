import type { SessionUsageLimitRecoveryV1 } from '@happier-dev/protocol';
import type { ExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
import { logger } from '@/ui/logger';
import { createExecutionRunCodedError } from '@/agent/runtime/bridges/executionRun/errors';

/** Voice surfaces the refusal while the native Run retains its admitted recovery. */
export async function runVoiceAgentTurn(
  backend: ExecutionRunHostRuntime,
  deliver: () => Promise<unknown>,
  timeoutMs: number | null,
): Promise<void> {
  let recoveryWaiting: SessionUsageLimitRecoveryV1 | null = null;
  let settleWaiting!: (recovery: SessionUsageLimitRecoveryV1) => void;
  const waiting = new Promise<SessionUsageLimitRecoveryV1>(resolve => { settleWaiting = resolve; });
  const unsubscribe = backend.subscribeRuntimeEvents?.(event => {
    if (event.kind !== 'recovery-waiting') return;
    recoveryWaiting = event.recovery;
    settleWaiting(event.recovery);
  });
  try {
    // A retained native wait already owns its admitted turn. Surface its current
    // fact without delivering another turn; observe new waits before admission.
    if (!recoveryWaiting) await deliver();
    const recovery = recoveryWaiting ?? await Promise.race([
      Promise.resolve(backend.waitForTurnCompletion?.(timeoutMs)).then(() => null),
      waiting,
    ]);
    if (!recovery) return;
    // Recovery owns its retry date. The client presents the localized usage-limit
    // line through the existing typed refusal, never as assistant speech/output.
    const retryAtMs = recovery.nextCheckAtMs ?? recovery.resetAtMs;
    logger.infoFile('[VoiceAgent] Turn recovery phase', {
      phase: 'waiting_settlement', armedAtMs: recovery.armedAtMs, retryAtMs,
    });
    throw createExecutionRunCodedError('usage_limit', 'usage_limit');
  } finally {
    unsubscribe?.();
  }
}
