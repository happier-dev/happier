import {
  captureFailureToResult,
  captureScreenState,
  sendResultToFailure,
  type ControlRuntime,
} from './controlRuntime.js';
import type { ControlAttemptResult } from './outcome.js';
import { isSafeWindowForSlashControl, type ClaudeScreenState } from '../screenState.js';
import type { SettingsGuard } from './settingsGuard.js';
import type { ClaudeTuiControlTelemetrySink } from './telemetry.js';
import type { ApplyRuntimeConfigReason } from './types.js';

/**
 * `/model` and `/effort` controls. These are next-idle/before-next-prompt controls: a live probe
 * (P-D) proved a slash command typed mid-generation is QUEUED by Claude, not applied, so the
 * controller never types one during generation. Every command runs inside a settings guard
 * (snapshot/restore) because `/model` and `/effort` persist defaults into the active config root, and
 * recaptures immediately before Enter to catch slash-picker/user-draft drift (TOCTOU).
 */
export type SlashControlContext = Readonly<{
  runtime: ControlRuntime;
  settingsGuard: SettingsGuard;
  reason: ApplyRuntimeConfigReason;
  telemetry?: ClaudeTuiControlTelemetrySink | undefined;
  /**
   * Fired when a command was actually SUBMITTED to the TUI (Enter sent). Used to register the
   * command for transcript echo suppression — Claude writes command user rows for executed slash
   * commands which must not surface as UI messages.
   */
  onCommandSubmitted?: ((commandText: string) => void) | undefined;
  /**
   * Fired the moment the command text is WRITTEN into the composer, before any verification or
   * Enter (ported S-7 / RESUME2): a typed-but-never-submitted command can survive the cleanup
   * Escape as a composer leftover, so the own-injected-text registry must learn the text at TYPE
   * time — submit-only registration left the residue classified as a foreign user draft,
   * permanently blocking idle prompt injection.
   */
  onCommandTyped?: ((commandText: string) => void) | undefined;
}>;

/**
 * Precise failure reason when the effort confirmation dialog resolved as "Kept effort level as
 * <current>" instead of applying the requested level (incident cmq8y3nlx, L6). The controller
 * escalates repeated occurrences to `requires_interactive_control`.
 */
export const EFFORT_CHANGE_DECLINED_REASON = 'effort_change_declined_by_dialog_default';

/** Bounded confirm answers per attempt before the dialog is declared unresponsive. */
const MAX_DIALOG_ANSWER_ATTEMPTS = 2;

/**
 * Bounded Escapes for clearing OUR OWN leftover slash draft before typing (incident cmq7pyqkj,
 * U1). One Escape can close the slash picker while LEAVING the draft text, so a single press is
 * not always enough to reach an empty composer.
 */
const MAX_LEFTOVER_SLASH_DRAFT_CLEAR_ATTEMPTS = 2;

/**
 * Precise failure reason when the pre-Enter recapture shows the composer holding something OTHER
 * than exactly the typed command (incident cmq7pyqkj, U1): submitting would deliver a concatenated
 * command such as `/effort medium/effort medium` ("Invalid argument").
 */
export const COMPOSER_CONTENT_MISMATCH_REASON = 'composer_content_mismatch';

/**
 * A slash-prefixed composer draft is OUR OWN failed control (a genuine user draft is non-slash —
 * `userDraftPresent` — and is never escaped away). With the picker CLOSED it passes the
 * safe-window check, so it must be detected from the composer content itself.
 */
function hasLeftoverSlashDraft(state: ClaudeScreenState): boolean {
  return typeof state.composerContent === 'string' && state.composerContent.startsWith('/');
}

/**
 * Fail-closed reason for a confirmation dialog the controller does not recognize (P-B): typing
 * would answer it and Escape would decline it (the incident cmq8y3nlx default-resolution class),
 * so the only safe outcome is `requires_interactive_control` with ZERO bytes sent.
 */
export const UNRECOGNIZED_CONFIRMATION_DIALOG_REASON = 'unrecognized_confirmation_dialog';

