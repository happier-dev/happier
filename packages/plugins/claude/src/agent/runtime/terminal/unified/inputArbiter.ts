import type {
  TerminalInputInjectionResult,
  TerminalInputReadinessV1,
  TerminalPromptInput,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { classifyClaudeUnifiedInjectionFailure } from './injectionFailurePolicy.js';
import { normalizeClaudeUnifiedPromptIdentityText } from './promptIdentity.js';

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
  agentTurnId?: string;
}>;

export type ClaudeUnifiedPromptInjectionFailure = Readonly<{
  input: TerminalPromptInput;
  result: Extract<TerminalInputInjectionResult, { status: 'failed' }>;
  failureState: Extract<ClaudeUnifiedInputState, 'failed_ambiguous' | 'failed_terminal'>;
}>;

export type ClaudeUnifiedPromptDeliveryBlockedReason =
  | 'provider_rejected_before_acceptance'
  | 'provider_unavailable_before_acceptance'
  | 'terminal_composer_draft'
  | 'capture_style_unavailable'
  | 'runtime_config_blocked'
  | 'resume_identity_mismatch'
  | 'terminal_host_unreachable'
  | 'ambiguous_terminal_delivery';

export function isClaudeUnifiedPromptDeliveryBlockReversible(
  reason: ClaudeUnifiedPromptDeliveryBlockedReason,
): boolean {
  return reason === 'terminal_composer_draft'
    || reason === 'runtime_config_blocked'
    || reason === 'provider_unavailable_before_acceptance';
}

export type ClaudeUnifiedPromptTerminalRejection = Readonly<{
  deliveryBlockedReason?: ClaudeUnifiedPromptDeliveryBlockedReason;
}>;

export type ClaudeUnifiedHeadDeliveryBlocker = Readonly<{
  reason: ClaudeUnifiedPromptDeliveryBlockedReason;
}>;

export type ClaudeUnifiedInputArbiterSnapshot = Readonly<{
  queuedCount: number;
  pendingInjectionCount: number;
  terminalCustodyCount: number;
  providerAcceptancePendingCount: number;
  disposed: boolean;
  headInputState: ClaudeUnifiedInputState | null;
  headDeliveryBlocker: ClaudeUnifiedHeadDeliveryBlocker | null;
  lastDeferredReason: string | null;
  lastFailureReason: string | null;
}>;

export type ClaudeUnifiedInputArbiter = Readonly<{
  enqueue(input: TerminalPromptInput): void;
  /**
   * Enqueue a terminal-local control whose successful terminal write is its final acceptance
   * boundary. The returned promise settles only when that write succeeds or the control becomes
   * terminally undeliverable; provider-turn evidence is neither expected nor consumed.
   */
  enqueueTurnNeutralControl(input: TerminalPromptInput): Promise<void>;
  observeReadiness(readiness: TerminalInputReadinessV1): void;
  observeCompaction(event: Readonly<{ phase: 'started' | 'completed' }>): void;
  drain(): Promise<void>;
  retirePendingInputs(localIds: readonly string[]): readonly TerminalPromptInput[];
  confirmProviderAcceptance(evidence?: Readonly<{
    source?: 'prompt_submit' | 'transcript';
    promptText?: string;
    exactPromptText?: boolean;
    includeTimedOutAmbiguous?: boolean;
    agentTurnId?: string | null;
    acceptanceEvidenceId?: string;
  }>): Promise<boolean>;
  hasPendingProviderPrompt(promptText: string): boolean;
  observeTerminalPromptCustody(input: TerminalPromptInput): Promise<boolean>;
  readPendingInputInterruptAndRunLocalId(): string | null;
  claimPendingInputInterruptAndRun(localId: string): boolean;
  observePendingProviderAcceptanceTerminalFailure(
    rejection?: ClaudeUnifiedPromptTerminalRejection,
  ): boolean;
  blockHeadBeforeProvider(rejection: Required<ClaudeUnifiedPromptTerminalRejection>): boolean;
  clearHeadBeforeProviderBlock(reason: ClaudeUnifiedPromptDeliveryBlockedReason): boolean;
  rejectHeadBeforeProvider(rejection: Required<ClaudeUnifiedPromptTerminalRejection>): boolean;
  /**
   * User-authorized terminal composer clear wake: the terminal owner has verified that the
   * composer is empty and supplies the fresh writable readiness. The arbiter owns the queued
   * prompt retry scheduling, so the UI never needs a polling loop.
   */
  notifyTerminalComposerCleared(readinessAfterClear: TerminalInputReadinessV1): void;
  snapshot(): ClaudeUnifiedInputArbiterSnapshot;
  dispose(): void;
}>;

