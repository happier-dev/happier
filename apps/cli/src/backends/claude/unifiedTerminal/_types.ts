import type { DrainPendingOptions, DrainPendingResult, MessageBatch } from '@/agent/runtime/sessionInput/types';
import type {
  TerminalHostLiveness,
  TerminalInputInjectionResult,
  TerminalLifecycleObservation,
  TerminalPromptInput,
  TerminalTurnState,
} from '@/agent/runtime/terminal/_types';
import type { ClaudeScreenState } from './tuiControls/screenState';

export type ClaudeUnifiedPromptOrigin = Readonly<{
  kind: 'ui_pending' | 'ui_immediate' | 'rpc';
  clientId?: string | undefined;
  nonce?: string | undefined;
}>;

export type ClaudeUnifiedPromptBatch<Mode = unknown> = Readonly<{
  message: string;
  mode?: Mode | undefined;
  origin: ClaudeUnifiedPromptOrigin;
  /**
   * Owed-delivery watermark attribution (A3-HIGH-1): max server user-row seq among the queue
   * items batched into this prompt (null/absent when unattributed). Persisted as the delivered
   * watermark only at provider acceptance.
   */
  maxUserMessageSeq?: number | null;
  /**
   * Local ids for the same user rows. Used when provider acceptance happens before the server
   * socket echo provides a durable seq.
   */
  userMessageLocalIds?: readonly string[];
  pendingProviderAction?: import('@/agent/runtime/modeMessageQueue').PendingProviderAction;
  providerAcceptancePending?: boolean;
}>;

export type ClaudeUnifiedPromptAcceptance = Readonly<{
  acceptedAs: 'new_turn' | 'in_flight_steer';
  turnStateAtInjection: TerminalTurnState;
}>;

export type ClaudeUnifiedPromptDeliveryState = 'pending' | 'accepted' | 'retired';

export type ClaudeUnifiedPromptAcceptedHandler<Mode = unknown> = (
  batch: ClaudeUnifiedPromptBatch<Mode>,
  acceptance: ClaudeUnifiedPromptAcceptance,
) => void | Promise<void>;

export type ClaudeUnifiedPromptProviderAcceptancePendingHandler<Mode = unknown> = (
  batch: ClaudeUnifiedPromptBatch<Mode>,
  acceptance: ClaudeUnifiedPromptAcceptance,
  observedAtMs?: number | undefined,
) => void;

export type ClaudeUnifiedPromptInjectedHandler<Mode = unknown> = (
  batch: ClaudeUnifiedPromptBatch<Mode>,
  acceptance: ClaudeUnifiedPromptAcceptance,
  result: Extract<TerminalInputInjectionResult, { status: 'injected' }>,
) => ClaudeUnifiedPromptInjectionFailureHandling | Promise<ClaudeUnifiedPromptInjectionFailureHandling>;

export type ClaudeUnifiedPromptInjectionFailure<Mode = unknown> = Readonly<{
  batch: ClaudeUnifiedPromptBatch<Mode>;
  result: Extract<TerminalInputInjectionResult, { status: 'failed' }>;
  failureState: 'failed_ambiguous' | 'failed_terminal';
}>;

export type ClaudeUnifiedPromptInjectionFailureHandling =
  | Readonly<{ action: 'claimed_pending_delivery' }>
  | Readonly<{ action: 'surfaced_runtime_issue' }>
  | void;

export type ClaudeUnifiedPromptInjectionFailureHandler<Mode = unknown> = (
  failure: ClaudeUnifiedPromptInjectionFailure<Mode>,
) => ClaudeUnifiedPromptInjectionFailureHandling | Promise<ClaudeUnifiedPromptInjectionFailureHandling>;

export type ClaudeUnifiedPromptInjectionOptions = Readonly<{
  /**
   * The prompt is being steered into a RUNNING turn (Claude's TUI queues it natively and submits it
   * at turn end). The injector must skip quiet-screen deferral: a generating screen is never quiet,
   * and the screen-state evaluation that authorized the steer already vetoed visible user drafts.
   */
  inFlightSteer?: boolean | undefined;
}>;

export type ClaudeUnifiedDeliveryBlocker = NonNullable<
  Extract<TerminalInputInjectionResult, { status: 'deferred' }>['blocker']
>;

export type ClaudeUnifiedTerminalScreenObservation = Readonly<{
  screenState: ClaudeScreenState;
  userMessageLocalIds?: readonly string[] | undefined;
}>;

export type ClaudeUnifiedPromptInjector<Mode = unknown> = Readonly<{
  injectPrompt(
    batch: ClaudeUnifiedPromptBatch<Mode>,
    options?: ClaudeUnifiedPromptInjectionOptions | undefined,
  ): Promise<TerminalInputInjectionResult>;
}>;

