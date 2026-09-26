import {
  createLocalTurnLifecycleController,
  type LocalTurnLifecycleController,
  type LocalTurnLifecycleEvent,
  type LocalTurnTerminalReason,
} from '@/agent/localControl/turnLifecycle';
import { TERMINAL_INPUT_QUIET_PERIOD_MS } from '@/agent/runtime/terminal/injection/arbiter';

import {
  createClaudeLocalLifecycleTracker,
  isClaudeTaskNotificationUserPromptHook,
} from '../localControl/claudeLocalLifecycleTracker';
import { isClaudeMainChainCompactBoundary } from '../localControl/readClaudeTranscriptTurnSignal';
import {
  type createClaudeProviderActivityLedger,
} from '../providerActivity/createClaudeProviderActivityLedger';
import type { createClaudeProviderRuntimeActivityAdapter } from '../providerActivity/createClaudeProviderRuntimeActivityAdapter';
import { isClaudeRuntimeAuthFailureEvidence } from '../connectedServices/classifyClaudeConnectedServiceRuntimeAuthFailure';
import { containsDefinitiveClaudeOAuthRevocationEvidence } from '../connectedServices/surfaceClaudeRuntimeIssues';
import {
  mapClaudeRateLimitEventToUsageDetails,
  mapClaudeStopFailureHookToUsageDetails,
  type NormalizedProviderUsageLimitDetailsV1,
} from '../connectedServices/mapClaudeRateLimitEventToUsageDetails';
import type { RawJSONLines } from '../types';
import type { SessionHookData } from '../utils/startHookServer';
import { isSidechainSessionHook } from '../utils/sessionHookAttribution';
import type {
  ClaudeUnifiedInputArbiter,
  ClaudeUnifiedPromptBatch,
  ClaudeUnifiedStartableDisposable,
} from './_types';
import { logger } from '@/ui/logger';
import { readNonBlankOpaqueIdentifier } from '@/utils/opaqueIdentifiers';
import { isClaudeUnifiedTrustedHookActivationEvidence } from './claudeUnifiedHookActivation';
import { normalizeClaudeUnifiedPromptIdentityText } from './promptIdentity';

export type ClaudeUnifiedSessionHookSubscription = (
  callback: (data: SessionHookData) => void,
) => (() => void) | null | undefined;

export type ClaudeUnifiedHookLifecycleBridge = ClaudeUnifiedStartableDisposable & Readonly<{
  observeTranscript(message: RawJSONLines): void;
  observeLiveProviderActivityRow(message: unknown, expectedSessionId: string): void;
  handleProviderActivityObservationLoss(reason: string): void;
  settleAttemptLocalCommandCompleted(): Promise<void>;
  settleAttemptLocalCommandAborted(source: string): boolean;
}>;

export type ClaudeUnifiedPromptTurnTerminalEvent = Readonly<{
  reason: LocalTurnTerminalReason;
  source: string;
  detail?: string | undefined;
  providerAcceptanceFailureObserved?: boolean | undefined;
}>;

export type ClaudeUnifiedSessionEndEvent = Readonly<{
  reason: string | null;
  source: string;
}>;

export type ClaudeUnifiedTurnStallScreenProbe = Readonly<{
  quietMs: number;
  maxAttempts?: number | undefined;
  onStalled: () => void | Promise<void>;
  /**
   * Fired ONCE per stall episode when the bounded `maxAttempts` budget exhausts while the turn is
   * still active-but-stuck (e.g. an API-retry loop that never reaches turn-terminal). Without it the
   * mid-turn window went silently blind after the last attempt, so a dialog that surfaced late in the
   * stuck turn (Fable safeguard chooser, incident cmr3dpuka) was never made user-visible. This is the
   * mid-turn analog of the turn-end tail's one-shot `onStarvation` — same escalation discipline,
   * never a silent stop. A genuine progress event re-arms the window and clears the latch.
   */
  onStarvation?: (() => void) | undefined;
}>;

/**
 * Result of a single turn-end dialog probe shot. `resolved` means the screen is clear or a dialog was
 * surfaced/answered (episode complete — stop the tail). `pending` means a dialog is still visible but
 * not yet surfaced, or the probe could not run (keep re-arming through the bounded tail, then escalate
 * once). A `void`/`undefined` return is treated as `pending`.
 */