export type ClaudeUnifiedInputArbiterOptions = Readonly<{
  injectPrompt(input: TerminalPromptInput, delivery?: Readonly<{
    resolveDeliveryState: NonNullable<TerminalPromptInput['resolveDeliveryState']>;
  }>): Promise<TerminalInputInjectionResult>;
  onPromptInjected?: (
    input: TerminalPromptInput,
    acceptance: ClaudeUnifiedPromptAcceptance,
    result: Extract<TerminalInputInjectionResult, { status: 'injected' }>,
  ) => void | Promise<void>;
  onPromptAccepted?: (
    input: TerminalPromptInput,
    acceptance: ClaudeUnifiedPromptAcceptance,
  ) => void | Promise<void>;
  onPromptTerminallyRejectedBeforeProvider?: (
    input: TerminalPromptInput,
    result: Extract<TerminalInputInjectionResult, { status: 'failed' }>,
    rejection?: ClaudeUnifiedPromptTerminalRejection,
  ) => void | Promise<void>;
  resolvePromptTerminalRejection?: (
    input: TerminalPromptInput,
    result: Extract<TerminalInputInjectionResult, { status: 'failed' }>,
  ) => ClaudeUnifiedPromptTerminalRejection | null | undefined;
  onInjectionFailure?: (failure: ClaudeUnifiedPromptInjectionFailure) => void;
  /**
   * Undeliverable-input handback (ported HF-2 / F-1): inputs still queued when the arbiter is
   * disposed — including a failed head and the awaiting-provider-acceptance head (duplicate-attempt
   * direction; dedupe absorbs, silent loss does not) — and inputs enqueued after dispose are handed
   * back in FIFO order instead of being dropped. The caller re-pends them (e.g. message queue
   * unshift) so a respawn/relaunch can deliver them.
   */
  onUndeliverableInputs?: (inputs: readonly TerminalPromptInput[]) => void;
  onPendingInputInterruptAndRunLocalIdChange?: (localId: string | null) => void;
  injectionRetryLimit?: number;
  injectionRetryBaseDelayMs?: number;
}>;

type PendingProviderAcceptance = Readonly<{
  input: TerminalPromptInput;
  acceptance: ClaudeUnifiedPromptAcceptance;
}>;

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

function promptTextMatchesQueuedInput(
  input: TerminalPromptInput,
  promptText: string | undefined,
  exactPromptText: boolean,
): boolean {
  if (exactPromptText) return typeof promptText === 'string' && input.text === promptText;
  if (typeof promptText !== 'string') return true;
  const normalizedEvidence = normalizeClaudeUnifiedPromptIdentityText(promptText);
  if (!normalizedEvidence) return true;
  return normalizeClaudeUnifiedPromptIdentityText(input.text) === normalizedEvidence;
}

export function hasCanonicalPendingOwner(input: TerminalPromptInput): boolean {
  if (input.origin.kind !== 'ui_pending') return false;
  if (input.origin.localIds?.some((localId) => (
    typeof localId === 'string' && localId.trim().length > 0
  )) === true) {
    return true;
  }
  if (
    typeof input.origin.userMessageSeq === 'number' &&
    Number.isInteger(input.origin.userMessageSeq) &&
    input.origin.userMessageSeq >= 0
  ) {
    return true;
  }
  return input.origin.userMessageSeqs?.some((seq) => (
    Number.isInteger(seq) && seq >= 0
  )) === true;
}

function resolveReadinessDeliveryBlocker(
  readiness: TerminalInputReadinessV1 | null,
): ClaudeUnifiedHeadDeliveryBlocker | null {
  if (!readiness) return null;
  if (readiness.status === 'defer_user_typing' && readiness.reason === 'user_draft') {
    return { reason: 'terminal_composer_draft' };
  }
  if (readiness.status === 'defer_provider_starting' && readiness.reason === 'capture_style_unavailable') {
    return { reason: 'capture_style_unavailable' };
  }
  if (readiness.status === 'defer_provider_starting' && readiness.reason === 'provider_unavailable') {
    return { reason: 'provider_unavailable_before_acceptance' };
  }
  return null;
}

function buildTerminalRejectedBeforeProviderResult(
  readiness: TerminalInputReadinessV1 | null,
  rejection: Required<ClaudeUnifiedPromptTerminalRejection>,
): Extract<TerminalInputInjectionResult, { status: 'failed' }> {
  return {
    status: 'failed',
    reason: 'unsupported',
    phase: 'readiness',
    recoverable: false,
    duplicateRisk: 'none',
    observedAt: Date.now(),
    diagnostic: rejection.deliveryBlockedReason,
    ...(readiness?.hostKind ? { hostKind: readiness.hostKind } : {}),
    ...(readiness?.hostSessionName ? { hostSessionName: readiness.hostSessionName } : {}),
    ...(readiness?.paneId ? { paneId: readiness.paneId } : {}),
  };
}

