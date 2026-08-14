import { resolveTerminalInjectionReadiness } from '@/agent/runtime/terminal/injection/arbiter';
import type { TerminalInputInjectionResult, TerminalLifecycleObservation, TerminalTurnState } from '@/agent/runtime/terminal/_types';
import { isNonSteerablePromptPayload, parseSpecialCommand } from '@/cli/parsers/specialCommands';

import type {
  ClaudeUnifiedInFlightSteerEvaluator,
  ClaudeUnifiedInputArbiter,
  ClaudeUnifiedInputArbiterSnapshot,
  ClaudeUnifiedDeliveryBlocker,
  ClaudeUnifiedPromptAcceptance,
  ClaudeUnifiedPromptAcceptedHandler,
  ClaudeUnifiedPromptBatch,
  ClaudeUnifiedPromptInjectedHandler,
  ClaudeUnifiedPromptInjectionFailure,
  ClaudeUnifiedPromptInjectionFailureHandling,
  ClaudeUnifiedPromptInjectionFailureHandler,
  ClaudeUnifiedPromptInjector,
  ClaudeUnifiedPromptDeliveryState,
  ClaudeUnifiedPromptProviderAcceptancePendingHandler,
} from './_types';
import { classifyClaudeUnifiedInjectionFailure } from './injectionFailurePolicy';
import { normalizeClaudeUnifiedPromptIdentityText } from './promptIdentity';

type HeadInputState = ClaudeUnifiedInputArbiterSnapshot['headInputState'];
type PendingProviderAcceptance<Mode> = Readonly<{
  batch: ClaudeUnifiedPromptBatch<Mode>;
  acceptance: ClaudeUnifiedPromptAcceptance;
}>;

const DEFAULT_INJECTION_RETRY_LIMIT = 3;
const DEFAULT_INJECTION_RETRY_BASE_DELAY_MS = 250;
// A pending-queue prompt deferred while the turn is running is normally redrained
// by the turn-end lifecycle hook. This bounded fallback wake re-evaluates the
// deferral even if that hook never arrives, so the prompt cannot starve forever.
// It re-defers (no mid-turn injection) while the turn is still running.
const DEFAULT_BUSY_TURN_FALLBACK_WAKE_MS = 15_000;
// A 'running' turn state can be STALE: after a respawn, replayed transcript rows mark the
// turn running but no live provider turn exists, so turn-end evidence never arrives and a
// deferred ui_pending prompt starves forever (incident cmq7pyqkj, L1). When NO provider
// lifecycle activity is observed for this bounded window, the turn is treated as not
// running and the prompt drains normally as a new turn (never as an in-flight steer).
const DEFAULT_STALE_TURN_RECOVERY_MS = 30_000;
// A deferral (readiness gate or adapter injection result) that carries NO retryAfterMs used to
// park the head batch with no timer at all: scheduleRetryDrain(undefined) was a silent no-op, the
// pump stayed paused on arbiter backpressure, and a claimed pending row wedged in "delivering"
// forever (incidents cmres6qwl / cmr4ntzj3 — zellij pane_initializing deferrals omit retryAfterMs).
// Every deferral now re-arms with at least this bounded fallback so the head is re-evaluated when
// its blocking condition clears (pane ready, output quiet, permission resolved).
const DEFAULT_DEFERRED_REDRIVE_FALLBACK_MS = 1_000;

function normalizePromptText(value: string): string {
  return normalizeClaudeUnifiedPromptIdentityText(value);
}

function isCompactPrompt(batch: Readonly<{ message: string }>): boolean {
  return parseSpecialCommand(normalizePromptText(batch.message)).type === 'compact';
}

function isNonSteerablePrompt(batch: Readonly<{ message: string }>): boolean {
  return isNonSteerablePromptPayload(normalizePromptText(batch.message));
}

function isDeterministicPreProviderInputRejection(
  failure: Extract<TerminalInputInjectionResult, { status: 'failed' }>,
): boolean {
  return failure.reason === 'invalid_prompt_text'
    && failure.phase === 'before_write'
    && failure.duplicateRisk === 'none'
    && failure.recoverable === false;
}

