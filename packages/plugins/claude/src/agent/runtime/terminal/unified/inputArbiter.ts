import type {
  TerminalInputInjectionResult,
  TerminalInputReadinessV1,
  TerminalPromptInput,
} from '@happier-dev/agents';

import { classifyClaudeUnifiedInjectionFailure } from './injectionFailurePolicy.js';

export type ClaudeUnifiedInputState =
  | 'queued'
  | 'waiting_for_readiness'
  | 'injecting'
  | 'awaiting_provider_acceptance'
  | 'submitted'
  | 'failed_retryable'
  | 'failed_ambiguous'
  | 'failed_terminal';

export type ClaudeUnifiedPromptAcceptance = Readonly<{
  acceptedAs: 'new_turn' | 'in_flight_steer';
  readinessAtInjection: TerminalInputReadinessV1;
}>;

export type ClaudeUnifiedPromptInjectionFailure = Readonly<{
  input: TerminalPromptInput;
  result: Extract<TerminalInputInjectionResult, { status: 'failed' }>;
  failureState: Extract<ClaudeUnifiedInputState, 'failed_ambiguous' | 'failed_terminal'>;
}>;

export type ClaudeUnifiedInputArbiterSnapshot = Readonly<{
  queuedCount: number;
  disposed: boolean;
  headInputState: ClaudeUnifiedInputState | null;
  lastDeferredReason: string | null;
  lastFailureReason: string | null;
}>;

export type ClaudeUnifiedInputArbiter = Readonly<{
  enqueue(input: TerminalPromptInput): void;
  observeReadiness(readiness: TerminalInputReadinessV1): void;
  observeCompaction(event: Readonly<{ phase: 'started' | 'completed' }>): void;
  drain(): Promise<void>;
  confirmProviderAcceptance(evidence?: Readonly<{ promptText?: string; includeTimedOutAmbiguous?: boolean }>): Promise<boolean>;
  /**
   * Arms the provider-acceptance timeout for a steered prompt. Steered prompts are
   * natively queued by Claude until the running turn ends, so the short acceptance
   * timeout must not run while the turn is in flight; the runtime arms it on
   * turn-end evidence instead. No-op when nothing is pending or already armed.
   */
  armPendingProviderAcceptanceTimeout(): void;
  snapshot(): ClaudeUnifiedInputArbiterSnapshot;
  dispose(): void;
}>;

export type ClaudeUnifiedInputArbiterOptions = Readonly<{
  injectPrompt(input: TerminalPromptInput): Promise<TerminalInputInjectionResult>;
  onPromptInjected?: (
    input: TerminalPromptInput,
    acceptance: ClaudeUnifiedPromptAcceptance,
    result: Extract<TerminalInputInjectionResult, { status: 'injected' }>,
  ) => void | Promise<void>;
  onPromptAccepted?: (
    input: TerminalPromptInput,
    acceptance: ClaudeUnifiedPromptAcceptance,
  ) => void | Promise<void>;
  onInjectionFailure?: (failure: ClaudeUnifiedPromptInjectionFailure) => void;
  providerAcceptanceTimeoutMs?: number;
  injectionRetryLimit?: number;
  injectionRetryBaseDelayMs?: number;
}>;

const DEFAULT_PROVIDER_ACCEPTANCE_TIMEOUT_MS = 5_000;
const DEFAULT_INJECTION_RETRY_LIMIT = 3;
const DEFAULT_INJECTION_RETRY_BASE_DELAY_MS = 250;

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.trunc(value));
}

function isDeferredReadiness(status: TerminalInputReadinessV1['status']): boolean {
  return status !== 'writable'
    && status !== 'failed_retryable'
    && status !== 'failed_ambiguous'
    && status !== 'failed_terminal';
}

function buildProviderAcceptanceTimeoutResult(
  readiness: TerminalInputReadinessV1 | null,
): Extract<TerminalInputInjectionResult, { status: 'failed' }> {
  return {
    status: 'failed',
    reason: 'ambiguous_provider_acceptance',
    phase: 'after_enter_unknown',
    recoverable: true,
    duplicateRisk: 'likely',
    observedAt: Date.now(),
    ...(readiness?.hostKind ? { hostKind: readiness.hostKind } : {}),
    ...(readiness?.hostSessionName ? { hostSessionName: readiness.hostSessionName } : {}),
    ...(readiness?.paneId ? { paneId: readiness.paneId } : {}),
  };
}

function normalizePromptText(value: string): string {
  return value.replace(/\r\n?/gu, '\n').trim();
}

