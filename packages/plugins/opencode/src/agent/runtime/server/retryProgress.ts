import { asRecord } from './openCodeParsing.js';
import { projectOpenCodeRuntimeScope } from './openCodeRuntimeEvents.js';
import type { OpenCodeRuntimeEvent, OpenCodeRuntimeScope } from './runtimeEvents.js';
import type { OpenCodeServerRuntimeState } from './state.js';

/** Projects native retry evidence without taking ownership of retry policy or turn settlement. */
export function createOpenCodeRetryProgress(params: Readonly<{
  state: OpenCodeServerRuntimeState;
  scope: OpenCodeRuntimeScope;
  publish(event: OpenCodeRuntimeEvent): void;
}>) {
  let observedRetryCount = 0;
  let retryAttempt: number | null = null;

  const publishProgress = (retry?: Readonly<{ attempt: number; reason: 'unknown' }>): void => {
    if (params.state.disposed || !params.state.turnInFlight || !params.state.activeTurnId || !params.state.providerSessionId) return;
    params.publish({ kind: 'turn-progress', ...projectOpenCodeRuntimeScope(params.scope),
      turnId: params.state.activeTurnId, emittedAtMs: Date.now(), ...(retry ? { retry } : {}) });
  };

  const observeProgress = (): void => {
    if (retryAttempt === null) return;
    retryAttempt = null;
    publishProgress();
  };

  return {
    reset(): void {
      observedRetryCount = 0;
      retryAttempt = null;
    },
    observeRetry(status?: unknown): void {
      if (params.state.disposed || !params.state.turnInFlight || !params.state.activeTurnId || !params.state.providerSessionId) return;
      observedRetryCount += 1;
      const nativeAttempt = asRecord(status)?.attempt;
      // V1 admits zero/non-comparable attempts; V2's admitted notification has no attempt contract.
      // In those cases the public positive attempt is this turn's correlated retry observation count.
      const attempt = typeof nativeAttempt === 'number' && Number.isSafeInteger(nativeAttempt) && nativeAttempt > 0
        ? nativeAttempt : observedRetryCount;
      if (retryAttempt === attempt) return;
      retryAttempt = attempt;
      publishProgress({ attempt, reason: 'unknown' });
    },
    observeProgress,
    observePublishedEvent(event: OpenCodeRuntimeEvent): void {
      if ('turnId' in event && event.turnId === params.state.activeTurnId
        && (event.kind === 'message-delta' || event.kind === 'tool-call' || event.kind === 'tool-result')) observeProgress();
    },
  };
}