export function createClaudeUnifiedInputArbiter<Mode = unknown>(opts: Readonly<{
  injectPrompt: ClaudeUnifiedPromptInjector<Mode>['injectPrompt'];
  /**
   * Single correlation boundary for every attempt that now requires exact provider evidence.
   * Injection UX and failure reporting remain separate outcomes; neither owns acceptance truth.
   */
  onProviderAcceptancePending?: ClaudeUnifiedPromptProviderAcceptancePendingHandler<Mode> | undefined;
  onPromptInjected?: ClaudeUnifiedPromptInjectedHandler<Mode> | undefined;
  onPromptAccepted?: ClaudeUnifiedPromptAcceptedHandler<Mode> | undefined;
  nowMs?: (() => number) | undefined;
  quietPeriodMs?: number | undefined;
  maxWaitMs?: number | undefined;
  injectionRetryLimit?: number | undefined;
  injectionRetryBaseDelayMs?: number | undefined;
  busyTurnFallbackWakeMs?: number | undefined;
  /**
   * Bounded no-provider-activity window after which a 'running' turn is treated as stale and a
   * deferred `ui_pending` prompt drains normally (L1). Screen evidence (`turnLikelyEnded`) is
   * additionally required whenever an in-flight steer evaluation was possible for the prompt.
   */
  staleTurnRecoveryMs?: number | undefined;
  /**
   * Fallback re-drive delay for deferrals that carry no retryAfterMs. A deferral must NEVER park
   * the head without a wake: the pump is paused on arbiter backpressure while a batch waits, so a
   * bare deferral wedges the whole pending queue (claimed row stuck "delivering" forever).
   */
  deferredRedriveFallbackMs?: number | undefined;
  /**
   * Canonical session turn lifecycle probe (Lane N2). The canonical lifecycle (the session
   * client's turn owner) is a stronger truth source than a one-frame screen parse: when it
   * reports NO active turn during stale-turn recovery, the prompt drains without requiring
   * turn-end screen evidence. Absent probe keeps the fail-closed screen-evidence requirement.
   */
  isCanonicalTurnActive?: (() => boolean) | undefined;
  onInjectionFailure?: ClaudeUnifiedPromptInjectionFailureHandler<Mode> | undefined;
  /**
   * Undeliverable-batch handback (F-1 / A3-MED-1): fired with every batch the arbiter can no
   * longer deliver — all still-queued batches on dispose (including a `failed_terminal` head
   * that would otherwise be dropped by the park/relaunch unwind) and any batch enqueued after
   * dispose. Batches are handed back in FIFO order so the owner can re-pend them to its queue
   * instead of silently losing user input. Mirrors the pump-level `onUndeliverableBatch` seam,
   * which only covers the pulled-but-not-yet-enqueued window.
   */
  onUndeliverableBatches?: ((batches: ReadonlyArray<ClaudeUnifiedPromptBatch<Mode>>) => void) | undefined;
  /**
   * Screen-evidence evaluation for steering a pending UI prompt into a RUNNING turn (D19). When
   * absent or vetoing, the prompt keeps the existing bounded defer-until-idle behavior.
   */
  evaluateInFlightSteer?: ClaudeUnifiedInFlightSteerEvaluator<Mode> | undefined;
  /**
   * Provider-adapter interrupt owner for an authenticated `interrupt_and_send`. The returned
   * promise confirms the interrupt request completed; injection remains fenced until the
   * lifecycle owner subsequently observes the old turn as idle.
   */
  interruptActiveTurn?: (() => Promise<void>) | undefined;
  /**
   * Fired once per steered prompt when turn-end evidence arms its provider-acceptance expectation
   * (the queued prompt's UserPromptSubmit/JSONL row arrives only after the steered turn ends).
   */
  onSteerAcceptanceArmed?: ((batch: ClaudeUnifiedPromptBatch<Mode>) => void) | undefined;
  /**
   * Canonical delivery-state probe. The arbiter owns Claude's terminal retry loop, but the
   * session client owns provider-acceptance truth; consult it before replaying an ambiguous
   * head so a provider-confirmed prompt cannot be injected a second time.
   */
  resolvePromptDeliveryState?: ((batch: ClaudeUnifiedPromptBatch<Mode>) => ClaudeUnifiedPromptDeliveryState) | undefined;
  /** Publishes the exact transient native-custody head; null removes the capability. */
  onPendingInputInterruptAndRunLocalIdChange?: ((localId: string | null) => void) | undefined;
}>): ClaudeUnifiedInputArbiter<Mode> {
  const queue: Array<ClaudeUnifiedPromptBatch<Mode>> = [];
  const nowMs = opts.nowMs ?? Date.now;
  const injectionRetryLimit = Math.max(0, Math.trunc(opts.injectionRetryLimit ?? DEFAULT_INJECTION_RETRY_LIMIT));
  const injectionRetryBaseDelayMs = Math.max(0, Math.trunc(opts.injectionRetryBaseDelayMs ?? DEFAULT_INJECTION_RETRY_BASE_DELAY_MS));
  const busyTurnFallbackWakeMs = Math.max(0, Math.trunc(opts.busyTurnFallbackWakeMs ?? DEFAULT_BUSY_TURN_FALLBACK_WAKE_MS));
  const staleTurnRecoveryMs = Math.max(0, Math.trunc(opts.staleTurnRecoveryMs ?? DEFAULT_STALE_TURN_RECOVERY_MS));
  const deferredRedriveFallbackMs = Math.max(1, Math.trunc(opts.deferredRedriveFallbackMs ?? DEFAULT_DEFERRED_REDRIVE_FALLBACK_MS));

  let disposed = false;
  let turnState: TerminalTurnState = 'idle';
  let permissionBlocked = false;
  let userTyping = false;
  let userTypingObservedAtMs: number | null = null;
  let firstObservedAtMs = nowMs();
  let outputObserved = false;
  let lastOutputAtMs: number | null = null;
  let compactionActive = false;
  let lastDeferredReason: string | null = null;
  let lastFailureReason: string | null = null;
  let currentHeadBlocker: ClaudeUnifiedDeliveryBlocker | null = null;
  let headInputState: HeadInputState = null;
  let draining: Promise<void> | null = null;
  let retryDrainTimer: ReturnType<typeof setTimeout> | null = null;
  let retryAttempt = 0;
  let pendingProviderAcceptance: PendingProviderAcceptance<Mode> | null = null;
  let injectingProviderAcceptance: PendingProviderAcceptance<Mode> | null = null;
  let providerAcceptanceObservedDuringInjection: PendingProviderAcceptance<Mode> | null = null;
  let pendingAcceptanceCompletedCompaction = false;
  // Terminal composer/queued-banner evidence proves only that Claude's TUI owns the bytes. Keep
  // that custody outside the injection queue so later input can progress without re-injecting the
  // same prompt, but do not retire provider delivery until separately matched provider evidence.
  const terminalCustody = new Array<PendingProviderAcceptance<Mode>>();
  let lastInjectedNotifiedBatch: ClaudeUnifiedPromptBatch<Mode> | null = null;
  // An in-flight steer's provider acceptance (UserPromptSubmit/JSONL row) arrives only when Claude
  // submits the queued prompt at TURN END. This state waits for independent lifecycle or screen
  // evidence; elapsed time may re-check that evidence but never creates an acceptance outcome.
  let steerAcceptanceAwaitingTurnEnd = false;
  let steerTurnEndFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  const providerAcceptanceByBatch = new Map<ClaudeUnifiedPromptBatch<Mode>, ClaudeUnifiedPromptAcceptance>();
  const interruptRequestedBatches = new WeakSet<object>();
  let pendingQueuePumpStateVersion = 0;
  const pendingQueuePumpStateChangeWaiters = new Set<(changed: boolean) => void>();

  const readPendingInputInterruptAndRunLocalId = (): string | null => {
    if (disposed || turnState !== 'running') return null;
    const custodyHead = terminalCustody[0];
    if (!custodyHead || custodyHead.acceptance.acceptedAs !== 'in_flight_steer') return null;
    if (interruptRequestedBatches.has(custodyHead.batch)) return null;
    const localIds = custodyHead.batch.userMessageLocalIds;
    return localIds?.length === 1 && typeof localIds[0] === 'string' && localIds[0].length > 0
      ? localIds[0]
      : null;
  };

  const claimPendingInputInterruptAndRun = (localId: string): boolean => {
    if (readPendingInputInterruptAndRunLocalId() !== localId) return false;
    const custodyHead = terminalCustody[0];
    if (!custodyHead) return false;
    interruptRequestedBatches.add(custodyHead.batch);
    publishPendingInputInterruptAndRunLocalId();
    return true;
  };
  let publishedPendingInputInterruptAndRunLocalId: string | null | undefined;
  const publishPendingInputInterruptAndRunLocalId = (): void => {
    const localId = readPendingInputInterruptAndRunLocalId();
    if (publishedPendingInputInterruptAndRunLocalId === localId) return;
    publishedPendingInputInterruptAndRunLocalId = localId;
    opts.onPendingInputInterruptAndRunLocalIdChange?.(localId);
  };

  const providerAcceptancePendingCount = (): number =>
    pendingProviderAcceptance ? 1 : 0;

  const pendingInjectionCount = (): number =>
    queue.reduce((count, batch) => {
      if (pendingProviderAcceptance?.batch === batch) return count;
      return count + 1;
    }, 0);

  const pendingQueuePumpBackpressureState = (): string => (
    `${pendingInjectionCount()}:${providerAcceptancePendingCount()}`
  );
  let publishedPendingQueuePumpBackpressureState = pendingQueuePumpBackpressureState();

  const notifyPendingQueuePumpStateChanged = (): void => {
    pendingQueuePumpStateVersion += 1;
    for (const resolve of [...pendingQueuePumpStateChangeWaiters]) {
      resolve(true);
    }
  };

  const notifyPendingQueuePumpStateChangedIfNeeded = (): void => {
    const nextState = pendingQueuePumpBackpressureState();
    if (publishedPendingQueuePumpBackpressureState === nextState) return;
    publishedPendingQueuePumpBackpressureState = nextState;
    notifyPendingQueuePumpStateChanged();
  };

  const waitForPendingQueuePumpStateChange = async (options: Readonly<{
    afterVersion: number;
    abortSignal: AbortSignal;
  }>): Promise<boolean> => {
    if (disposed || options.abortSignal.aborted) return false;
    if (options.afterVersion !== pendingQueuePumpStateVersion) return true;
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (changed: boolean): void => {
        if (settled) return;
        settled = true;
        pendingQueuePumpStateChangeWaiters.delete(finish);
        options.abortSignal.removeEventListener('abort', onAbort);
        resolve(changed);
      };
      const onAbort = (): void => finish(false);
      pendingQueuePumpStateChangeWaiters.add(finish);
      options.abortSignal.addEventListener('abort', onAbort, { once: true });
      // Close the snapshot-to-wait race even if the caller's captured version changed
      // immediately before this waiter was installed.
      if (options.afterVersion !== pendingQueuePumpStateVersion) {
        finish(true);
      }
    });
  };

  const snapshot = (): ClaudeUnifiedInputArbiterSnapshot => ({
    pendingQueuePumpStateVersion,
    queuedCount: queue.length,
    pendingInjectionCount: pendingInjectionCount(),
    terminalCustodyCount: terminalCustody.length,
    providerAcceptancePendingCount: providerAcceptancePendingCount(),
    disposed,
    turnState,
    permissionBlocked,
    userTyping,
    lastDeferredReason,
    lastFailureReason,
    currentHeadBlocker,
    headInputState,
  });

  const observeLifecycle = (observation: TerminalLifecycleObservation): void => {
    const observedAtMs = observation.observedAtMs ?? nowMs();
    if (observation.type === 'turn_state') {
      turnState = observation.state;
      if (observation.state === 'running' || observation.state === 'finalizing') {
        outputObserved = true;
        lastOutputAtMs = observedAtMs;
      }
      if (observation.state === 'blocked_on_permission') {
        permissionBlocked = true;
      } else if (observation.state === 'idle') {
        permissionBlocked = false;
        // Turn-end evidence: a steered prompt queued by Claude's TUI is submitted now, so its
        // provider-acceptance expectation can finally be armed.
        armSteerAcceptanceAfterTurnEnd();
      }
      return;
    }
    if (observation.type === 'permission') {
      permissionBlocked = observation.blocked;
      return;
    }
    if (observation.type === 'compaction') {
      compactionActive = observation.phase === 'started';
      if (pendingProviderAcceptance) {
        pendingAcceptanceCompletedCompaction = observation.phase === 'completed';
      }
      if (observation.phase === 'started') {
        lastDeferredReason = 'compaction';
      }
      return;
    }
    outputObserved = true;
    lastOutputAtMs = observedAtMs;
  };

  const observeUserTypingState = (state: Readonly<{ userTyping: boolean; observedAtMs?: number | undefined }>): void => {
    userTyping = state.userTyping;
    userTypingObservedAtMs = state.userTyping ? state.observedAtMs ?? nowMs() : null;
  };

  const notifyTerminalComposerCleared = (
    state?: Readonly<{ observedAtMs?: number | undefined }>,
  ): void => {
    if (disposed) return;
    observeUserTypingState({ userTyping: false, observedAtMs: state?.observedAtMs ?? nowMs() });
    if (queue.length === 0) return;
    scheduleRetryDrain(0);
  };

  function clearRetryDrainTimer(): void {
    if (!retryDrainTimer) return;
    clearTimeout(retryDrainTimer);
    retryDrainTimer = null;
  }

  function clearSteerTurnEndFallbackTimer(): void {
    if (!steerTurnEndFallbackTimer) return;
    clearTimeout(steerTurnEndFallbackTimer);
    steerTurnEndFallbackTimer = null;
  }

  function clearPendingSteerArming(): void {
    steerAcceptanceAwaitingTurnEnd = false;
    clearSteerTurnEndFallbackTimer();
  }

  function clearCurrentHeadBlocker(): void {
    currentHeadBlocker = null;
  }

  function resolveReadinessBlocker(
    reason: string,
  ): ClaudeUnifiedDeliveryBlocker | null {
    if (reason === 'pane_initializing') {
      return { kind: 'pane_initializing', source: 'readiness' };
    }
    if (reason === 'terminal_busy') {
      return { kind: 'terminal_busy', source: 'readiness' };
    }
    if (reason === 'user_typing') {
      return { kind: 'terminal_user_draft', source: 'readiness' };
    }
    return null;
  }

  function armSteerAcceptanceAfterTurnEnd(): void {
    if (!steerAcceptanceAwaitingTurnEnd || !pendingProviderAcceptance) return;
    const armedBatch = pendingProviderAcceptance.batch;
    clearPendingSteerArming();
    opts.onSteerAcceptanceArmed?.(armedBatch);
  }

  function isClaimedPendingDeliveryHandling(
    handling: ClaudeUnifiedPromptInjectionFailureHandling | undefined,
  ): handling is Readonly<{ action: 'claimed_pending_delivery' }> {
    return Boolean(handling)
      && typeof handling === 'object'
      && (handling as { action?: unknown }).action === 'claimed_pending_delivery';
  }

  function isHandledInjectionFailure(
    handling: ClaudeUnifiedPromptInjectionFailureHandling | undefined,
  ): handling is Exclude<ClaudeUnifiedPromptInjectionFailureHandling, void> {
    return Boolean(handling)
      && typeof handling === 'object'
      && (
        (handling as { action?: unknown }).action === 'claimed_pending_delivery'
        || (handling as { action?: unknown }).action === 'surfaced_runtime_issue'
      );
  }

  function isPendingQueueBatch(batch: ClaudeUnifiedPromptBatch<Mode>): boolean {
    return (batch.userMessageLocalIds?.length ?? 0) > 0;
  }

  function clearInjectionAcceptanceForBatch(batch: ClaudeUnifiedPromptBatch<Mode>): void {
    if (injectingProviderAcceptance?.batch === batch) {
      injectingProviderAcceptance = null;
    }
    if (providerAcceptanceObservedDuringInjection?.batch === batch) {
      providerAcceptanceObservedDuringInjection = null;
    }
  }

  function clearProviderAcceptanceObservedDuringInjection(acceptance: PendingProviderAcceptance<Mode>): void {
    if (providerAcceptanceObservedDuringInjection === acceptance) {
      providerAcceptanceObservedDuringInjection = null;
    }
  }

  function dropClaimedPendingDeliveryBatch(batch: ClaudeUnifiedPromptBatch<Mode>): boolean {
    if (queue[0] !== batch) return false;
    queue.shift();
    if (pendingProviderAcceptance?.batch === batch) {
      pendingProviderAcceptance = null;
      clearPendingSteerArming();
    }
    if (lastInjectedNotifiedBatch === batch) {
      lastInjectedNotifiedBatch = null;
    }
    providerAcceptanceByBatch.delete(batch);
    clearInjectionAcceptanceForBatch(batch);
    pendingAcceptanceCompletedCompaction = false;
    lastFailureReason = null;
    retryAttempt = 0;
    clearCurrentHeadBlocker();
    headInputState = queue.length > 0 ? 'waiting_for_readiness' : null;
    return true;
  }

  // Hooks can be lost mid-turn. While a steer acceptance waits for turn-end evidence, periodically
  // re-check the screen; an idle interactive composer is trusted turn-end evidence and arms the
  // acceptance expectation so the steered prompt can never wedge as awaiting acceptance forever.
  function scheduleSteerTurnEndFallbackWake(): void {
    clearSteerTurnEndFallbackTimer();
    steerTurnEndFallbackTimer = setTimeout(() => {
      steerTurnEndFallbackTimer = null;
      void (async () => {
        if (disposed || !steerAcceptanceAwaitingTurnEnd || !pendingProviderAcceptance) return;
        if (turnState !== 'running') {
          armSteerAcceptanceAfterTurnEnd();
          return;
        }
        try {
          const decision = await opts.evaluateInFlightSteer?.(pendingProviderAcceptance.batch);
          if (
            !disposed
            && steerAcceptanceAwaitingTurnEnd
            && pendingProviderAcceptance
            && decision
            && decision.turnLikelyEnded === true
          ) {
            armSteerAcceptanceAfterTurnEnd();
            return;
          }
        } catch {
          // Screen evidence unavailable; keep waiting for lifecycle evidence.
        }
        if (!disposed && steerAcceptanceAwaitingTurnEnd) {
          scheduleSteerTurnEndFallbackWake();
        }
      })();
    }, busyTurnFallbackWakeMs);
    steerTurnEndFallbackTimer.unref?.();
  }

  function scheduleRetryDrain(retryAfterMs: number | undefined): void {
    if (retryAfterMs === undefined || retryAfterMs < 0) return;
    clearRetryDrainTimer();
    retryDrainTimer = setTimeout(() => {
      retryDrainTimer = null;
      void drainWhenSafe().catch(() => undefined);
    }, retryAfterMs);
    retryDrainTimer.unref?.();
  }

  async function notifyInjectionFailure(
    failure: ClaudeUnifiedPromptInjectionFailure<Mode>,
  ): Promise<ClaudeUnifiedPromptInjectionFailureHandling | undefined> {
    return await opts.onInjectionFailure?.(failure);
  }

  function buildObservedProviderAcceptanceTerminalFailureResult(): Extract<TerminalInputInjectionResult, { status: 'failed' }> {
    return {
      status: 'failed',
      reason: 'host_unreachable',
      phase: 'after_enter_unknown',
      duplicateRisk: 'possible',
      recoverable: true,
    };
  }

  function buildExactDeliveryUnavailableResult(): Extract<TerminalInputInjectionResult, { status: 'failed' }> {
    return {
      status: 'failed',
      reason: 'no_target',
      phase: 'before_write',
      duplicateRisk: 'none',
      recoverable: false,
    };
  }

  async function failExactDelivery(batch: ClaudeUnifiedPromptBatch<Mode>): Promise<'dropped' | 'parked'> {
    const result = buildExactDeliveryUnavailableResult();
    lastFailureReason = result.reason;
    headInputState = 'failed_terminal';
    const handling = await notifyInjectionFailure({ batch, result, failureState: 'failed_terminal' });
    if (isClaimedPendingDeliveryHandling(handling) && dropClaimedPendingDeliveryBatch(batch)) return 'dropped';
    return 'parked';
  }

  function resolvePromptAcceptance(state: TerminalTurnState): ClaudeUnifiedPromptAcceptance {
    return {
      acceptedAs: state === 'running' ? 'in_flight_steer' : 'new_turn',
      turnStateAtInjection: state,
    };
  }

  function readCanonicalTurnInactive(): boolean {
    if (!opts.isCanonicalTurnActive) return false;
    try {
      return opts.isCanonicalTurnActive() === false;
    } catch {
      return false;
    }
  }

  function readPromptDeliveryState(batch: ClaudeUnifiedPromptBatch<Mode>): ClaudeUnifiedPromptDeliveryState {
    if (!opts.resolvePromptDeliveryState) return 'pending';
    try {
      return opts.resolvePromptDeliveryState(batch);
    } catch {
      return 'pending';
    }
  }

  async function acceptBatch(
    batch: ClaudeUnifiedPromptBatch<Mode>,
    acceptance: ClaudeUnifiedPromptAcceptance,
  ): Promise<void> {
    lastDeferredReason = null;
    lastFailureReason = null;
    clearCurrentHeadBlocker();
    headInputState = 'submitted';
    retryAttempt = 0;
    if (pendingProviderAcceptance?.batch === batch) {
      pendingProviderAcceptance = null;
      pendingAcceptanceCompletedCompaction = false;
      clearPendingSteerArming();
    }
    const terminalCustodyIndex = terminalCustody.findIndex((entry) => entry.batch === batch);
    if (terminalCustodyIndex >= 0) {
      terminalCustody.splice(terminalCustodyIndex, 1);
    }
    if (lastInjectedNotifiedBatch === batch) {
      lastInjectedNotifiedBatch = null;
    }
    providerAcceptanceByBatch.delete(batch);
    clearInjectionAcceptanceForBatch(batch);
    await opts.onPromptAccepted?.(batch, acceptance);
    if (pendingProviderAcceptance) {
      headInputState = 'awaiting_provider_acceptance';
    }
  }

  async function acceptTerminalCustody(
    custody: PendingProviderAcceptance<Mode>,
  ): Promise<void> {
    providerAcceptanceByBatch.delete(custody.batch);
    clearInjectionAcceptanceForBatch(custody.batch);
    await opts.onPromptAccepted?.(custody.batch, custody.acceptance);
    // Acceptance for an older terminal-custody entry must not reset the retry/deferred state of a
    // newer queue head. Only project the terminal result when no other delivery currently owns it.
    if (!pendingProviderAcceptance && queue.length === 0) {
      headInputState = terminalCustody.length > 0 ? 'terminal_custody' : 'submitted';
    }
  }

  function resolveQueueHeadKnownProviderDeliveryAcceptance(): ClaudeUnifiedPromptAcceptance | null {
    const next = queue[0];
    if (!next || readPromptDeliveryState(next) !== 'accepted') return null;
    return pendingProviderAcceptance?.batch === next
      ? pendingProviderAcceptance.acceptance
      : injectingProviderAcceptance?.batch === next
        ? injectingProviderAcceptance.acceptance
        : providerAcceptanceByBatch.get(next) ?? resolvePromptAcceptance(turnState);
  }

  async function reconcileTerminalCustodyWithCanonicalPending(): Promise<void> {
    for (let index = terminalCustody.length - 1; index >= 0; index -= 1) {
      const custody = terminalCustody[index];
      if (!custody) continue;
      const deliveryState = readPromptDeliveryState(custody.batch);
      if (deliveryState === 'pending') continue;
      terminalCustody.splice(index, 1);
      if (deliveryState === 'accepted') {
        await acceptTerminalCustody(custody);
        continue;
      }
      providerAcceptanceByBatch.delete(custody.batch);
      clearInjectionAcceptanceForBatch(custody.batch);
      if (lastInjectedNotifiedBatch === custody.batch) {
        lastInjectedNotifiedBatch = null;
      }
    }
    if (!pendingProviderAcceptance && queue.length === 0) {
      headInputState = terminalCustody.length > 0 ? 'terminal_custody' : null;
    }
  }

  async function confirmPromptAcceptedByProviderMatching(
    matcher: (batch: ClaudeUnifiedPromptBatch<Mode>) => boolean,
    optsOverride?: Readonly<{
      includeTerminalCustody?: boolean;
    }> | undefined,
  ): Promise<boolean> {
    if (optsOverride?.includeTerminalCustody === true) {
      const matchingBatches = new Set<ClaudeUnifiedPromptBatch<Mode>>();
      for (const entry of terminalCustody) {
        if (matcher(entry.batch)) matchingBatches.add(entry.batch);
      }
      for (const batch of queue) {
        if (matcher(batch)) matchingBatches.add(batch);
      }
      // Prompt-only hooks carry no Pending localId. When more than one live delivery candidate
      // matches the same prompt, choosing by FIFO would infer identity and a duplicate hook could
      // settle its neighbor. Exact transcript identity may still resolve either row later.
      if (matchingBatches.size !== 1) return false;
      const [matchingBatch] = matchingBatches;
      const terminalCustodyIndex = terminalCustody.findIndex((entry) => entry.batch === matchingBatch);
      if (terminalCustodyIndex >= 0) {
        const [confirmedCustody] = terminalCustody.splice(terminalCustodyIndex, 1);
        if (!confirmedCustody) return false;
        await acceptTerminalCustody(confirmedCustody);
        return true;
      }
    }
    const pendingAcceptance = pendingProviderAcceptance;
    if (!pendingAcceptance) {
      const injectingAcceptance = injectingProviderAcceptance;
      if (!injectingAcceptance) return false;
      const injectingBatch = queue[0];
      if (injectingBatch !== injectingAcceptance.batch) return false;
      if (!matcher(injectingBatch)) return false;
      providerAcceptanceObservedDuringInjection = injectingAcceptance;
      return true;
    }
    const next = queue[0];
    if (next !== pendingAcceptance.batch) return false;
    if (!matcher(next)) return false;
    queue.shift();
    await acceptBatch(next, pendingAcceptance.acceptance);
    return true;
  }

  async function confirmPromptAcceptedByProvider(): Promise<boolean> {
    return confirmPromptAcceptedByProviderMatching((batch) => !isPendingQueueBatch(batch));
  }

  async function observePromptCustodyByTerminal(batch: ClaudeUnifiedPromptBatch<Mode>): Promise<boolean> {
    if (disposed || queue[0] !== batch) return false;
    const currentAcceptance = pendingProviderAcceptance;
    if (!currentAcceptance || currentAcceptance.batch !== batch) return false;

    queue.shift();
    if (pendingProviderAcceptance?.batch === batch) {
      pendingProviderAcceptance = null;
      clearPendingSteerArming();
    }
    pendingAcceptanceCompletedCompaction = false;
    lastFailureReason = null;
    if (!terminalCustody.some((entry) => entry.batch === batch)) {
      terminalCustody.push(currentAcceptance);
    }
    clearInjectionAcceptanceForBatch(batch);
    headInputState = queue.length > 0 ? 'waiting_for_readiness' : 'terminal_custody';
    if (queue.length > 0) {
      scheduleRetryDrain(0);
    }
    return true;
  }

  async function observePendingProviderAcceptanceTerminalFailure(): Promise<boolean> {
    if (disposed) return false;
    const failedAcceptance = pendingProviderAcceptance;
    if (!failedAcceptance || queue[0] !== failedAcceptance.batch) return false;

    const { batch } = failedAcceptance;
    const result = buildObservedProviderAcceptanceTerminalFailureResult();
    if (pendingProviderAcceptance?.batch === batch) {
      pendingProviderAcceptance = null;
      clearPendingSteerArming();
    }
    pendingAcceptanceCompletedCompaction = false;
    if (queue[0] === batch) {
      queue.shift();
      terminalCustody.push(failedAcceptance);
    }
    lastFailureReason = result.reason;
    headInputState = queue.length > 0 ? 'waiting_for_readiness' : 'terminal_custody';
    const handling = await notifyInjectionFailure({
      batch,
      result,
      failureState: 'failed_ambiguous',
    });
    if (isClaimedPendingDeliveryHandling(handling) && dropClaimedPendingDeliveryBatch(batch)) {
      scheduleRetryDrain(0);
    }
    return isHandledInjectionFailure(handling);
  }

  const runDrain = async (): Promise<void> => {
    clearRetryDrainTimer();
    await reconcileTerminalCustodyWithCanonicalPending();
    while (!disposed && queue.length > 0) {
      const knownProviderDeliveryAcceptance = resolveQueueHeadKnownProviderDeliveryAcceptance();
      if (knownProviderDeliveryAcceptance) {
        const acceptedHead = queue.shift();
        if (acceptedHead) {
          await acceptBatch(acceptedHead, knownProviderDeliveryAcceptance);
        }
        continue;
      }
      if (pendingProviderAcceptance) {
        const submittedAcceptance = pendingProviderAcceptance;
        if (!isCompactPrompt(submittedAcceptance.batch)) {
          headInputState = 'awaiting_provider_acceptance';
          return;
        }
        if (compactionActive || !pendingAcceptanceCompletedCompaction) {
          headInputState = 'awaiting_provider_acceptance';
          return;
        }
        pendingProviderAcceptance = null;
        pendingAcceptanceCompletedCompaction = false;
        clearPendingSteerArming();
        // Compaction completion is provider acceptance of a pending /compact prompt.
        // Consume it so a PostCompact hook racing ahead of the compact_boundary
        // transcript row cannot leave /compact at the queue head and re-inject it.
        if (queue[0] === submittedAcceptance.batch) {
          queue.shift();
          await acceptBatch(submittedAcceptance.batch, submittedAcceptance.acceptance);
          continue;
        }
      }
      if (compactionActive) {
        lastDeferredReason = 'compaction';
        clearCurrentHeadBlocker();
        headInputState = 'waiting_for_readiness';
        return;
      }
      if (headInputState === 'failed_ambiguous' || headInputState === 'failed_terminal') {
        return;
      }
      const next = queue[0];
      if (next.pendingProviderAction === 'steer' && turnState !== 'running') {
        if (await failExactDelivery(next) === 'dropped') continue;
        return;
      }
      if (next.pendingProviderAction === 'interrupt_and_send' && turnState === 'running') {
        if (!opts.interruptActiveTurn) {
          if (await failExactDelivery(next) === 'dropped') continue;
          return;
        }
        if (!interruptRequestedBatches.has(next)) {
          interruptRequestedBatches.add(next);
          try {
            await opts.interruptActiveTurn();
          } catch {
            if (await failExactDelivery(next) === 'dropped') continue;
            return;
          }
        }
        if (disposed || queue[0] !== next) continue;
        if (turnState === 'running') {
          lastDeferredReason = 'terminal_busy';
          currentHeadBlocker = { kind: 'terminal_busy', source: 'readiness' };
          headInputState = 'waiting_for_readiness';
          scheduleRetryDrain(busyTurnFallbackWakeMs);
          return;
        }
        continue;
      }
      const bypassQuietWindowForRunningSteer = next?.origin.kind === 'ui_pending' && turnState === 'running';
      const readiness = resolveTerminalInjectionReadiness({
        nowMs: nowMs(),
        firstObservedAtMs,
        outputObserved,
        lastOutputAtMs,
        permissionBlocked,
        turnState,
        userTyping,
        userTypingObservedAtMs,
      }, {
        quietPeriodMs: bypassQuietWindowForRunningSteer ? 0 : opts.quietPeriodMs,
        maxWaitMs: opts.maxWaitMs,
      });
      if (!readiness.ready) {
        lastDeferredReason = readiness.reason;
        currentHeadBlocker = resolveReadinessBlocker(readiness.reason);
        headInputState = 'waiting_for_readiness';
        // A deferral must never park without a wake (dropped-baton wedge): fall back to the
        // bounded re-drive delay when the readiness evaluation supplied no retry hint.
        scheduleRetryDrain(readiness.retryAfterMs ?? deferredRedriveFallbackMs);
        return;
      }

      let injectAsInFlightSteer = false;
      if (next.origin.kind === 'ui_pending' && turnState === 'running') {
        // In-flight steering (D19): evaluate the SCREEN before deciding. Claude's TUI natively
        // queues text typed mid-generation and submits it at turn end (probe P-D), so a safe
        // actively-generating screen can take the prompt now instead of holding it invisibly
        // until the turn ends. Slash commands and vetoed/unknown screens keep the existing
        // bounded defer-until-idle behavior.
        let steerSafe = false;
        let steerEvaluationAttempted = false;
        let steerTurnLikelyEnded = false;
        let canonicalTurnInactive = false;
        if (
          (next.pendingProviderAction === 'steer' || next.pendingProviderAction === undefined)
          && opts.evaluateInFlightSteer
          && !isNonSteerablePrompt(next)
        ) {
          steerEvaluationAttempted = true;
          try {
            const decision = await opts.evaluateInFlightSteer(next);
            steerSafe = decision.steer === true;
            steerTurnLikelyEnded = decision.turnLikelyEnded === true;
          } catch {
            steerSafe = false;
          }
        }
        canonicalTurnInactive = readCanonicalTurnInactive();
        if (canonicalTurnInactive) {
          steerSafe = false;
        }
        if (disposed || queue[0] !== next) continue;
        if (turnState !== 'running') continue;
        if (!steerSafe) {
          if (next.pendingProviderAction === 'steer') {
            if (await failExactDelivery(next) === 'dropped') continue;
            return;
          }
          // Stale-turn recovery (incident cmq7pyqkj, L1): a 'running' state with NO provider
          // lifecycle activity for a bounded window is treated as stale (e.g. set from replayed
          // transcript rows after a respawn, with no live turn behind it). When the steer
          // evaluation also proved an idle composer (`turnLikelyEnded`) — or no evaluation was
          // possible for this prompt (slash command / no evaluator) — drain the prompt normally
          // as a new turn instead of deferring forever. A veto without turn-end screen evidence
          // keeps the bounded deferred path (fail-closed).
          const screenAllowsStaleRecovery = !steerEvaluationAttempted || steerTurnLikelyEnded || canonicalTurnInactive;
          const lastProviderEvidenceMs = lastOutputAtMs ?? firstObservedAtMs;
          if (screenAllowsStaleRecovery && nowMs() - lastProviderEvidenceMs >= staleTurnRecoveryMs) {
            turnState = 'unknown';
            continue;
          }
          lastDeferredReason = 'terminal_busy';
          currentHeadBlocker = { kind: 'terminal_busy', source: 'readiness' };
          headInputState = 'waiting_for_readiness';
          // The turn-end lifecycle hook normally redrains this deferral. Schedule a
          // bounded fallback wake so a missing turn-end signal cannot starve the
          // prompt forever; re-evaluation re-defers while still running.
          scheduleRetryDrain(busyTurnFallbackWakeMs);
          return;
        }
        injectAsInFlightSteer = true;
      }
      const acceptance = resolvePromptAcceptance(turnState);
      const injectionAcceptance: PendingProviderAcceptance<Mode> = { batch: next, acceptance };
      providerAcceptanceByBatch.set(next, acceptance);
      headInputState = 'injecting';
      injectingProviderAcceptance = injectionAcceptance;
      let result: TerminalInputInjectionResult;
      try {
        result = await opts.injectPrompt(
          next,
          injectAsInFlightSteer ? { inFlightSteer: true } : undefined,
        );
      } catch (error) {
        clearInjectionAcceptanceForBatch(next);
        throw error;
      }
      if (injectingProviderAcceptance === injectionAcceptance) {
        injectingProviderAcceptance = null;
      }
      const providerAcceptedDuringInjection =
        providerAcceptanceObservedDuringInjection === injectionAcceptance;
      if (result.status === 'injected') {
        lastDeferredReason = null;
        lastFailureReason = null;
        clearCurrentHeadBlocker();
        pendingProviderAcceptance = injectionAcceptance;
        pendingAcceptanceCompletedCompaction = false;
        headInputState = 'awaiting_provider_acceptance';
        opts.onProviderAcceptancePending?.(next, acceptance, result.at);
        // Notify a successful injection at most once per batch. An ambiguous retry
        // re-injects the same batch; re-firing onPromptInjected would double-record
        // its accepted-echo bookkeeping and could suppress a later identical
        // terminal-typed prompt.
        if (lastInjectedNotifiedBatch !== next) {
          lastInjectedNotifiedBatch = next;
          const handling = await opts.onPromptInjected?.(next, acceptance, result);
          if (isClaimedPendingDeliveryHandling(handling) && dropClaimedPendingDeliveryBatch(next)) {
            continue;
          }
        }
        clearProviderAcceptanceObservedDuringInjection(injectionAcceptance);
        if (pendingProviderAcceptance?.batch !== next || queue[0] !== next) {
          return;
        }
        if (providerAcceptedDuringInjection) {
          queue.shift();
          await acceptBatch(next, acceptance);
          return;
        }
        if (acceptance.acceptedAs === 'in_flight_steer') {
          // Acceptance evidence arrives only at turn end. The fallback wake observes independent
          // lifecycle/screen evidence; elapsed time alone never manufactures a provider outcome.
          steerAcceptanceAwaitingTurnEnd = true;
          scheduleSteerTurnEndFallbackWake();
        }
        return;
      }
      clearProviderAcceptanceObservedDuringInjection(injectionAcceptance);
      if (result.status === 'deferred') {
        lastDeferredReason = result.reason;
        currentHeadBlocker = result.blocker ?? resolveReadinessBlocker(result.reason);
        pendingProviderAcceptance = null;
        pendingAcceptanceCompletedCompaction = false;
        clearPendingSteerArming();
        headInputState = 'waiting_for_readiness';
        // A deferral must never park without a wake (dropped-baton wedge, incident cmres6qwl:
        // zellij pane_initializing deferrals omit retryAfterMs): fall back to the bounded
        // re-drive delay so the head is re-evaluated when its blocking condition clears.
        scheduleRetryDrain(result.retryAfterMs ?? deferredRedriveFallbackMs);
        return;
      }
      lastFailureReason = result.reason;
      clearCurrentHeadBlocker();
      const failureAction = classifyClaudeUnifiedInjectionFailure(result, {
        retryAttempt,
        retryLimit: injectionRetryLimit,
        retryBaseDelayMs: injectionRetryBaseDelayMs,
      });
      if (failureAction.kind === 'retry') {
        pendingProviderAcceptance = null;
        pendingAcceptanceCompletedCompaction = false;
        clearPendingSteerArming();
        retryAttempt += 1;
        headInputState = 'failed_retryable';
        scheduleRetryDrain(failureAction.retryAfterMs);
        return;
      }
      if (failureAction.kind === 'retain_terminal_custody') {
        opts.onProviderAcceptancePending?.(next, acceptance);
        if (providerAcceptedDuringInjection && queue[0] === next) {
          queue.shift();
          await acceptBatch(next, acceptance);
          return;
        }
        pendingProviderAcceptance = null;
        pendingAcceptanceCompletedCompaction = false;
        clearPendingSteerArming();
        // Once bytes may have reached the terminal, automatic replay is unsafe, but that
        // uncertainty must not own Pending backpressure. Existing terminal custody retains the
        // exact correlation for late provider evidence while the server row exposes recovery.
        if (queue[0] === next) {
          queue.shift();
          terminalCustody.push(injectionAcceptance);
        }
        headInputState = queue.length > 0 ? 'waiting_for_readiness' : 'terminal_custody';
        let handling: ClaudeUnifiedPromptInjectionFailureHandling | undefined;
        try {
          handling = await notifyInjectionFailure({
            batch: next,
            result,
            failureState: 'failed_ambiguous',
          });
        } catch {
          handling = undefined;
        }
        if (!isHandledInjectionFailure(handling)) {
          lastFailureReason = result.reason;
          return;
        }
        if (queue.length > 0) {
          retryAttempt = 0;
          continue;
        }
        return;
      }
      pendingProviderAcceptance = null;
      pendingAcceptanceCompletedCompaction = false;
      clearPendingSteerArming();
      headInputState = 'failed_terminal';
      if (isDeterministicPreProviderInputRejection(result)) {
        const rejected = queue.shift();
        if (rejected) {
          providerAcceptanceByBatch.delete(rejected);
          void notifyInjectionFailure({
            batch: rejected,
            result,
            failureState: 'failed_terminal',
          }).catch(() => undefined);
        }
        headInputState = null;
        if (queue.length > 0) {
          retryAttempt = 0;
          continue;
        }
        return;
      }
      let handling: ClaudeUnifiedPromptInjectionFailureHandling | undefined;
      try {
        handling = await notifyInjectionFailure({
          batch: next,
          result,
          failureState: 'failed_terminal',
        });
      } catch {
        handling = undefined;
      }
      if (isClaimedPendingDeliveryHandling(handling) && dropClaimedPendingDeliveryBatch(next)) {
        if (queue.length > 0) {
          retryAttempt = 0;
          continue;
        }
      }
      return;
    }
  };

  async function drainWhenSafe(): Promise<void> {
    if (!draining) {
      draining = runDrain().finally(() => {
        draining = null;
      });
    }
    await draining;
  }

  function handBackUndeliverableBatches(batches: ReadonlyArray<ClaudeUnifiedPromptBatch<Mode>>): void {
    if (batches.length === 0) return;
    opts.onUndeliverableBatches?.(batches);
  }

  return {
    async enqueueUiMessage(batch) {
      if (disposed) {
        // The arbiter can never deliver this batch; hand it back instead of silently
        // swallowing it (races the pump's own disposed check).
        handBackUndeliverableBatches([batch]);
        return;
      }
      queue.push(batch);
      notifyPendingQueuePumpStateChangedIfNeeded();
    },
    observeLifecycle(observation) {
      observeLifecycle(observation);
      publishPendingInputInterruptAndRunLocalId();
    },
    observeUserTypingState,
    notifyTerminalComposerCleared,
    readPendingInputInterruptAndRunLocalId,
    claimPendingInputInterruptAndRun,
    async observePromptCustodyByTerminal(batch) {
      try {
        return await observePromptCustodyByTerminal(batch);
      } finally {
        notifyPendingQueuePumpStateChangedIfNeeded();
        publishPendingInputInterruptAndRunLocalId();
      }
    },
    async confirmPromptAcceptedByProvider() {
      try {
        return await confirmPromptAcceptedByProvider();
      } finally {
        notifyPendingQueuePumpStateChangedIfNeeded();
        publishPendingInputInterruptAndRunLocalId();
      }
    },
    async confirmPromptAcceptedByProviderIf(matcher) {
      try {
        return await confirmPromptAcceptedByProviderMatching(matcher, {
          includeTerminalCustody: true,
        });
      } finally {
        notifyPendingQueuePumpStateChangedIfNeeded();
        publishPendingInputInterruptAndRunLocalId();
      }
    },
    async observePendingProviderAcceptanceTerminalFailure() {
      try {
        return await observePendingProviderAcceptanceTerminalFailure();
      } finally {
        notifyPendingQueuePumpStateChangedIfNeeded();
      }
    },
    async drainWhenSafe() {
      try {
        await drainWhenSafe();
      } finally {
        notifyPendingQueuePumpStateChangedIfNeeded();
      }
    },
    waitForPendingQueuePumpStateChange,
    snapshot,
    dispose() {
      disposed = true;
      publishPendingInputInterruptAndRunLocalId();
      notifyPendingQueuePumpStateChanged();
      clearRetryDrainTimer();
      clearPendingSteerArming();
      // Anything still queued is undeliverable by this arbiter; hand it back to the owner before
      // clearing. The provider-acceptance-pending batch was already written and submitted to the
      // provider-facing terminal, so returning it would risk duplicate execution. Ambiguous attempts
      // live outside this queue in terminal custody and are also never handed back.
      const acceptancePendingBatch = pendingProviderAcceptance?.batch ?? null;
      const undelivered = queue.splice(0, queue.length);
      handBackUndeliverableBatches(
        undelivered.filter((batch) => batch !== acceptancePendingBatch),
      );
      queue.length = 0;
      pendingProviderAcceptance = null;
      pendingAcceptanceCompletedCompaction = false;
      terminalCustody.length = 0;
      providerAcceptanceByBatch.clear();
      clearCurrentHeadBlocker();
      injectingProviderAcceptance = null;
      providerAcceptanceObservedDuringInjection = null;
      lastInjectedNotifiedBatch = null;
      headInputState = null;
    },
  };
}
