import type { SessionUsageLimitRecoveryV1 } from '@happier-dev/protocol';
import type { ExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';

/** Voice can finish speaking while the native Run retains its admitted recovery. */
export async function runVoiceAgentTurn(
  backend: ExecutionRunHostRuntime,
  deliver: () => Promise<unknown>,
  timeoutMs: number | null,
): Promise<string | null> {
  let recoveryWaiting: SessionUsageLimitRecoveryV1 | null = null;
  let settleWaiting!: (recovery: SessionUsageLimitRecoveryV1) => void;
  const waiting = new Promise<SessionUsageLimitRecoveryV1>(resolve => { settleWaiting = resolve; });
  const unsubscribe = backend.subscribeRuntimeEvents?.(event => {
    if (event.kind !== 'recovery-waiting') return;
    recoveryWaiting = event.recovery;
    settleWaiting(event.recovery);
  });
  try {
    // Subscribe before admission so a fast provider refusal cannot hide its
    // waiting fact. A rejected delivery still rejects rather than claiming a turn.
    await deliver();
    const recovery = recoveryWaiting ?? await Promise.race([
      Promise.resolve(backend.waitForTurnCompletion?.(timeoutMs)).then(() => null),
      waiting,
    ]);
    if (!recovery) return null;
    // Reuse the ordinary Session banner's waiting/retry wording. Recovery owns
    // the retry date; Voice adds no timer and never cancels the native wait.
    const retryAtMs = recovery.nextCheckAtMs ?? recovery.resetAtMs;
    return retryAtMs === null ? 'Waiting for usage limit reset.'
      : `Waiting for usage limit reset. Happier will retry automatically at ${new Date(retryAtMs).toLocaleString()}.`;
  } finally {
    unsubscribe?.();
  }
}