export type ClaudeUnifiedTurnEndProbeOutcome = 'resolved' | 'pending';

/**
 * Idle-time dialog evaluation trigger (incident cmr377jsr). A queued control (e.g. `/effort`) can pop
 * a dialog AFTER the turn goes terminal, into an idle session with no further screen observations: the
 * turn-stall probe stops at turn-terminal and the startup readiness loop is long dead. Without a
 * turn-end trigger nothing re-evaluates the dialog registry and the session sits idle with a hidden
 * blocking dialog.
 *
 * `onProbe` fires at each `delaysMs` offset (from turn settle) as a bounded idle re-arm: the first two
 * shots catch a queued-command dialog that renders a beat after Stop, and the backoff tail keeps
 * re-evaluating for ~a minute so a dialog rendering several seconds late is still surfaced (S1-F1 —
 * the earlier two-shot window had no re-arm and a late dialog recurred the silent hang). The tail is
 * strictly bounded: once a shot reports `resolved` the remaining shots are cancelled, and if the final
 * shot is still `pending` `onStarvation` fires exactly once (no infinite polling). Pending shots are
 * cancelled when the next turn starts, on compaction start, and on dispose.
 */
export type ClaudeUnifiedTurnEndScreenProbe = Readonly<{
  onProbe: () => ClaudeUnifiedTurnEndProbeOutcome | void | Promise<ClaudeUnifiedTurnEndProbeOutcome | void>;
  delaysMs: readonly number[];
  /**
   * Fired once per turn-end episode when the bounded re-arm tail exhausts with a dialog still
   * unresolved — a residual silent-hang that must be observable rather than silent (mirrors the
   * injector's one-shot starvation escalation, not a second escalation mechanism).
   */
  onStarvation?: (() => void) | undefined;
}>;

function disposeSubscription(dispose: (() => void) | null): void {
  if (!dispose) return;
  dispose();
}

function readHookEventName(data: SessionHookData): string {
  const raw = data.hook_event_name ?? data.hookEventName;
  return typeof raw === 'string' ? raw : '';
}

function readHookString(data: SessionHookData, key: string): string {
  return readNonBlankOpaqueIdentifier(data[key]) ?? '';
}

function readHookRequestId(data: SessionHookData): string {
  return readHookString(data, 'tool_use_id')
    || readHookString(data, 'toolUseId')
    || readHookString(data, 'request_id')
    || readHookString(data, 'requestId')
    || readHookString(data, 'id');
}