export function createClaudeUnifiedInputArbiter(
  options: ClaudeUnifiedInputArbiterOptions,
): ClaudeUnifiedInputArbiter {
  const queue: TerminalPromptInput[] = [];
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
  let drainInFlight: Promise<void> | null = null;
  let pendingProviderAcceptance: PendingProviderAcceptance | null = null;
  let injectingProviderAcceptance: PendingProviderAcceptance | null = null;
  let providerAcceptanceObservedDuringInjection: PendingProviderAcceptance | null = null;
  let retainedHeadDeliveryBlocker: Readonly<{
    input: TerminalPromptInput;
    reason: ClaudeUnifiedPromptDeliveryBlockedReason;
  }> | null = null;
  const providerAcceptanceUnknownTerminalInputs = new Set<TerminalPromptInput>();
  // Closed evidence must outlive retired inputs: durable ambiguous attempts have no expiry.
  const closedAcceptanceEvidenceIds = new Set<string>();
  const terminalCustodyInputs = new Set<TerminalPromptInput>();
  const terminalCustodyAcceptances: PendingProviderAcceptance[] = [];
  // Claude's TUI can retain several in-flight steers before consuming any of them. Keep those
  // submitted inputs correlated in FIFO order while allowing the injection queue to continue.
  const submittedSteerAcceptances: PendingProviderAcceptance[] = [];
  const turnNeutralControlInputs = new WeakSet<TerminalPromptInput>();
  const turnNeutralControlWaiters = new Map<TerminalPromptInput, Readonly<{
    resolve: () => void;
    reject: (error: Error) => void;
  }>>();
  const interruptRequestedInputs = new WeakSet<object>();
  let publishedPendingInputInterruptAndRunLocalId: string | null | undefined;

  function readPendingInputInterruptAndRunLocalId(): string | null {
    if (disposed || !readiness?.activeTurnId) return null;
    const custodyHead = terminalCustodyAcceptances[0];
    if (!custodyHead || custodyHead.acceptance.acceptedAs !== 'in_flight_steer') return null;
    if (interruptRequestedInputs.has(custodyHead.input)) return null;
    const localIds = custodyHead.input.origin.localIds;
    return localIds?.length === 1 && typeof localIds[0] === 'string' && localIds[0].trim().length > 0
      ? localIds[0].trim()
      : null;
  }

  function publishPendingInputInterruptAndRunLocalId(): void {
    const localId = readPendingInputInterruptAndRunLocalId();
    if (publishedPendingInputInterruptAndRunLocalId === localId) return;
    publishedPendingInputInterruptAndRunLocalId = localId;
    options.onPendingInputInterruptAndRunLocalIdChange?.(localId);
  }

  function claimPendingInputInterruptAndRun(localId: string): boolean {
    if (readPendingInputInterruptAndRunLocalId() !== localId) return false;
    const custodyHead = terminalCustodyAcceptances[0];
    if (!custodyHead) return false;
    interruptRequestedInputs.add(custodyHead.input);
    publishPendingInputInterruptAndRunLocalId();
    return true;
  }

  const providerAcceptancePendingCount = (): number =>
    terminalCustodyAcceptances.length +
    submittedSteerAcceptances.length +
    (pendingProviderAcceptance ? 1 : 0);

  const pendingInjectionCount = (): number =>
    queue.reduce((count, input) => {
      if (pendingProviderAcceptance?.input === input) return count;
      if (providerAcceptanceUnknownTerminalInputs.has(input)) return count;
      return count + 1;
    }, 0);

  function snapshot(): ClaudeUnifiedInputArbiterSnapshot {
    return {
      queuedCount: queue.length + terminalCustodyAcceptances.length + submittedSteerAcceptances.length,
      pendingInjectionCount: pendingInjectionCount(),
      terminalCustodyCount: terminalCustodyAcceptances.length,
      providerAcceptancePendingCount: providerAcceptancePendingCount(),
      disposed,
      headInputState,
      headDeliveryBlocker: retainedHeadDeliveryBlocker
        ? { reason: retainedHeadDeliveryBlocker.reason }
        : queue.length > 0 ? resolveReadinessDeliveryBlocker(readiness) : null,
      lastDeferredReason,
      lastFailureReason,
    };
  }

  function clearRetryTimer(): void {
    if (!retryTimer) return;
    clearTimeout(retryTimer);
    retryTimer = null;
  }

  function settleTurnNeutralControl(input: TerminalPromptInput, error?: Error): void {
    const waiter = turnNeutralControlWaiters.get(input);
    if (!waiter) return;
    turnNeutralControlWaiters.delete(input);
    if (error) waiter.reject(error);
    else waiter.resolve();
  }

  function turnNeutralControlFailure(result: Extract<TerminalInputInjectionResult, { status: 'failed' }>): Error {
    return new Error(`claude_unified_terminal_control_injection_failed: ${result.reason}`);
  }

  function scheduleRetry(retryAfterMs: number): void {
    clearRetryTimer();
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void drain().catch(() => undefined);
    }, retryAfterMs);
    retryTimer.unref?.();
  }

  function clearInjectionAcceptanceForInput(input: TerminalPromptInput): void {
    if (injectingProviderAcceptance?.input === input) {
      injectingProviderAcceptance = null;
    }
    if (providerAcceptanceObservedDuringInjection?.input === input) {
      providerAcceptanceObservedDuringInjection = null;
    }
  }

  function takeProviderAcceptanceObservedDuringInjection(
    input: TerminalPromptInput,
  ): PendingProviderAcceptance | null {
    const acceptance = providerAcceptanceObservedDuringInjection?.input === input
      ? providerAcceptanceObservedDuringInjection
      : null;
    if (acceptance) {
      providerAcceptanceObservedDuringInjection = null;
    }
    return acceptance;
  }

  function removeTerminalCustodyAcceptance(input: TerminalPromptInput): PendingProviderAcceptance | null {
    const index = terminalCustodyAcceptances.findIndex((pending) => pending.input === input);
    if (index < 0) return null;
    const [pending] = terminalCustodyAcceptances.splice(index, 1);
    return pending ?? null;
  }

  function removeSubmittedSteerAcceptance(input: TerminalPromptInput): PendingProviderAcceptance | null {
    const index = submittedSteerAcceptances.findIndex((pending) => pending.input === input);
    if (index < 0) return null;
    const [pending] = submittedSteerAcceptances.splice(index, 1);
    return pending ?? null;
  }

  function notifyPromptTerminallyRejectedBeforeProvider(
    input: TerminalPromptInput,
    result: Extract<TerminalInputInjectionResult, { status: 'failed' }>,
    rejection: ClaudeUnifiedPromptTerminalRejection | undefined,
  ): void {
    if (!rejection?.deliveryBlockedReason) return;
    try {
      const notification = options.onPromptTerminallyRejectedBeforeProvider?.(input, result, rejection);
      void Promise.resolve(notification).catch(() => undefined);
    } catch {
      // Rejection notification is best-effort and must never mask the terminal failure.
    }
  }

  function resolvePromptTerminalRejection(
    input: TerminalPromptInput,
    result: Extract<TerminalInputInjectionResult, { status: 'failed' }>,
    explicitRejection: ClaudeUnifiedPromptTerminalRejection | undefined,
  ): ClaudeUnifiedPromptTerminalRejection | undefined {
    if (explicitRejection?.deliveryBlockedReason) return explicitRejection;
    const resolved = options.resolvePromptTerminalRejection?.(input, result) ?? undefined;
    return resolved?.deliveryBlockedReason ? resolved : undefined;
  }

  function terminalizeTerminalCustodyAcceptance(
    input: TerminalPromptInput,
    result: Extract<TerminalInputInjectionResult, { status: 'failed' }>,
    rejection?: ClaudeUnifiedPromptTerminalRejection,
  ): void {
    const pending = removeTerminalCustodyAcceptance(input);
    if (!pending) return;
    terminalCustodyInputs.delete(input);
    providerAcceptanceUnknownTerminalInputs.add(input);
    lastFailureReason = result.reason;
    headInputState = 'failed_terminal';
    notifyPromptTerminallyRejectedBeforeProvider(
      input,
      result,
      resolvePromptTerminalRejection(input, result, rejection),
    );
    options.onInjectionFailure?.({
      input,
      result,
      failureState: 'failed_terminal',
    });
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

  function withProviderTurnId(
    acceptance: ClaudeUnifiedPromptAcceptance,
    agentTurnId: string | null | undefined,
  ): ClaudeUnifiedPromptAcceptance {
    if (typeof agentTurnId !== 'string' || agentTurnId.trim().length === 0) return acceptance;
    return { ...acceptance, agentTurnId: agentTurnId.trim() };
  }

  async function acceptHeadPrompt(evidence?: Readonly<{
    source?: 'prompt_submit' | 'transcript';
    promptText?: string;
    exactPromptText?: boolean;
    includeTimedOutAmbiguous?: boolean;
    agentTurnId?: string | null;
    acceptanceEvidenceId?: string;
  }>): Promise<boolean> {
    const evidenceId = evidence?.acceptanceEvidenceId;
    if (evidenceId && closedAcceptanceEvidenceIds.has(evidenceId)) return false;
    const closeEvidence = () => {
      if (evidenceId) closedAcceptanceEvidenceIds.add(evidenceId);
    };
    if (typeof evidence?.promptText === 'string') {
      const matchingInputs = new Set<TerminalPromptInput>();
      for (const pending of terminalCustodyAcceptances) {
        if (promptTextMatchesQueuedInput(
          pending.input,
          evidence.promptText,
          evidence.exactPromptText === true,
        )) matchingInputs.add(pending.input);
      }
      for (const pending of submittedSteerAcceptances) {
        if (promptTextMatchesQueuedInput(
          pending.input,
          evidence.promptText,
          evidence.exactPromptText === true,
        )) matchingInputs.add(pending.input);
      }
      for (const input of queue) {
        if (promptTextMatchesQueuedInput(
          input,
          evidence.promptText,
          evidence.exactPromptText === true,
        )) matchingInputs.add(input);
      }
      // Native prompt_submitted evidence has text/turn identity but no Pending localId. More than
      // one text match is therefore ambiguous: FIFO selection could settle a neighbor on duplicate
      // evidence. A later exact identity source may still resolve either input.
      if (matchingInputs.size !== 1) {
        // An unknown prompt can arrive before registration. Only ambiguity closes its proof.
        if (matchingInputs.size > 1) closeEvidence();
        return false;
      }
    }
    const terminalCustodyAcceptance = terminalCustodyAcceptances[0];
    if (terminalCustodyAcceptance) {
      if (evidence?.source === 'prompt_submit' && terminalCustodyAcceptance.acceptance.acceptedAs === 'in_flight_steer') return false;
      if (!promptTextMatchesQueuedInput(
        terminalCustodyAcceptance.input,
        evidence?.promptText,
        evidence?.exactPromptText === true,
      )) return false;
      closeEvidence();
      terminalCustodyAcceptances.shift();
      await acceptPrompt({
        ...terminalCustodyAcceptance,
        acceptance: withProviderTurnId(terminalCustodyAcceptance.acceptance, evidence?.agentTurnId),
      });
      return true;
    }

    const submittedSteerAcceptance = submittedSteerAcceptances[0];
    if (submittedSteerAcceptance) {
      if (evidence?.source === 'prompt_submit' && submittedSteerAcceptance.acceptance.acceptedAs === 'in_flight_steer') return false;
      if (!promptTextMatchesQueuedInput(
        submittedSteerAcceptance.input,
        evidence?.promptText,
        evidence?.exactPromptText === true,
      )) return false;
      closeEvidence();
      submittedSteerAcceptances.shift();
      await acceptPrompt({
        ...submittedSteerAcceptance,
        acceptance: withProviderTurnId(submittedSteerAcceptance.acceptance, evidence?.agentTurnId),
      });
      return true;
    }

    const pending = pendingProviderAcceptance;
    if (!pending) {
      const injecting = injectingProviderAcceptance;
      if (!injecting || queue[0] !== injecting.input) return false;
      if (evidence?.source === 'prompt_submit' && injecting.acceptance.acceptedAs === 'in_flight_steer') return false;
      if (!promptTextMatchesQueuedInput(
        injecting.input,
        evidence?.promptText,
        evidence?.exactPromptText === true,
      )) return false;
      closeEvidence();
      providerAcceptanceObservedDuringInjection = {
        ...injecting,
        acceptance: withProviderTurnId(injecting.acceptance, evidence?.agentTurnId),
      };
      return true;
    }
    if (queue[0] !== pending.input) return false;
    if (evidence?.source === 'prompt_submit' && pending.acceptance.acceptedAs === 'in_flight_steer') return false;
    if (!promptTextMatchesQueuedInput(
      pending.input,
      evidence?.promptText,
      evidence?.exactPromptText === true,
    )) return false;

    closeEvidence();
    queue.shift();
    await acceptPrompt({
      ...pending,
      acceptance: withProviderTurnId(pending.acceptance, evidence?.agentTurnId),
    });
    return true;
  }

  async function acceptPrompt(pending: PendingProviderAcceptance): Promise<void> {
    if (pendingProviderAcceptance?.input === pending.input) {
      pendingProviderAcceptance = null;
    }
    providerAcceptanceUnknownTerminalInputs.delete(pending.input);
    terminalCustodyInputs.delete(pending.input);
    removeSubmittedSteerAcceptance(pending.input);
    removeTerminalCustodyAcceptance(pending.input);
    retryAttempt = 0;
    lastDeferredReason = null;
    lastFailureReason = null;
    headInputState = 'submitted';
    await options.onPromptAccepted?.(pending.input, pending.acceptance);
    if (pendingProviderAcceptance || submittedSteerAcceptances.length > 0) {
      headInputState = 'awaiting_provider_acceptance';
    } else if (queue.length > 0) {
      headInputState = 'queued';
    }
  }

  async function observeTerminalPromptCustody(input: TerminalPromptInput): Promise<boolean> {
    if (disposed) return false;
    const currentAcceptance = pendingProviderAcceptance?.input === input
      ? pendingProviderAcceptance
      : submittedSteerAcceptances.find((pending) => pending.input === input) ?? null;
    if (!currentAcceptance) return false;

    if (pendingProviderAcceptance?.input === input) {
      if (queue[0] !== input) return false;
      queue.shift();
      pendingProviderAcceptance = null;
    } else {
      removeSubmittedSteerAcceptance(input);
    }
    terminalCustodyInputs.add(input);
    terminalCustodyAcceptances.push(currentAcceptance);
    lastFailureReason = null;
    headInputState = 'awaiting_provider_acceptance';
    if (queue.length > 0) scheduleRetry(0);
    return true;
  }

  function observePendingProviderAcceptanceTerminalFailure(
    rejection?: ClaudeUnifiedPromptTerminalRejection,
  ): boolean {
    if (disposed) return false;
    if (submittedSteerAcceptances.length > 0) {
      const submitted = submittedSteerAcceptances.splice(0, submittedSteerAcceptances.length);
      for (const acceptance of submitted) {
        terminalCustodyInputs.add(acceptance.input);
        terminalCustodyAcceptances.push(acceptance);
      }
    }
    const terminalCustodyAcceptance = terminalCustodyAcceptances[0];
    if (terminalCustodyAcceptance) {
      const result = buildProviderAcceptanceTimeoutResult(readiness);
      const resolvedRejection = resolvePromptTerminalRejection(
        terminalCustodyAcceptance.input,
        result,
        rejection,
      );
      if (resolvedRejection?.deliveryBlockedReason
        && resolvedRejection.deliveryBlockedReason !== 'ambiguous_terminal_delivery') {
        terminalizeTerminalCustodyAcceptance(
          terminalCustodyAcceptance.input,
          result,
          resolvedRejection,
        );
        return true;
      }
      lastFailureReason = result.reason;
      headInputState = 'awaiting_provider_acceptance';
      options.onInjectionFailure?.({
        input: terminalCustodyAcceptance.input,
        result,
        failureState: 'failed_ambiguous',
      });
      return true;
    }
    const pending = pendingProviderAcceptance;
    if (!pending || queue[0] !== pending.input) return false;

    const { input } = pending;
    const result = buildProviderAcceptanceTimeoutResult(readiness);
    const resolvedRejection = resolvePromptTerminalRejection(input, result, rejection);
    if (!resolvedRejection?.deliveryBlockedReason
      || resolvedRejection.deliveryBlockedReason === 'ambiguous_terminal_delivery') {
      queue.shift();
      if (pendingProviderAcceptance?.input === input) {
        pendingProviderAcceptance = null;
      }
      terminalCustodyInputs.add(input);
      terminalCustodyAcceptances.push(pending);
      lastFailureReason = result.reason;
      headInputState = queue.length > 0 ? 'queued' : 'awaiting_provider_acceptance';
      options.onInjectionFailure?.({
        input,
        result,
        failureState: 'failed_ambiguous',
      });
      if (queue.length > 0) scheduleRetry(0);
      return true;
    }
    if (pendingProviderAcceptance?.input === input) {
      pendingProviderAcceptance = null;
    }
    providerAcceptanceUnknownTerminalInputs.add(input);
    lastFailureReason = result.reason;
    headInputState = 'failed_terminal';
    notifyPromptTerminallyRejectedBeforeProvider(
      input,
      result,
      resolvedRejection,
    );
    options.onInjectionFailure?.({
      input,
      result,
      failureState: 'failed_terminal',
    });
    return true;
  }

  function rejectHeadBeforeProvider(
    rejection: Required<ClaudeUnifiedPromptTerminalRejection>,
  ): boolean {
    if (disposed) return false;
    const input = queue[0];
    if (!input) return false;
    if (!hasCanonicalPendingOwner(input)) return false;
    if (pendingProviderAcceptance?.input === input || injectingProviderAcceptance?.input === input) return false;
    if (retainedHeadDeliveryBlocker?.input === input) return false;

    queue.shift();
    clearRetryTimer();
    retryAttempt = 0;
    lastDeferredReason = null;
    lastFailureReason = rejection.deliveryBlockedReason;
    headInputState = queue.length > 0 ? 'queued' : 'failed_terminal';
    notifyPromptTerminallyRejectedBeforeProvider(
      input,
      buildTerminalRejectedBeforeProviderResult(readiness, rejection),
      rejection,
    );
    if (queue.length > 0) scheduleRetry(0);
    return true;
  }

  function blockHeadBeforeProvider(
    rejection: Required<ClaudeUnifiedPromptTerminalRejection>,
  ): boolean {
    if (disposed) return false;
    if (!isClaudeUnifiedPromptDeliveryBlockReversible(rejection.deliveryBlockedReason)) return false;
    const input = queue[0];
    if (!input || !hasCanonicalPendingOwner(input)) return false;
    if (pendingProviderAcceptance?.input === input || injectingProviderAcceptance?.input === input) return false;
    if (retainedHeadDeliveryBlocker?.input === input) return false;

    clearRetryTimer();
    retryAttempt = 0;
    retainedHeadDeliveryBlocker = { input, reason: rejection.deliveryBlockedReason };
    lastFailureReason = rejection.deliveryBlockedReason;
    headInputState = 'waiting_for_readiness';
    notifyPromptTerminallyRejectedBeforeProvider(
      input,
      buildTerminalRejectedBeforeProviderResult(readiness, rejection),
      rejection,
    );
    return true;
  }

  function clearHeadBeforeProviderBlock(reason: ClaudeUnifiedPromptDeliveryBlockedReason): boolean {
    if (disposed) return false;
    const retained = retainedHeadDeliveryBlocker;
    if (!retained || retained.reason !== reason || queue[0] !== retained.input) return false;

    retainedHeadDeliveryBlocker = null;
    lastDeferredReason = null;
    lastFailureReason = null;
    headInputState = 'queued';
    if (!pendingProviderAcceptance) scheduleRetry(0);
    return true;
  }

  function retirePendingInputs(localIds: readonly string[]): readonly TerminalPromptInput[] {
    if (disposed) return [];
    const retiredIds = new Set(localIds);
    const candidates = new Set([
      ...queue,
      ...terminalCustodyAcceptances.map(({ input }) => input),
      ...submittedSteerAcceptances.map(({ input }) => input),
    ]);
    const retired: TerminalPromptInput[] = [];
    for (const input of candidates) {
      if (input.origin.kind !== 'ui_pending' || !input.origin.localIds?.length) continue;
      if (!input.origin.localIds.every((localId) => retiredIds.has(localId))) continue;
      const index = queue.indexOf(input);
      if (index >= 0) queue.splice(index, 1);
      if (pendingProviderAcceptance?.input === input) pendingProviderAcceptance = null;
      if (injectingProviderAcceptance?.input === input) injectingProviderAcceptance = null;
      if (retainedHeadDeliveryBlocker?.input === input) retainedHeadDeliveryBlocker = null;
      removeTerminalCustodyAcceptance(input);
      removeSubmittedSteerAcceptance(input);
      terminalCustodyInputs.delete(input);
      providerAcceptanceUnknownTerminalInputs.delete(input);
      retired.push(input);
    }
    if (retired.length > 0) {
      lastFailureReason = null;
      lastDeferredReason = null;
      headInputState = queue.length > 0 ? 'queued' : null;
      publishPendingInputInterruptAndRunLocalId();
      if (queue.length > 0) scheduleRetry(0);
    }
    return retired;
  }

  async function drainQueue(): Promise<void> {
    clearRetryTimer();
    while (!disposed && queue.length > 0) {
      if (pendingProviderAcceptance) {
        headInputState = 'awaiting_provider_acceptance';
        return;
      }
      if (retainedHeadDeliveryBlocker?.input === queue[0]) {
        headInputState = 'waiting_for_readiness';
        return;
      }
      if (compactionActive) {
        lastDeferredReason = 'compaction';
        headInputState = 'waiting_for_readiness';
        return;
      }
      if (headInputState === 'failed_ambiguous' || headInputState === 'failed_terminal') {
        return;
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
      const injectionAcceptance = { input, acceptance };
      headInputState = 'injecting';
      injectingProviderAcceptance = injectionAcceptance;
      let result: TerminalInputInjectionResult;
      try {
        result = await options.injectPrompt(input, {
          resolveDeliveryState: () => {
            if (providerAcceptanceObservedDuringInjection?.input === input) return 'accepted';
            if (disposed || !queue.includes(input)) return 'retired';
            return null;
          },
        });
      } catch (error) {
        clearInjectionAcceptanceForInput(input);
        throw error;
      }
      if (injectingProviderAcceptance?.input === input) {
        injectingProviderAcceptance = null;
      }

      // Host retirement can arrive while the terminal write is in flight. Do not resurrect its custody.
      if (!queue.includes(input)) continue;

      if (result.status === 'injected') {
        retryAttempt = 0;
        lastDeferredReason = null;
        lastFailureReason = null;
        if (turnNeutralControlInputs.has(input)) {
          queue.shift();
          takeProviderAcceptanceObservedDuringInjection(input);
          headInputState = queue.length > 0 ? 'queued' : 'submitted';
          settleTurnNeutralControl(input);
          if (queue.length > 0) continue;
          return;
        }
        pendingProviderAcceptance = injectionAcceptance;
        headInputState = 'awaiting_provider_acceptance';
        await options.onPromptInjected?.(input, acceptance, result);
        const providerAcceptedDuringInjection = takeProviderAcceptanceObservedDuringInjection(input);
        if (providerAcceptedDuringInjection) {
          if (pendingProviderAcceptance?.input !== input || queue[0] !== input) return;
          queue.shift();
          await acceptPrompt(providerAcceptedDuringInjection);
          return;
        }
        if (acceptance.acceptedAs === 'in_flight_steer') {
          queue.shift();
          pendingProviderAcceptance = null;
          submittedSteerAcceptances.push(injectionAcceptance);
          headInputState = queue.length > 0 ? 'queued' : 'awaiting_provider_acceptance';
          if (queue.length > 0) continue;
        }
        return;
      }

      if (
        !turnNeutralControlInputs.has(input)
        && result.status === 'failed'
        && result.phase === 'after_enter_unknown'
      ) {
        const providerAcceptedDuringInjection = takeProviderAcceptanceObservedDuringInjection(input);
        if (providerAcceptedDuringInjection) {
          if (queue[0] !== input) return;
          queue.shift();
          await acceptPrompt(providerAcceptedDuringInjection);
          return;
        }
      }

      clearInjectionAcceptanceForInput(input);
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
      });

      if (action.kind === 'retry') {
        retryAttempt += 1;
        headInputState = 'failed_retryable';
        scheduleRetry(action.retryAfterMs);
        return;
      }
      if (action.kind === 'await_provider_confirmation') {
        if (turnNeutralControlInputs.has(input)) {
          queue.shift();
          clearInjectionAcceptanceForInput(input);
          retryAttempt = 0;
          headInputState = queue.length > 0 ? 'queued' : 'failed_ambiguous';
          settleTurnNeutralControl(input, turnNeutralControlFailure(result));
          if (queue.length > 0) continue;
          return;
        }
        pendingProviderAcceptance = injectionAcceptance;
        providerAcceptanceUnknownTerminalInputs.add(input);
        headInputState = 'awaiting_provider_acceptance';
        return;
      }
      if (action.kind === 'handoff_ambiguous_failure') {
        queue.shift();
        retryAttempt = 0;
        lastDeferredReason = null;
        headInputState = queue.length > 0 ? 'queued' : null;
        if (!turnNeutralControlInputs.has(input)) {
          options.onInjectionFailure?.({
            input,
            result,
            failureState: 'failed_ambiguous',
          });
        }
        settleTurnNeutralControl(input, turnNeutralControlFailure(result));
        if (queue.length > 0) continue;
        return;
      }

      if (result.reason === 'invalid_prompt_text') {
        queue.shift();
        retryAttempt = 0;
        lastDeferredReason = null;
        lastFailureReason = null;
        headInputState = queue.length > 0 ? 'queued' : 'failed_terminal';
        if (!turnNeutralControlInputs.has(input)) {
          await options.onPromptTerminallyRejectedBeforeProvider?.(input, result);
        }
        settleTurnNeutralControl(input, turnNeutralControlFailure(result));
        if (!turnNeutralControlInputs.has(input)) {
          options.onInjectionFailure?.({
            input,
            result,
            failureState: 'failed_terminal',
          });
        }
        if (queue.length > 0) {
          headInputState = 'queued';
          continue;
        }
        return;
      }

      if (turnNeutralControlInputs.has(input)) {
        queue.shift();
        headInputState = queue.length > 0 ? 'queued' : 'failed_terminal';
        settleTurnNeutralControl(input, turnNeutralControlFailure(result));
      } else {
        headInputState = 'failed_terminal';
      }
      if (!turnNeutralControlInputs.has(input)) {
        options.onInjectionFailure?.({
          input,
          result,
          failureState: 'failed_terminal',
        });
      }
      if (queue.length > 0) continue;
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

  function handBackUndeliverableInputs(inputs: readonly TerminalPromptInput[]): void {
    if (inputs.length === 0) return;
    try {
      options.onUndeliverableInputs?.(inputs);
    } catch {
      // Handback is best-effort; it must never mask disposal.
    }
  }

  return {
    enqueue(input) {
      if (disposed) {
        handBackUndeliverableInputs([input]);
        return;
      }
      queue.push(input);
      if (!headInputState) headInputState = 'queued';
    },
    enqueueTurnNeutralControl(input) {
      if (disposed) {
        return Promise.reject(new Error('claude_unified_terminal_control_arbiter_disposed'));
      }
      turnNeutralControlInputs.add(input);
      const completion = new Promise<void>((resolve, reject) => {
        turnNeutralControlWaiters.set(input, { resolve, reject });
      });
      queue.push(input);
      if (!headInputState) headInputState = 'queued';
      void drain().catch((error: unknown) => {
        settleTurnNeutralControl(
          input,
          error instanceof Error ? error : new Error('claude_unified_terminal_control_injection_failed'),
        );
      });
      return completion;
    },
    observeReadiness(nextReadiness) {
      readiness = nextReadiness;
      publishPendingInputInterruptAndRunLocalId();
      if (
        queue.length > 0
        && !pendingProviderAcceptance
        && !retainedHeadDeliveryBlocker
        && !isDeferredReadiness(nextReadiness.status)
      ) {
        void drain().catch(() => undefined);
      }
    },
    observeCompaction(event) {
      compactionActive = event.phase === 'started';
      if (event.phase === 'started') {
        lastDeferredReason = 'compaction';
      }
    },
    drain,
    retirePendingInputs,
    async confirmProviderAcceptance(evidence) {
      try {
        return await acceptHeadPrompt(evidence);
      } finally {
        publishPendingInputInterruptAndRunLocalId();
      }
    },
    hasPendingProviderPrompt(promptText) {
      return [...terminalCustodyAcceptances, ...submittedSteerAcceptances, pendingProviderAcceptance, injectingProviderAcceptance]
        .some((pending) => pending && promptTextMatchesQueuedInput(pending.input, promptText, false));
    },
    async observeTerminalPromptCustody(input) {
      try {
        return await observeTerminalPromptCustody(input);
      } finally {
        publishPendingInputInterruptAndRunLocalId();
      }
    },
    readPendingInputInterruptAndRunLocalId,
    claimPendingInputInterruptAndRun,
    observePendingProviderAcceptanceTerminalFailure,
    blockHeadBeforeProvider,
    clearHeadBeforeProviderBlock,
    rejectHeadBeforeProvider,
    notifyTerminalComposerCleared(readinessAfterClear) {
      if (disposed) return;
      readiness = readinessAfterClear;
      clearHeadBeforeProviderBlock('terminal_composer_draft');
      if (headInputState === 'waiting_for_readiness') {
        lastDeferredReason = null;
      }
      if (queue.length > 0 && !pendingProviderAcceptance) {
        scheduleRetry(0);
      }
    },
    snapshot,
    dispose() {
      if (disposed) return;
      disposed = true;
      publishPendingInputInterruptAndRunLocalId();
      clearRetryTimer();
      const retainedInput = retainedHeadDeliveryBlocker?.input ?? null;
      const unconsumed = queue.splice(0, queue.length);
      handBackUndeliverableInputs(
        unconsumed.filter((input) => (
          !providerAcceptanceUnknownTerminalInputs.has(input)
          && input !== retainedInput
          && !turnNeutralControlInputs.has(input)
        )),
      );
      for (const input of unconsumed) {
        if (turnNeutralControlInputs.has(input)) {
          settleTurnNeutralControl(
            input,
            new Error('claude_unified_terminal_control_arbiter_disposed'),
          );
        }
      }
      retainedHeadDeliveryBlocker = null;
      pendingProviderAcceptance = null;
      injectingProviderAcceptance = null;
      providerAcceptanceObservedDuringInjection = null;
      providerAcceptanceUnknownTerminalInputs.clear();
      closedAcceptanceEvidenceIds.clear();
      terminalCustodyInputs.clear();
      terminalCustodyAcceptances.length = 0;
      submittedSteerAcceptances.length = 0;
    },
  };
}