function unrecognizedDialogResult(): ControlAttemptResult {
  return { kind: 'unreachable', reason: UNRECOGNIZED_CONFIRMATION_DIALOG_REASON };
}

type LeftoverDialogResolution = Readonly<{
  /** `confirmed`: the dialog applies the requested value; verification follows without retyping. */
  action: 'confirmed' | 'dismissed';
  state: ClaudeScreenState;
}>;

type SlashControlSpec = Readonly<{
  key: 'model' | 'reasoningEffort';
  commandText: string;
  /** Resolve any follow-up dialog (e.g. `Switch model?`) and return the post-dialog screen state. */
  resolveFinalState: (state: ClaudeScreenState) => Promise<ClaudeScreenState>;
  /** Return the effective value when the command is verified, or null when unverified. */
  verify: (state: ClaudeScreenState) => string | null;
  /**
   * True when the state shows this control's OWN follow-up dialog. A leftover one at the initial
   * capture (a queued command executing at turn end, incident cmq8y3nlx L6) is answered
   * deliberately instead of failing the safe-window check forever.
   */
  ownsDialog?: ((state: ClaudeScreenState) => boolean) | undefined;
  /** Answer a leftover own-dialog found at the initial capture (under the settings guard). */
  resolveLeftoverDialog?: ((state: ClaudeScreenState) => Promise<LeftoverDialogResolution>) | undefined;
  /** Precise failure reason when the control's follow-up dialog resolved as declined. */
  detectDeclined?: ((state: ClaudeScreenState) => string | null) | undefined;
  /**
   * Return the effective value when the safe-window screen ALREADY shows the requested value
   * (incident cmq7pyqkj, U2: a resumed TUI re-renders this conversation's effort evidence; typing
   * the command again is pure re-apply churn that feeds the U1 leftover-draft class). Null when
   * the evidence is absent or differs — the command is then typed normally.
   */
  detectAlreadyEffective?: ((state: ClaudeScreenState) => string | null) | undefined;
}>;

function appliedTiming(reason: ApplyRuntimeConfigReason): 'before_next_prompt' | 'current_window' {
  return reason === 'before_prompt' ? 'before_next_prompt' : 'current_window';
}