export function createClaudeUnifiedHookLifecycleBridge(opts: Readonly<{
  subscribeClaudeSessionHooks: ClaudeUnifiedSessionHookSubscription;
  arbiter: Pick<ClaudeUnifiedInputArbiter, 'observeLifecycle' | 'confirmPromptAcceptedByProvider' | 'drainWhenSafe'>
    & Partial<Pick<ClaudeUnifiedInputArbiter, 'confirmPromptAcceptedByProviderIf'>>
    & Readonly<{
      observePendingProviderAcceptanceTerminalFailure?: ClaudeUnifiedInputArbiter['observePendingProviderAcceptanceTerminalFailure'];
    }>;
  completionQuiescenceMs: number;
  onThinkingChange?: ((thinking: boolean) => void) | undefined;
  onReady?: (() => void | Promise<void>) | undefined;
  onUsageLimitDetails?: ((details: NormalizedProviderUsageLimitDetailsV1) => void | Promise<void>) | undefined;
  onRuntimeAuthFailureEvent?: ((error: unknown) => void | Promise<void>) | undefined;
  onProviderPromptStarted?: (() => void | Promise<void>) | undefined;
  /**
   * Provider lifecycle evidence from `UserPromptSubmit` (e.g. the active permission mode). Used by the
   * runtime-control bridge to reconcile the controller's last-verified config — the strongest verification
   * rung. Optional; only the fields Claude includes on the hook are forwarded.
   */
  onProviderPromptSubmitMetadata?: ((metadata: Readonly<{
    permissionMode?: string | undefined;
    model?: string | undefined;
    reasoningEffort?: string | undefined;
  }>) => void) | undefined;
  onProviderSessionStarted?: (() => void) | undefined;
  onAcceptedPromptSubmitEvidence?: ((input: Readonly<{
    batch: ClaudeUnifiedPromptBatch;
    promptId: string;
    sessionId: string;
  }>) => void) | undefined;
  onTrustedHookActivation?: (() => void) | undefined;
  onTrustedProviderProgress?: (() => void) | undefined;
  /**
   * Authenticated primary-session lifecycle evidence that Claude may have changed the visible TUI.
   * The terminal screen controller remains the sole dialog owner; this is only an event-driven
   * observation hint so short-lived nonblocking overlays do not depend on a quiet-period probe.
   */
  onMainSessionScreenMayHaveChanged?: (() => void | Promise<void>) | undefined;
  onPromptTurnTerminal?: ((event: ClaudeUnifiedPromptTurnTerminalEvent) => void | Promise<void>) | undefined;
  onSessionEnd?: ((event: ClaudeUnifiedSessionEndEvent) => void | Promise<void>) | undefined;
  turnStallScreenProbe?: ClaudeUnifiedTurnStallScreenProbe | undefined;
  turnEndScreenProbe?: ClaudeUnifiedTurnEndScreenProbe | undefined;
  runtimeActivityAdapter?: ReturnType<typeof createClaudeProviderRuntimeActivityAdapter> | null | undefined;
  providerActivityLedger?: ReturnType<typeof createClaudeProviderActivityLedger> | undefined;
}>): ClaudeUnifiedHookLifecycleBridge {
  let disposed = false;
  let unsubscribe: (() => void) | null = null;
  let lifecycle: LocalTurnLifecycleController | null = null;
  let tracker: ReturnType<typeof createClaudeLocalLifecycleTracker> | null = null;
  let quietDrainTimer: NodeJS.Timeout | null = null;
  let turnStallTimer: NodeJS.Timeout | null = null;
  let turnStallActive = false;
  let turnStallAttempts = 0;
  let turnStallProbeInFlight = false;
  let turnStallEscalated = false;
  let turnEndProbeTimer: NodeJS.Timeout | null = null;
  let turnEndProbeEscalated = false;
  // Bumped whenever the tail is cancelled/restarted so an in-flight async probe cannot re-arm or
  // escalate into a superseded episode (next turn start, compaction start, dispose, or resolution).
  let turnEndProbeGeneration = 0;
  let terminalSideEffects: Promise<void> = Promise.resolve();
  let anonymousPermissionBlockCount = 0;
  let nativeResumeContinuationPending = false;
  const pendingPermissionRequestIds = new Set<string>();

  const clearQuietDrainTimer = (): void => {
    if (!quietDrainTimer) return;
    clearTimeout(quietDrainTimer);
    quietDrainTimer = null;
  };

  const clearTurnStallTimer = (): void => {
    if (!turnStallTimer) return;
    clearTimeout(turnStallTimer);
    turnStallTimer = null;
  };

  const turnStallProbeQuietMs = (): number => {
    const raw = opts.turnStallScreenProbe?.quietMs ?? 0;
    return Math.max(0, Math.trunc(raw));
  };

  const turnStallProbeMaxAttempts = (): number => {
    const raw = opts.turnStallScreenProbe?.maxAttempts ?? 1;
    return Math.max(1, Math.trunc(raw));
  };

  const escalateTurnStallStarvation = (): void => {
    const probe = opts.turnStallScreenProbe;
    if (!probe?.onStarvation) return;
    if (!turnStallActive || turnStallEscalated) return;
    if (turnStallAttempts < turnStallProbeMaxAttempts()) return;
    turnStallEscalated = true;
    try {
      probe.onStarvation();
    } catch (error) {
      logger.debug('[unified]: Claude unified terminal turn-stall starvation escalation failed', error);
    }
  };

  const scheduleTurnStallProbe = (): void => {
    const probe = opts.turnStallScreenProbe;
    if (!probe || !turnStallActive || turnStallProbeInFlight) return;
    if (turnStallAttempts >= turnStallProbeMaxAttempts()) {
      // Budget exhausted while the turn is still active-but-stalled (e.g. an API-retry loop that never
      // reaches turn-terminal). Rather than going silently blind, escalate ONCE per stall episode so a
      // dialog surfacing in the stuck window is still made user-visible (mid-turn analog of the
      // turn-end tail's one-shot starvation). A genuine progress event re-arms and clears the latch.
      escalateTurnStallStarvation();
      return;
    }
    clearTurnStallTimer();
    turnStallTimer = setTimeout(() => {
      turnStallTimer = null;
      if (disposed || !turnStallActive || turnStallProbeInFlight) return;
      turnStallAttempts += 1;
      turnStallProbeInFlight = true;
      Promise.resolve(probe.onStalled())
        .catch((error) => {
          logger.debug('[unified]: Claude unified terminal turn-stall screen probe failed', error);
        })
        .finally(() => {
          turnStallProbeInFlight = false;
          if (!disposed && turnStallActive) scheduleTurnStallProbe();
        });
    }, turnStallProbeQuietMs());
    turnStallTimer.unref?.();
  };

  const noteTurnStallProgress = (): void => {
    if (!opts.turnStallScreenProbe || !turnStallActive) return;
    turnStallAttempts = 0;
    turnStallEscalated = false;
    scheduleTurnStallProbe();
  };

  const startTurnStallProbeWindow = (): void => {
    if (!opts.turnStallScreenProbe) return;
    turnStallActive = true;
    noteTurnStallProgress();
  };

  const stopTurnStallProbeWindow = (): void => {
    turnStallActive = false;
    turnStallAttempts = 0;
    turnStallEscalated = false;
    clearTurnStallTimer();
  };

  const clearTurnEndProbeTimers = (): void => {
    if (turnEndProbeTimer) {
      clearTimeout(turnEndProbeTimer);
      turnEndProbeTimer = null;
    }
    turnEndProbeEscalated = false;
    // Invalidate any probe whose async onProbe is mid-flight so it cannot re-arm or escalate.
    turnEndProbeGeneration += 1;
  };

  const scheduleTurnEndProbeAt = (index: number, generation: number): void => {
    const probe = opts.turnEndScreenProbe;
    if (!probe || disposed || generation !== turnEndProbeGeneration) return;
    const delays = probe.delaysMs;
    if (index >= delays.length) return;
    const prevDelay = index === 0 ? 0 : Math.max(0, Math.trunc(delays[index - 1] ?? 0));
    const thisDelay = Math.max(0, Math.trunc(delays[index] ?? 0));
    const waitMs = Math.max(0, thisDelay - prevDelay);
    turnEndProbeTimer = setTimeout(() => {
      turnEndProbeTimer = null;
      void runTurnEndProbe(index, generation);
    }, waitMs);
    turnEndProbeTimer.unref?.();
  };

  const runTurnEndProbe = async (index: number, generation: number): Promise<void> => {
    const probe = opts.turnEndScreenProbe;
    if (!probe || disposed || generation !== turnEndProbeGeneration) return;
    let outcome: ClaudeUnifiedTurnEndProbeOutcome = 'pending';
    try {
      outcome = (await probe.onProbe()) === 'resolved' ? 'resolved' : 'pending';
    } catch (error) {
      logger.debug('[unified]: Claude unified terminal turn-end dialog probe failed', error);
    }
    if (disposed || generation !== turnEndProbeGeneration) return;
    if (outcome === 'resolved') {
      // Dialog surfaced/answered or screen clear — the idle re-arm episode is complete; stop the tail.
      clearTurnEndProbeTimers();
      return;
    }
    if (index >= probe.delaysMs.length - 1) {
      // Bounded: the re-arm tail is exhausted with a dialog still unresolved. Escalate ONCE so the
      // residual silent-hang is observable, then stop (no infinite polling).
      if (!turnEndProbeEscalated) {
        turnEndProbeEscalated = true;
        try {
          probe.onStarvation?.();
        } catch (error) {
          logger.debug('[unified]: Claude unified terminal turn-end starvation escalation failed', error);
        }
      }
      return;
    }
    scheduleTurnEndProbeAt(index + 1, generation);
  };

  const scheduleTurnEndProbes = (): void => {
    const probe = opts.turnEndScreenProbe;
    if (!probe || disposed) return;
    clearTurnEndProbeTimers();
    if (probe.delaysMs.length === 0) return;
    scheduleTurnEndProbeAt(0, turnEndProbeGeneration);
  };

  const drainWhenSafe = (): void => {
    void opts.arbiter.drainWhenSafe().catch(() => undefined);
  };

  const chainTerminalSideEffect = (
    label: string,
    effect: (() => void | Promise<void>) | undefined,
  ): void => {
    if (!effect) return;
    terminalSideEffects = terminalSideEffects
      .catch(() => undefined)
      .then(async () => {
        try {
          await effect();
        } catch (error) {
          logger.debug(`[unified]: failed to run Claude unified terminal ${label} side effect`, error);
        }
      });
  };

  const chainTerminalSideEffectResult = (
    label: string,
    result: void | Promise<void>,
  ): void => {
    terminalSideEffects = terminalSideEffects
      .catch(() => undefined)
      .then(async () => {
        try {
          await result;
        } catch (error) {
          logger.debug(`[unified]: failed to run Claude unified terminal ${label} side effect`, error);
        }
      });
  };

  const waitForTerminalSideEffects = async (): Promise<void> => {
    await terminalSideEffects.catch(() => undefined);
  };

  const settleIdleAfterTerminalEffects = (): void => {
    if (disposed) return;
    opts.arbiter.observeLifecycle({ type: 'turn_state', state: 'idle' });
    opts.arbiter.observeLifecycle({ type: 'output' });
    drainWhenSafe();
    clearQuietDrainTimer();
    quietDrainTimer = setTimeout(drainWhenSafe, TERMINAL_INPUT_QUIET_PERIOD_MS);
    quietDrainTimer.unref?.();
    scheduleTurnEndProbes();
  };

  const settleCompletedTurn = async (): Promise<void> => {
    stopTurnStallProbeWindow();
    opts.arbiter.observeLifecycle({ type: 'turn_state', state: 'finalizing' });
    opts.onThinkingChange?.(false);
    chainTerminalSideEffect('ready', opts.onReady);
    await waitForTerminalSideEffects();
    settleIdleAfterTerminalEffects();
  };

  const observeCompactionStarted = (): void => {
    clearQuietDrainTimer();
    stopTurnStallProbeWindow();
    clearTurnEndProbeTimers();
    opts.arbiter.observeLifecycle({ type: 'compaction', phase: 'started' });
  };

  const observeCompactionCompleted = (): void => {
    opts.arbiter.observeLifecycle({ type: 'compaction', phase: 'completed' });
    opts.arbiter.observeLifecycle({ type: 'turn_state', state: 'idle' });
    opts.arbiter.observeLifecycle({ type: 'output' });
    drainWhenSafe();
    stopTurnStallProbeWindow();
    clearQuietDrainTimer();
    quietDrainTimer = setTimeout(drainWhenSafe, TERMINAL_INPUT_QUIET_PERIOD_MS);
    quietDrainTimer.unref?.();
    // Compaction completion also transitions to idle; a queued command dialog can pop here too.
    scheduleTurnEndProbes();
  };

  const hasPendingPermissionBlock = (): boolean => (
    anonymousPermissionBlockCount > 0 || pendingPermissionRequestIds.size > 0
  );

  const observePermissionBlocked = (data: SessionHookData): void => {
    const requestId = readHookRequestId(data);
    if (requestId) {
      pendingPermissionRequestIds.add(requestId);
    } else {
      anonymousPermissionBlockCount += 1;
    }
    opts.arbiter.observeLifecycle({ type: 'permission', blocked: true });
  };

  const observePermissionReleased = (
    data: SessionHookData,
    optsOverride?: Readonly<{ redrain?: boolean; releaseAll?: boolean }>,
  ): void => {
    if (optsOverride?.releaseAll === true) {
      anonymousPermissionBlockCount = 0;
      pendingPermissionRequestIds.clear();
    } else {
      const requestId = readHookRequestId(data);
      if (requestId) {
        pendingPermissionRequestIds.delete(requestId);
      } else if (anonymousPermissionBlockCount > 0) {
        anonymousPermissionBlockCount -= 1;
      }
    }
    if (hasPendingPermissionBlock()) return;
    opts.arbiter.observeLifecycle({ type: 'permission', blocked: false });
    if (optsOverride?.redrain === false) return;
    drainWhenSafe();
    clearQuietDrainTimer();
    quietDrainTimer = setTimeout(drainWhenSafe, TERMINAL_INPUT_QUIET_PERIOD_MS);
    quietDrainTimer.unref?.();
  };

  const observeStopFailureRuntimeIssue = (data: SessionHookData, sidechain: boolean): void => {
    const details = mapClaudeStopFailureHookToUsageDetails(data);
    if (details) {
      chainTerminalSideEffect('usage-limit', () => opts.onUsageLimitDetails?.(details));
      return;
    }
    // Q2: a StopFailure that carries authentication-failure evidence (not a usage limit) was
    // previously dropped — only the usage-limit mapper ran. Route it into the ONE runtime-auth
    // failure owner (`onRuntimeAuthFailureEvent` → surfaceClaudeRuntimeAuthFailure) so an
    // auth-failed turn triggers the same reactive recovery as transcript auth evidence. A
    // sidechain (subagent, `agent_id`) auth StopFailure describes a subagent request, not the
    // parent session's credentials, and must never drive parent-session recovery/restart
    // (incident 2026-06-12 cmq8171…) — mirrors the transcript-path subagent gating.
    if (sidechain && !containsDefinitiveClaudeOAuthRevocationEvidence(data)) return;
    if (!opts.onRuntimeAuthFailureEvent) return;
    if (!isClaudeRuntimeAuthFailureEvidence(data)) return;
    chainTerminalSideEffect('runtime-auth', () => opts.onRuntimeAuthFailureEvent?.(data));
  };

  const observeProviderPromptStarted = (): void => {
    if (!opts.onProviderPromptStarted) return;
    try {
      chainTerminalSideEffectResult('provider-prompt-start', opts.onProviderPromptStarted());
    } catch (error) {
      logger.debug('[unified]: failed to run Claude unified terminal provider-prompt-start side effect', error);
    }
  };

  const observeSessionEnd = (data: SessionHookData): void => {
    if (!opts.onSessionEnd) return;
    const reason = readHookString(data, 'reason');
    try {
      void Promise.resolve(opts.onSessionEnd({
        reason: reason || null,
        source: 'claude_hook',
      })).catch((error) => {
        logger.debug('[unified]: failed to run Claude unified terminal session-end side effect', error);
      });
    } catch (error) {
      logger.debug('[unified]: failed to run Claude unified terminal session-end side effect', error);
    }
  };

  const settleTerminalSnapshot = async (
    snapshot: Readonly<{
      terminal: boolean;
      lastTerminalReason: LocalTurnTerminalReason | null;
    }>,
    event: LocalTurnLifecycleEvent,
  ): Promise<void> => {
    if (disposed || !snapshot.terminal) return;
    if (snapshot.lastTerminalReason === 'completed') {
      await settleCompletedTurn();
      return;
    } else {
      stopTurnStallProbeWindow();
      opts.arbiter.observeLifecycle({ type: 'turn_state', state: 'finalizing' });
      // A failed/aborted terminal turn must win over task-completion bookkeeping.
      // Run the terminal projection (which may abort/fail the canonical turn)
      // before clearing the thinking state; otherwise onThinkingChange(false)
      // emits task_complete first and a failed turn is recorded as completed.
      let providerAcceptanceFailureObserved: boolean | undefined;
      if (snapshot.lastTerminalReason !== 'aborted') {
        chainTerminalSideEffect('pending-provider-acceptance-terminal-failure', async () => {
          providerAcceptanceFailureObserved =
            await opts.arbiter.observePendingProviderAcceptanceTerminalFailure?.() === true;
        });
      }
      chainTerminalSideEffect('prompt-turn-terminal', () => opts.onPromptTurnTerminal?.({
        reason: snapshot.lastTerminalReason ?? 'unknown',
        source: event.source,
        ...(event.type === 'turn_terminal' && event.detail ? { detail: event.detail } : {}),
        ...(providerAcceptanceFailureObserved === undefined ? {} : { providerAcceptanceFailureObserved }),
      }));
      chainTerminalSideEffect(
        'thinking-cleared',
        opts.onThinkingChange ? () => { opts.onThinkingChange?.(false); } : undefined,
      );
    }
    await waitForTerminalSideEffects();
    settleIdleAfterTerminalEffects();
  };

  return {
    start() {
      if (disposed || unsubscribe) return;
      lifecycle = createLocalTurnLifecycleController({
        completionQuiescenceMs: opts.completionQuiescenceMs,
        onStateChange: (snapshot, event) => {
          if (snapshot.active && !snapshot.terminal) {
            nativeResumeContinuationPending = false;
            // A new turn is active — the turn-stall probe now covers it, so cancel any pending
            // idle turn-end probes scheduled after the previous turn settled.
            clearTurnEndProbeTimers();
            startTurnStallProbeWindow();
            opts.arbiter.observeLifecycle({ type: 'turn_state', state: 'running' });
            opts.onThinkingChange?.(true);
            return;
          }
          if (!snapshot.terminal) return;
          void settleTerminalSnapshot(snapshot, event);
        },
      });
      tracker = createClaudeLocalLifecycleTracker({
        lifecycle,
        runtimeActivityAdapter: opts.runtimeActivityAdapter ?? null,
        providerActivityLedger: opts.providerActivityLedger,
      });
      unsubscribe = opts.subscribeClaudeSessionHooks((data) => {
        const hookEventName = readHookEventName(data);
        // Sidechain (subagent) hooks carry an agent_id attribution. They must not
        // drive main-conversation lifecycle behavior: prompt acceptance, compaction
        // gating, turn-terminal projection, release-all permission unblocking, or
        // session end. Per-request permission accounting and account-level
        // StopFailure usage evidence remain valid from sidechains.
        const sidechain = isSidechainSessionHook(data);
        if (isClaudeUnifiedTrustedHookActivationEvidence(data)) {
          opts.onTrustedHookActivation?.();
        }
        if (hookEventName === 'SessionStart') {
          if (!sidechain) {
            nativeResumeContinuationPending = readHookString(data, 'source') === 'resume';
            opts.onProviderSessionStarted?.();
          }
        } else if (hookEventName === 'PreCompact') {
          if (!sidechain) observeCompactionStarted();
        } else if (hookEventName === 'PostCompact') {
          if (!sidechain) observeCompactionCompleted();
        } else if (hookEventName === 'UserPromptSubmit') {
          const taskNotification = isClaudeTaskNotificationUserPromptHook(data);
          if (!sidechain && nativeResumeContinuationPending && !taskNotification) {
            nativeResumeContinuationPending = false;
            opts.onTrustedProviderProgress?.();
            observeProviderPromptStarted();
          } else if (!sidechain && !taskNotification) {
            nativeResumeContinuationPending = false;
            opts.onTrustedProviderProgress?.();
            observeProviderPromptStarted();
            const submittedPrompt = readHookString(data, 'prompt');
            const normalizedSubmittedPrompt = normalizeClaudeUnifiedPromptIdentityText(submittedPrompt);
            if (normalizedSubmittedPrompt && opts.arbiter.confirmPromptAcceptedByProviderIf) {
              // UserPromptSubmit is authenticated provider evidence. Correlate its exact prompt
              // before waiting for turn-end arming: a queued steer may be submitted by Claude at
              // the same boundary, with this hook arriving before any separate idle observation.
              // Exact matching keeps terminal custody/output from settling a neighbor Pending row.
              let matchedBatch: ClaudeUnifiedPromptBatch | null = null;
              void opts.arbiter.confirmPromptAcceptedByProviderIf((batch) => {
                const matches =
                  normalizeClaudeUnifiedPromptIdentityText(batch.message) === normalizedSubmittedPrompt;
                if (matches) matchedBatch = batch;
                return matches;
              }).then((confirmed) => {
                if (!confirmed || !matchedBatch || !opts.onAcceptedPromptSubmitEvidence) return;
                const sessionId = readHookString(data, 'session_id') || readHookString(data, 'sessionId');
                const promptId = readHookString(data, 'prompt_id') || readHookString(data, 'promptId');
                if (!sessionId || !promptId) return;
                opts.onAcceptedPromptSubmitEvidence({
                  batch: matchedBatch,
                  promptId,
                  sessionId,
                });
              }).catch(() => undefined);
            } else {
              // Hooks without prompt identity can retain the legacy non-Pending confirmation only.
              // They are not sufficient to choose a durable Pending localId.
              void opts.arbiter.confirmPromptAcceptedByProvider().catch(() => undefined);
            }
          }
          if (!sidechain && !taskNotification && opts.onProviderPromptSubmitMetadata) {
            const permissionMode = readHookString(data, 'permission_mode') || readHookString(data, 'permissionMode');
            const model = readHookString(data, 'model');
            const reasoningEffort = readHookString(data, 'reasoning_effort') || readHookString(data, 'effort');
            if (permissionMode || model || reasoningEffort) {
              opts.onProviderPromptSubmitMetadata({
                ...(permissionMode ? { permissionMode } : {}),
                ...(model ? { model } : {}),
                ...(reasoningEffort ? { reasoningEffort } : {}),
              });
            }
          }
        } else if (hookEventName === 'PermissionRequest') {
          observePermissionBlocked(data);
        } else if (
          hookEventName === 'PostToolUse'
          || hookEventName === 'PermissionRequestCompleted'
        ) {
          observePermissionReleased(data);
          if (!sidechain && hookEventName === 'PostToolUse') {
            void Promise.resolve(opts.onMainSessionScreenMayHaveChanged?.()).catch((error) => {
              logger.debug('[unified]: Claude unified terminal lifecycle screen observation failed', error);
            });
          }
        } else if (
          !sidechain
          && (
            hookEventName === 'Stop'
            || hookEventName === 'StopFailure'
            || hookEventName === 'SessionEnd'
          )
        ) {
          observePermissionReleased(data, { redrain: false, releaseAll: true });
        }
        if (hookEventName === 'SessionEnd' && !sidechain) {
          observeSessionEnd(data);
        }
        if (hookEventName === 'StopFailure') {
          observeStopFailureRuntimeIssue(data, sidechain);
        }
        if (!sidechain && hookEventName !== 'SessionStart') {
          noteTurnStallProgress();
        }
        tracker?.observeHook(data);
      }) ?? null;
    },
    observeTranscript(message) {
      noteTurnStallProgress();
      if (isClaudeMainChainCompactBoundary(message)) {
        observeCompactionCompleted();
      }
      if (isClaudeRuntimeAuthFailureEvidence(message)) {
        chainTerminalSideEffect('runtime-auth', () => opts.onRuntimeAuthFailureEvent?.(message));
      }
      const usageLimitDetails = mapClaudeRateLimitEventToUsageDetails(message);
      if (usageLimitDetails) {
        chainTerminalSideEffect('usage-limit', () => opts.onUsageLimitDetails?.(usageLimitDetails));
      }
      tracker?.observeTranscript(message);
    },
    observeLiveProviderActivityRow(message, expectedSessionId) {
      tracker?.observeLiveProviderActivityRow(message, expectedSessionId);
    },
    handleProviderActivityObservationLoss(reason) {
      tracker?.handleProviderActivityObservationLoss(reason);
    },
    settleAttemptLocalCommandCompleted: settleCompletedTurn,
    settleAttemptLocalCommandAborted(source) {
      const activeLifecycle = lifecycle;
      if (!activeLifecycle) return false;
      const snapshot = activeLifecycle.snapshot();
      if (!snapshot.active || snapshot.terminal) return false;
      activeLifecycle.observe({
        type: 'turn_terminal',
        providerTurnId: snapshot.providerTurnId,
        reason: 'aborted',
        source,
      });
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearQuietDrainTimer();
      stopTurnStallProbeWindow();
      clearTurnEndProbeTimers();
      disposeSubscription(unsubscribe);
      unsubscribe = null;
      tracker = null;
      lifecycle?.dispose();
      lifecycle = null;
    },
  };
}