function promptTextMatchesQueuedInput(
  input: TerminalPromptInput,
  promptText: string | undefined,
): boolean {
  if (typeof promptText !== 'string') return true;
  const normalizedEvidence = normalizePromptText(promptText);
  if (!normalizedEvidence) return true;
  return normalizePromptText(input.text) === normalizedEvidence;
}

function isCompactPromptInput(input: TerminalPromptInput): boolean {
  const text = normalizePromptText(input.text);
  return text === '/compact' || text.startsWith('/compact ');
}

export function createClaudeUnifiedInputArbiter(
  options: ClaudeUnifiedInputArbiterOptions,
): ClaudeUnifiedInputArbiter {
  const queue: TerminalPromptInput[] = [];
  const providerAcceptanceTimeoutMs = nonNegativeInteger(
    options.providerAcceptanceTimeoutMs,
    DEFAULT_PROVIDER_ACCEPTANCE_TIMEOUT_MS,
  );
  const injectionRetryLimit = nonNegativeInteger(
    options.injectionRetryLimit,
    DEFAULT_INJECTION_RETRY_LIMIT,
  );
  const injectionRetryBaseDelayMs = nonNegativeInteger(
    options.injectionRetryBaseDelayMs,
    DEFAULT_INJECTION_RETRY_BASE_DELAY_MS,
  );

  let disposed = false;
  let readiness: TerminalInputReadinessV1 | null = null;
  let headInputState: ClaudeUnifiedInputState | null = null;
  let lastDeferredReason: string | null = null;
  let lastFailureReason: string | null = null;
  let compactionActive = false;
  let retryAttempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let providerAcceptanceTimer: ReturnType<typeof setTimeout> | null = null;
  let drainInFlight: Promise<void> | null = null;
  let pendingProviderAcceptance: Readonly<{
    input: TerminalPromptInput;
    acceptance: ClaudeUnifiedPromptAcceptance;
  }> | null = null;
  let pendingAcceptanceCompletedCompaction = false;
  let ambiguousProviderAcceptanceFailure: Readonly<{
    input: TerminalPromptInput;
    acceptance: ClaudeUnifiedPromptAcceptance;
  }> | null = null;
  let ambiguousProviderAcceptanceRetryAttempt = 0;
  let pendingAcceptanceTimeoutAwaitingArm: Extract<TerminalInputInjectionResult, { status: 'failed' }> | null = null;

  function snapshot(): ClaudeUnifiedInputArbiterSnapshot {
    return {
      queuedCount: queue.length,
      disposed,
      headInputState,
      lastDeferredReason,
      lastFailureReason,
    };
  }

  function clearRetryTimer(): void {
    if (!retryTimer) return;
    clearTimeout(retryTimer);
    retryTimer = null;
  }

  function clearProviderAcceptanceTimer(): void {
    if (!providerAcceptanceTimer) return;
    clearTimeout(providerAcceptanceTimer);
    providerAcceptanceTimer = null;
  }

  function scheduleRetry(retryAfterMs: number): void {
    clearRetryTimer();
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void drain().catch(() => undefined);
    }, retryAfterMs);
    retryTimer.unref?.();
  }

  function notifyAmbiguousTimeout(
    input: TerminalPromptInput,
    result: Extract<TerminalInputInjectionResult, { status: 'failed' }>,
  ): void {
    ambiguousProviderAcceptanceFailure = pendingProviderAcceptance;
    pendingProviderAcceptance = null;
    pendingAcceptanceCompletedCompaction = false;
    lastFailureReason = result.reason;
    if (ambiguousProviderAcceptanceRetryAttempt >= 1) {
      headInputState = 'failed_terminal';
      options.onInjectionFailure?.({
        input,
        result,
        failureState: 'failed_terminal',
      });
      return;
    }
    headInputState = 'failed_ambiguous';
    options.onInjectionFailure?.({
      input,
      result,
      failureState: 'failed_ambiguous',
    });
    if (isCompactPromptInput(input)) return;
    void drain().catch(() => undefined);
  }

  function scheduleProviderAcceptanceTimeout(
    input: TerminalPromptInput,
    result: Extract<TerminalInputInjectionResult, { status: 'failed' }>,
  ): void {
    clearProviderAcceptanceTimer();
    providerAcceptanceTimer = setTimeout(() => {
      providerAcceptanceTimer = null;
      if (pendingProviderAcceptance?.input === input && compactionActive) return;
      if (pendingProviderAcceptance?.input === input) {
        notifyAmbiguousTimeout(input, result);
      }
    }, providerAcceptanceTimeoutMs);
    providerAcceptanceTimer.unref?.();
  }

  function createPromptAcceptance(): ClaudeUnifiedPromptAcceptance {
    return {
      acceptedAs: readiness?.activeTurnId ? 'in_flight_steer' : 'new_turn',
      readinessAtInjection: readiness ?? {
        status: 'defer_host_not_ready',
        observedAt: Date.now(),
      },
    };
  }

  async function acceptHeadPrompt(evidence?: Readonly<{ promptText?: string; includeTimedOutAmbiguous?: boolean }>): Promise<boolean> {
    const pending = pendingProviderAcceptance
      ?? (evidence?.includeTimedOutAmbiguous ? ambiguousProviderAcceptanceFailure : null);
    if (!pending || queue[0] !== pending.input) return false;
    if (!promptTextMatchesQueuedInput(pending.input, evidence?.promptText)) return false;

    queue.shift();
    pendingProviderAcceptance = null;
    ambiguousProviderAcceptanceFailure = null;
    pendingAcceptanceCompletedCompaction = false;
    pendingAcceptanceTimeoutAwaitingArm = null;
    clearProviderAcceptanceTimer();
    retryAttempt = 0;
    ambiguousProviderAcceptanceRetryAttempt = 0;
    lastDeferredReason = null;
    lastFailureReason = null;
    headInputState = 'submitted';
    await options.onPromptAccepted?.(pending.input, pending.acceptance);
    if (queue.length > 0) headInputState = 'queued';
    return true;
  }

  async function drainQueue(): Promise<void> {
    clearRetryTimer();
    while (!disposed && queue.length > 0) {
      if (pendingProviderAcceptance) {
        if (compactionActive || !pendingAcceptanceCompletedCompaction) {
          headInputState = 'awaiting_provider_acceptance';
          return;
        }
        pendingProviderAcceptance = null;
        pendingAcceptanceCompletedCompaction = false;
        clearProviderAcceptanceTimer();
      }
      if (compactionActive) {
        lastDeferredReason = 'compaction';
        headInputState = 'waiting_for_readiness';
        return;
      }
      if (headInputState === 'failed_ambiguous' || headInputState === 'failed_terminal') {
        if (
          headInputState === 'failed_ambiguous' &&
          ambiguousProviderAcceptanceFailure &&
          queue[0] === ambiguousProviderAcceptanceFailure.input &&
          !isCompactPromptInput(ambiguousProviderAcceptanceFailure.input) &&
          ambiguousProviderAcceptanceRetryAttempt < 1
        ) {
          ambiguousProviderAcceptanceRetryAttempt += 1;
          pendingProviderAcceptance = null;
          pendingAcceptanceCompletedCompaction = false;
          ambiguousProviderAcceptanceFailure = null;
          lastFailureReason = null;
          headInputState = 'waiting_for_readiness';
        } else {
          if (
            headInputState === 'failed_ambiguous' &&
            ambiguousProviderAcceptanceFailure &&
            queue[0] === ambiguousProviderAcceptanceFailure.input
          ) {
            const failure = ambiguousProviderAcceptanceFailure;
            pendingProviderAcceptance = null;
            pendingAcceptanceCompletedCompaction = false;
            ambiguousProviderAcceptanceFailure = null;
            lastFailureReason = 'ambiguous_provider_acceptance';
            headInputState = 'failed_terminal';
            options.onInjectionFailure?.({
              input: failure.input,
              result: buildProviderAcceptanceTimeoutResult(readiness),
              failureState: 'failed_terminal',
            });
          }
          return;
        }
      }

      const currentReadiness = readiness;
      if (!currentReadiness || isDeferredReadiness(currentReadiness.status)) {
        lastDeferredReason = currentReadiness?.status ?? 'defer_host_not_ready';
        headInputState = 'waiting_for_readiness';
        return;
      }
      if (currentReadiness.status === 'failed_ambiguous') {
        headInputState = 'failed_ambiguous';
        lastFailureReason = currentReadiness.reason ?? currentReadiness.status;
        return;
      }
      if (currentReadiness.status === 'failed_terminal') {
        headInputState = 'failed_terminal';
        lastFailureReason = currentReadiness.reason ?? currentReadiness.status;
        return;
      }
      if (currentReadiness.status === 'failed_retryable') {
        headInputState = 'failed_retryable';
        lastFailureReason = currentReadiness.reason ?? currentReadiness.status;
        return;
      }

      const input = queue[0];
      const acceptance = createPromptAcceptance();
      headInputState = 'injecting';
      const result = await options.injectPrompt(input);

      if (result.status === 'injected') {
        retryAttempt = 0;
        lastDeferredReason = null;
        lastFailureReason = null;
        pendingProviderAcceptance = { input, acceptance };
        pendingAcceptanceCompletedCompaction = false;
        ambiguousProviderAcceptanceFailure = null;
        headInputState = 'awaiting_provider_acceptance';
        await options.onPromptInjected?.(input, acceptance, result);
        if (acceptance.acceptedAs === 'in_flight_steer') {
          // Claude queues steered text until the running turn ends; defer the short
          // acceptance timeout until turn-end evidence arms it.
          pendingAcceptanceTimeoutAwaitingArm = buildProviderAcceptanceTimeoutResult(readiness);
        } else {
          scheduleProviderAcceptanceTimeout(input, buildProviderAcceptanceTimeoutResult(readiness));
        }
        return;
      }

      if (result.status === 'deferred') {
        lastDeferredReason = result.reason;
        headInputState = 'waiting_for_readiness';
        return;
      }

      lastFailureReason = result.reason;
      const action = classifyClaudeUnifiedInjectionFailure(result, {
        retryAttempt,
        retryLimit: injectionRetryLimit,
        retryBaseDelayMs: injectionRetryBaseDelayMs,
        providerAcceptanceTimeoutMs,
      });

      if (action.kind === 'retry') {
        retryAttempt += 1;
        headInputState = 'failed_retryable';
        scheduleRetry(action.retryAfterMs);
        return;
      }
      if (action.kind === 'await_provider_confirmation') {
        pendingProviderAcceptance = { input, acceptance };
        headInputState = 'awaiting_provider_acceptance';
        scheduleProviderAcceptanceTimeout(input, result);
        return;
      }

      headInputState = 'failed_terminal';
      options.onInjectionFailure?.({
        input,
        result,
        failureState: 'failed_terminal',
      });
      return;
    }
  }

  async function drain(): Promise<void> {
    if (drainInFlight) {
      await drainInFlight;
      return;
    }
    const run = drainQueue();
    drainInFlight = run;
    try {
      await run;
    } finally {
      if (drainInFlight === run) drainInFlight = null;
    }
  }

  return {
    enqueue(input) {
      if (disposed) return;
      queue.push(input);
      if (!headInputState) headInputState = 'queued';
    },
    observeReadiness(nextReadiness) {
      readiness = nextReadiness;
      if (queue.length > 0 && !pendingProviderAcceptance && !isDeferredReadiness(nextReadiness.status)) {
        void drain().catch(() => undefined);
      }
    },
    observeCompaction(event) {
      compactionActive = event.phase === 'started';
      if (pendingProviderAcceptance) {
        clearProviderAcceptanceTimer();
        pendingAcceptanceCompletedCompaction = event.phase === 'completed';
      } else if (
        event.phase === 'completed' &&
        ambiguousProviderAcceptanceFailure &&
        queue[0] === ambiguousProviderAcceptanceFailure.input
      ) {
        pendingProviderAcceptance = ambiguousProviderAcceptanceFailure;
        ambiguousProviderAcceptanceFailure = null;
        ambiguousProviderAcceptanceRetryAttempt = 0;
        pendingAcceptanceCompletedCompaction = true;
        lastFailureReason = null;
        headInputState = 'awaiting_provider_acceptance';
      }
      if (event.phase === 'started') {
        lastDeferredReason = 'compaction';
      }
    },
    drain,
    confirmProviderAcceptance: acceptHeadPrompt,
    armPendingProviderAcceptanceTimeout() {
      if (disposed || !pendingProviderAcceptance || providerAcceptanceTimer) return;
      const result = pendingAcceptanceTimeoutAwaitingArm
        ?? buildProviderAcceptanceTimeoutResult(readiness);
      pendingAcceptanceTimeoutAwaitingArm = null;
      scheduleProviderAcceptanceTimeout(pendingProviderAcceptance.input, result);
    },
    snapshot,
    dispose() {
      disposed = true;
      clearRetryTimer();
      clearProviderAcceptanceTimer();
      pendingProviderAcceptance = null;
      pendingAcceptanceCompletedCompaction = false;
      ambiguousProviderAcceptanceFailure = null;
      ambiguousProviderAcceptanceRetryAttempt = 0;
      pendingAcceptanceTimeoutAwaitingArm = null;
    },
  };
}