async function runSlashControl(ctx: SlashControlContext, spec: SlashControlSpec): Promise<ControlAttemptResult> {
  const { runtime } = ctx;
  const { port, wait, timings } = runtime;

  const initial = await captureScreenState(port);
  if (initial.kind !== 'state') return captureFailureToResult(initial);
  let state0 = initial.state;

  // Mid-generation slash commands are queued by Claude, never applied this turn (probe P-D).
  if (state0.generating || state0.queuedMessageBannerVisible) {
    return { kind: 'scheduled', timing: 'next_idle', reason: 'generating' };
  }

  // Leftover own-dialog (incident cmq8y3nlx, L6): a queued `/effort` executed at turn end leaves
  // its confirmation dialog on screen. It IS the pending command — answer it deliberately instead
  // of failing the safe-window check on every retry (which could never converge).
  let leftoverDialog = spec.ownsDialog?.(state0) === true && spec.resolveLeftoverDialog !== undefined;

  // Unrecognized confirmation dialog (P-B): fail closed immediately — no Escape (it would decline
  // the dialog), no typing (it would answer it). Surfaces once as requires_interactive_control.
  if (!leftoverDialog && state0.unrecognizedConfirmationDialogVisible) {
    return unrecognizedDialogResult();
  }

  if (!leftoverDialog) {
    // Leftover slash-draft recovery (incidents cmq8y3nlx L5, cmq7pyqkj U1): OUR OWN command left in
    // the composer after an Enter that never submitted. With the picker OPEN it blocks the safe
    // window and hot-loops the before-prompt apply; with the picker CLOSED (a cleanup Escape closes
    // the picker but can leave the text) it PASSES the safe-window check and typing into it submits
    // a concatenated command (`/effort medium/effort medium`). Bounded Escapes clear it before any
    // typing; a GENUINE user draft (non-slash text) is never escaped away.
    if (state0.inputBoxInteractive && hasLeftoverSlashDraft(state0)) {
      for (let attempt = 0; attempt < MAX_LEFTOVER_SLASH_DRAFT_CLEAR_ATTEMPTS; attempt += 1) {
        await port.sendSpecialKey('Escape');
        await wait(timings.slashPickerSettleMs);
        const recaptured = await captureScreenState(port);
        if (recaptured.kind !== 'state') return captureFailureToResult(recaptured);
        state0 = recaptured.state;
        if (state0.generating || state0.queuedMessageBannerVisible) {
          return { kind: 'scheduled', timing: 'next_idle', reason: 'generating' };
        }
        leftoverDialog = spec.ownsDialog?.(state0) === true && spec.resolveLeftoverDialog !== undefined;
        if (leftoverDialog || !hasLeftoverSlashDraft(state0)) break;
      }
      if (!leftoverDialog && hasLeftoverSlashDraft(state0)) {
        // The draft survived the bounded clears: defer with a precise reason — the controller's
        // stuck-window escalation surfaces it once as requires_interactive_control.
        return { kind: 'scheduled', timing: 'queued_until_safe_window', reason: 'leftover_slash_draft' };
      }
    }
    if (!leftoverDialog && !isSafeWindowForSlashControl(state0)) {
      // Transient overlay (picker/user draft on an otherwise interactive composer) → defer; an
      // unknown / non-interactive screen is never a best-effort write.
      if (state0.inputBoxInteractive) {
        return { kind: 'scheduled', timing: 'queued_until_safe_window', reason: 'unsafe_overlay' };
      }
      return { kind: 'failed', reason: 'unsafe_or_unknown_screen' };
    }
    // Resume re-apply skip (incident cmq7pyqkj, U2): the safe-window screen already proves the
    // requested value is effective — report it with ZERO bytes instead of re-typing the command.
    const alreadyEffective = spec.detectAlreadyEffective?.(state0) ?? null;
    if (alreadyEffective !== null) {
      return { kind: 'already_effective', effective: alreadyEffective };
    }
  }

  const session = await ctx.settingsGuard.acquire();
  let restored = false;
  const restoreOnce = async (): Promise<{ ok: boolean; reason?: string }> => {
    if (restored) return { ok: true };
    restored = true;
    return session.restore();
  };
  try {
    // Resolve a leftover own-dialog first: a confirmed dialog goes straight to verification (the
    // command already ran); a dismissed one (stale target) falls through to typing the command.
    let preVerifyState: ClaudeScreenState | null = null;
    if (leftoverDialog && spec.resolveLeftoverDialog) {
      const resolution = await spec.resolveLeftoverDialog(state0);
      if (resolution.action === 'confirmed') {
        preVerifyState = resolution.state;
      } else {
        state0 = resolution.state;
        if (state0.generating || state0.queuedMessageBannerVisible) {
          const restore = await restoreOnce();
          if (!restore.ok) return { kind: 'failed', reason: `settings_guard:${restore.reason}` };
          return { kind: 'scheduled', timing: 'next_idle', reason: 'generating' };
        }
        if (!isSafeWindowForSlashControl(state0)) {
          const restore = await restoreOnce();
          if (!restore.ok) return { kind: 'failed', reason: `settings_guard:${restore.reason}` };
          if (state0.inputBoxInteractive) {
            return { kind: 'scheduled', timing: 'queued_until_safe_window', reason: 'unsafe_overlay' };
          }
          return { kind: 'failed', reason: 'unsafe_or_unknown_screen' };
        }
      }
    }

    if (preVerifyState === null) {
      const sendCommand = sendResultToFailure(await port.sendLiteralText(spec.commandText));
      if (sendCommand) return sendCommand;
      ctx.onCommandTyped?.(spec.commandText);

      await wait(timings.slashPickerSettleMs);
      const afterType = await captureScreenState(port);
      if (afterType.kind !== 'state') {
        await port.sendSpecialKey('Escape');
        return captureFailureToResult(afterType);
      }
      if (afterType.state.unrecognizedConfirmationDialogVisible) {
        // An unrecognized dialog swallowed the typed command (P-B): never blind-Enter (it would
        // answer the dialog) and never Escape (it would decline it). Fail closed.
        return unrecognizedDialogResult();
      }
      // TOCTOU: a turn started or a user draft replaced the command between typing and submitting.
      if (afterType.state.generating || afterType.state.userDraftPresent) {
        await port.sendSpecialKey('Escape');
        return { kind: 'failed', reason: 'toctou_drift_before_submit' };
      }
      // Pre-Enter composer EQUALITY (incident cmq7pyqkj, U1): the recapture must show EXACTLY the
      // typed command. Anything else non-empty (e.g. a leftover draft the typing appended to —
      // `/effort medium/effort medium`) would submit a malformed command; bounded Escape + precise
      // failure instead. An EMPTY composer stays on the existing path: captures can lag the render
      // and the post-Enter verification poll owns that ambiguity.
      const composerAfterType = afterType.state.composerContent;
      if (composerAfterType !== null && composerAfterType.length > 0 && composerAfterType !== spec.commandText) {
        ctx.telemetry?.emit({
          name: 'unified.control.verification_mismatch',
          properties: { key: spec.key, expected: spec.commandText, observed: composerAfterType },
        });
        await port.sendSpecialKey('Escape');
        return { kind: 'failed', reason: COMPOSER_CONTENT_MISMATCH_REASON };
      }

      const sendEnter = sendResultToFailure(await port.sendSpecialKey('Enter'));
      if (sendEnter) return sendEnter;
      ctx.onCommandSubmitted?.(spec.commandText);
    }

    // Verification poll (incident cmq8y3nlx, L2): the confirmation can render well after the first
    // settle window (a single early capture produced false `failed/unverified` outcomes for
    // commands Claude executed moments later). Poll until confirmation, declined evidence (L6),
    // queued-by-provider evidence, or a bounded ceiling.
    const verifyPollIntervalMs = Math.max(1, timings.verifyPollIntervalMs);
    const maxVerifyPolls = Math.max(1, Math.ceil(timings.verifyPollTimeoutMs / verifyPollIntervalMs));

    type PollEvaluation = Readonly<{
      declinedReason: string | null;
      effective: string | null;
      queuedByProvider: boolean;
      unrecognizedDialog: boolean;
      settled: boolean;
    }>;
    const evaluate = (state: ClaudeScreenState): PollEvaluation => {
      if (state.unrecognizedConfirmationDialogVisible) {
        // A dialog we caused but do not recognize (P-B): settle immediately and fail closed below —
        // stale scrollback text must never verify "through" an open unknown dialog.
        return { declinedReason: null, effective: null, queuedByProvider: false, unrecognizedDialog: true, settled: true };
      }
      const declined = spec.detectDeclined?.(state) ?? null;
      if (declined !== null) return { declinedReason: declined, effective: null, queuedByProvider: false, unrecognizedDialog: false, settled: true };
      const verified = spec.verify(state);
      if (verified !== null) return { declinedReason: null, effective: verified, queuedByProvider: false, unrecognizedDialog: false, settled: true };
      if (state.generating || state.queuedMessageBannerVisible) {
        // A turn started while the command was in flight: Claude queued it (probe P-D). It was
        // DELIVERED and will run at turn end — report delivered-pending, never a failure.
        return { declinedReason: null, effective: null, queuedByProvider: true, unrecognizedDialog: false, settled: true };
      }
      return { declinedReason: null, effective: null, queuedByProvider: false, unrecognizedDialog: false, settled: false };
    };

    let finalState: ClaudeScreenState | null = preVerifyState;
    let evaluation: PollEvaluation = preVerifyState !== null
      ? evaluate(preVerifyState)
      : { declinedReason: null, effective: null, queuedByProvider: false, unrecognizedDialog: false, settled: false };
    for (let poll = 0; poll < maxVerifyPolls && !evaluation.settled; poll += 1) {
      await wait(poll === 0 && preVerifyState === null ? timings.commandSettleMs : verifyPollIntervalMs);
      const captured = await captureScreenState(port);
      if (captured.kind !== 'state') return captureFailureToResult(captured);
      finalState = await spec.resolveFinalState(captured.state);
      evaluation = evaluate(finalState);
    }
    const { declinedReason, effective, queuedByProvider } = evaluation;

    if (evaluation.unrecognizedDialog) {
      // P-B fail-closed: the command surfaced a dialog we do not recognize. No Escape (decline)
      // and no answer bytes — escalate once to requires_interactive_control via the outcome map.
      await restoreOnce();
      return unrecognizedDialogResult();
    }

    if (declinedReason !== null) {
      // The follow-up dialog resolved as declined/kept: precise failure, never silent. The
      // controller escalates repeated declines once to requires_interactive_control.
      ctx.telemetry?.emit({
        name: 'unified.control.verification_mismatch',
        properties: { key: spec.key, expected: spec.commandText, observed: declinedReason },
      });
      const restore = await restoreOnce();
      return { kind: 'failed', reason: restore.ok ? declinedReason : `settings_guard:${restore.reason}` };
    }

    if (effective === null) {
      if (queuedByProvider) {
        const restore = await restoreOnce();
        if (!restore.ok) return { kind: 'failed', reason: `settings_guard:${restore.reason}` };
        return { kind: 'scheduled', timing: 'next_idle', reason: 'queued_by_provider' };
      }
      if (finalState !== null && spec.ownsDialog?.(finalState) === true) {
        // The dialog never accepted the bounded answers: cancel it cleanly (dialog Escape =
        // "No, go back", a no-op for the running session) and fail precisely.
        await port.sendSpecialKey('Escape');
        const restore = await restoreOnce();
        return {
          kind: 'failed',
          reason: restore.ok ? 'control_dialog_unresponsive' : `settings_guard:${restore.reason}`,
        };
      }
      if (finalState !== null && (finalState.slashPickerOpen || finalState.userDraftPresent)) {
        // The command never left the composer: genuinely not delivered. Clear it and fail.
        ctx.telemetry?.emit({
          name: 'unified.control.verification_mismatch',
          properties: { key: spec.key, expected: spec.commandText, observed: undefined },
        });
        await port.sendSpecialKey('Escape');
        const restore = await restoreOnce();
        return {
          kind: 'failed',
          reason: restore.ok ? 'not_delivered' : `settings_guard:${restore.reason}`,
        };
      }
      // Clean composer, no confirmation within the ceiling: the command WAS submitted and may have
      // executed (or render its confirmation late). Never emit a definitive failure and never send
      // Escape (it could cancel the executing command), but do not greenlight a required prompt
      // under an unverified model/effort; later evidence (UserPromptSubmit metadata /
      // confirmation text) reconciles the verified config.
      ctx.telemetry?.emit({
        name: 'unified.control.verification_mismatch',
        properties: { key: spec.key, expected: spec.commandText, observed: undefined },
      });
      const restore = await restoreOnce();
      if (!restore.ok) return { kind: 'failed', reason: `settings_guard:${restore.reason}` };
      return { kind: 'scheduled', timing: 'queued_until_safe_window', reason: 'delivered_unverified' };
    }

    const restore = await restoreOnce();
    if (!restore.ok) {
      return { kind: 'failed', reason: `settings_guard:${restore.reason}` };
    }
    return { kind: 'applied', effective, timing: appliedTiming(ctx.reason) };
  } finally {
    // The command may have executed even when a send/capture failed (host race), so the snapshot
    // restore must run on every exit before the per-config-root lock is released.
    const restore = await restoreOnce().catch(() => ({ ok: false as const, reason: 'restore threw' }));
    if (!restore.ok) {
      ctx.telemetry?.emit({
        name: 'unified.control.settings_restore_failed',
        properties: { key: spec.key, reason: restore.reason },
      });
    }
    await session.release();
  }
}