/**
 * Screen-evidence decision for steering a pending prompt into a running turn (D19).
 * `turnLikelyEnded` marks a decision whose screen evidence shows an idle interactive composer — used as
 * fallback turn-end evidence when lifecycle hooks are lost.
 */
export type ClaudeUnifiedInFlightSteerDecision =
  | Readonly<{ steer: true; turnLikelyEnded?: boolean | undefined }>
  | Readonly<{ steer: false; reason: string; turnLikelyEnded?: boolean | undefined }>;

export type ClaudeUnifiedInFlightSteerEvaluator<Mode = unknown> = (
  batch: ClaudeUnifiedPromptBatch<Mode>,
) => Promise<ClaudeUnifiedInFlightSteerDecision>;

export type ClaudeUnifiedInputArbiter<Mode = unknown> = Readonly<{
  enqueueUiMessage(batch: ClaudeUnifiedPromptBatch<Mode>): Promise<void>;
  observeLifecycle(observation: TerminalLifecycleObservation): void;
  observeUserTypingState(state: Readonly<{ userTyping: boolean; observedAtMs?: number | undefined }>): void;
  /**
   * External terminal-control evidence that the interactive composer no longer contains a user
   * draft. Wakes the existing deferred-drain owner without bypassing readiness checks.
   */
  notifyTerminalComposerCleared(state?: Readonly<{ observedAtMs?: number | undefined }>): void;
  observePromptCustodyByTerminal(batch: ClaudeUnifiedPromptBatch<Mode>): Promise<boolean>;
  /**
   * Exact local id of the native queued-custody head that may be interrupted into the live turn.
   * This is transient terminal truth, never a provider-acceptance or Pending settlement.
   */
  readPendingInputInterruptAndRunLocalId(): string | null;
  /**
   * Atomically revalidates and claims the exact current custody head. A successful claim is
   * one-shot for the batch and authorizes only the provider-owned interrupt keypress.
   */
  claimPendingInputInterruptAndRun(localId: string): boolean;
  confirmPromptAcceptedByProvider(): Promise<boolean>;
  confirmPromptAcceptedByProviderIf(matcher: (batch: ClaudeUnifiedPromptBatch<Mode>) => boolean): Promise<boolean>;
  observePendingProviderAcceptanceTerminalFailure(): Promise<boolean>;
  drainWhenSafe(): Promise<void>;
  waitForPendingQueuePumpStateChange(options: Readonly<{
    afterVersion: number;
    abortSignal: AbortSignal;
  }>): Promise<boolean>;
  snapshot(): ClaudeUnifiedInputArbiterSnapshot;
  dispose(): Promise<void> | void;
}>;

export type ClaudeUnifiedInputArbiterSnapshot = Readonly<{
  pendingQueuePumpStateVersion: number;
  queuedCount: number;
  pendingInjectionCount: number;
  terminalCustodyCount: number;
  providerAcceptancePendingCount: number;
  disposed: boolean;
  turnState: TerminalTurnState;
  permissionBlocked: boolean;
  userTyping: boolean;
  lastDeferredReason: string | null;
  lastFailureReason: string | null;
  currentHeadBlocker: ClaudeUnifiedDeliveryBlocker | null;
  headInputState:
    | 'queued'
    | 'waiting_for_readiness'
    | 'injecting'
    | 'awaiting_provider_acceptance'
    | 'terminal_custody'
    | 'submitted'
    | 'failed_retryable'
    | 'failed_ambiguous'
    | 'failed_terminal'
    | null;
}>;

export type ClaudeUnifiedPendingQueuePump<Mode = unknown> = Readonly<{
  pumpOnce(opts: { abortSignal: AbortSignal }): Promise<boolean>;
  drainPending(opts?: DrainPendingOptions): Promise<DrainPendingResult | null>;
  start(opts: { abortSignal: AbortSignal }): Promise<void>;
  dispose(): Promise<void> | void;
}>;

export type ClaudeUnifiedInputConsumer<Mode> = Readonly<{
  waitForNextInput(opts: { abortSignal: AbortSignal }): Promise<MessageBatch<Mode, string> | null>;
  drainPending?: ((opts?: DrainPendingOptions) => Promise<DrainPendingResult>) | undefined;
}>;

export type ClaudeUnifiedTerminalHost = Readonly<{
  evaluateLiveness(): Promise<TerminalHostLiveness>;
  preserve(): Promise<void> | void;
}>;

export type ClaudeUnifiedDisposable = Readonly<{
  dispose(): Promise<void> | void;
}>;

export type ClaudeUnifiedStartableDisposable = ClaudeUnifiedDisposable & Readonly<{
  start(opts: { abortSignal: AbortSignal }): void | Promise<void>;
}>;

export type { TerminalPromptInput };