export async function applyModelControl(ctx: SlashControlContext, model: string): Promise<ControlAttemptResult> {
  const { port, wait, timings } = ctx.runtime;
  return runSlashControl(ctx, {
    key: 'model',
    commandText: `/model ${model}`,
    resolveFinalState: async (state) => {
      if (!state.switchModelDialogVisible) return state;
      // Answer the `Switch model?` dialog deliberately: option 1 = "Yes, switch".
      await port.sendLiteralText('1');
      await port.sendSpecialKey('Enter');
      await wait(timings.commandSettleMs);
      const after = await captureScreenState(port);
      return after.kind === 'state' ? after.state : state;
    },
    verify: (state) => state.visibleModel,
  });
}

export async function applyEffortControl(ctx: SlashControlContext, effort: string): Promise<ControlAttemptResult> {
  const { port, wait, timings } = ctx.runtime;
  const requested = effort.trim().toLowerCase();
  // `/effort ultracode` runs at xhigh, so the dialog announces "Switching to xhigh" (binary source
  // 2.1.173: `ultracode` maps to `xhigh` before the confirmation component renders).
  const acceptableTargets = requested === 'ultracode' ? ['ultracode', 'xhigh'] : [requested];

  let confirmAnswers = 0;
  let answeredConfirm = false;
  let keptCountAtConfirm = 0;

  const targetMatches = (state: ClaudeScreenState): boolean =>
    state.effortChangeDialogTarget === null || acceptableTargets.includes(state.effortChangeDialogTarget);

  const answerDialog = async (state: ClaudeScreenState, option: '1' | '2'): Promise<ClaudeScreenState> => {
    if (option === '1') {
      confirmAnswers += 1;
      answeredConfirm = true;
      keptCountAtConfirm = state.keptEffortNoticeCount;
    }
    await port.sendLiteralText(option);
    await port.sendSpecialKey('Enter');
    await wait(timings.commandSettleMs);
    const after = await captureScreenState(port);
    return after.kind === 'state' ? after.state : state;
  };

  return runSlashControl(ctx, {
    key: 'reasoningEffort',
    commandText: `/effort ${effort}`,
    ownsDialog: (state) => state.effortChangeDialogVisible,
    resolveLeftoverDialog: async (state) => {
      if (targetMatches(state)) {
        // The leftover dialog (queued command executed at turn end) asks exactly for the requested
        // level: confirm it instead of typing a duplicate command.
        return { action: 'confirmed', state: await answerDialog(state, '1') };
      }
      // Stale dialog for a DIFFERENT level: dismiss it ("No, go back" keeps the current effort —
      // an expected kept-notice, not a decline of THIS request) and type the fresh command.
      return { action: 'dismissed', state: await answerDialog(state, '2') };
    },
    resolveFinalState: async (state) => {
      if (!state.effortChangeDialogVisible) return state;
      if (confirmAnswers >= MAX_DIALOG_ANSWER_ATTEMPTS) return state;
      // Answer the `Change effort level?` confirmation deliberately: option 1 = "Yes, switch to
      // <level>" (incident cmq8y3nlx L6 — a blind Enter resolved the dialog to its default and
      // Claude kept the old level). An unknown target after OUR command is ours; a mismatched one
      // is stale and dismissed so the queued command behind it can run.
      return answerDialog(state, targetMatches(state) ? '1' : '2');
    },
    verify: (state) => (state.effortChangeDialogVisible ? null : state.visibleEffort),
    detectAlreadyEffective: (state) => {
      // Ultracode is a session-only setting, not a level: plain xhigh/ultracode scrollback evidence
      // never proves it, so an ultracode request is always typed.
      if (requested === 'ultracode') return null;
      // Latest confirmation row wins (kept outranks older set rows by screen position): a resumed
      // TUI re-renders this conversation's effort evidence, and matching evidence means re-typing
      // `/effort` is pure churn (incident cmq7pyqkj, U2).
      const latest = state.latestEffortConfirmation;
      return latest !== null && latest.level === requested ? latest.level : null;
    },
    detectDeclined: (state) => {
      if (!answeredConfirm || state.effortChangeDialogVisible) return null;
      const latest = state.latestEffortConfirmation;
      // Only a kept-notice that is NEWER than the ones visible when we confirmed counts: stale
      // kept rows from an earlier dismissal must not fail a confirm that simply rendered late.
      if (latest?.kind === 'kept' && state.keptEffortNoticeCount > keptCountAtConfirm) {
        return EFFORT_CHANGE_DECLINED_REASON;
      }
      return null;
    },
  });
}
