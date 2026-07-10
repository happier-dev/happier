import type { PluginContextV1 } from '@happier-dev/plugin-sdk';
import type { TerminalControlPort } from '@happier-dev/plugin-sdk/experimental/runtime/session';

import { CLAUDE_UNIFIED_TERMINAL_PROVIDER_ID } from '../constants.js';
import type { ClaudeScreenState } from '../screenState.js';
import { answerClaudeUnifiedRegisteredDialog } from '../tuiControls/dialogAnswer.js';
import {
  buildClaudeUnifiedDialogQuestionInput,
  CLAUDE_UNIFIED_UNRECOGNIZED_DIALOG_NOTICE,
  getClaudeUnifiedRecognizedDialogRegistryEntry,
  resolveClaudeUnifiedDialogSelectedOption,
  resolveClaudeUnifiedRegisteredDialogOption,
  resolveClaudeUnifiedVisibleDialog,
  type ClaudeUnifiedDialogOption,
  type ClaudeUnifiedRecognizedDialogId,
  type ClaudeUnifiedVisibleDialog,
  type ClaudeUnifiedVisibleRecognizedDialog,
} from '../tuiControls/dialogRegistry.js';
import {
  DEFAULT_CLAUDE_UNIFIED_RESUME_CHOICE,
  normalizeClaudeUnifiedResumeChoice,
  type ClaudeUnifiedResumeChoicePolicy,
} from './types.js';

export type ClaudeUnifiedResumeChoiceStartupResult =
  | 'unhandled'
  | 'handled'
  | 'waiting_for_user';

export type ClaudeUnifiedStartupRuntimeConfig = Readonly<{
  model: string | null;
  reasoningEffort: string | null;
  ultracode: boolean;
}>;

type PermissionDecisionResult = Awaited<ReturnType<PluginContextV1['sessions']['current']['permissions']['requestDecision']>>;

const MAX_ORPHAN_STARTUP_DIALOG_ANSWER_ATTEMPTS = 2;

function normalizeNonEmptyString(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveConfiguredEffortTargets(config: ClaudeUnifiedStartupRuntimeConfig): readonly string[] {
  if (config.ultracode) return ['ultracode', 'xhigh'];
  const effort = normalizeNonEmptyString(config.reasoningEffort);
  return effort ? [effort] : [];
}

function hasConfiguredModel(config: ClaudeUnifiedStartupRuntimeConfig): boolean {
  return normalizeNonEmptyString(config.model) !== null;
}

function readDecisionAnswers(
  result: PermissionDecisionResult,
): Readonly<Record<string, unknown>> | null {
  if (result.decision === 'denied' || result.decision === 'abort') return null;
  return (result.answers as Readonly<Record<string, unknown>> | undefined) ?? null;
}

/**
 * The Claude Unified startup dialog resolver. It is registry-driven: for every screen it resolves
 * the single visible dialog from {@link resolveClaudeUnifiedVisibleDialog} and either
 *  - defers to live runtime control while a slash-control run owns the dialog, or
 *  - auto-answers an orphan effort/model dialog from the launch runtime config during startup, or
 *  - publishes the dialog as an `AskUserQuestion` needs-attention request and answers the terminal
 *    with the user's selected option (the recipe from the registry), or
 *  - fail-closed publishes an `open_terminal` notice for a dialog it does NOT recognize.
 * There is exactly ONE publisher and ONE answer table (the registry) so startup never
 * double-publishes or re-matches terminal text.
 */
export function createClaudeUnifiedResumeChoiceStartupHandler(params: Readonly<{
  ctx: PluginContextV1;
  sessionId: string;
  policy?: ClaudeUnifiedResumeChoicePolicy | null | undefined;
  port: TerminalControlPort;
  settleMs: number;
  wait: (ms: number) => Promise<void>;
  runtimeConfig?: ClaudeUnifiedStartupRuntimeConfig | undefined;
  isRuntimeControlInFlight?: (() => boolean) | undefined;
  /**
   * Startup-ready window predicate. `resume_choice` is owned (auto-answered / single-published) only
   * while startup is active; post-startup it fails OPEN (published like any other dialog) so a resume
   * dialog surfacing after startup is never silently deferred. Absent → defaults to startup-active.
   */
  isStartupActive?: (() => boolean) | undefined;
}>): Readonly<{
  handle(screen: ClaudeScreenState): Promise<ClaudeUnifiedResumeChoiceStartupResult>;
  hasPendingUserAction(): boolean;
  dispose(): void;
}> {
  const policy = normalizeClaudeUnifiedResumeChoice(params.policy) ?? DEFAULT_CLAUDE_UNIFIED_RESUME_CHOICE;
  let disposed = false;
  let pendingAbort: AbortController | null = null;
  let pendingRequest: Promise<void> | null = null;
  let pendingGeneration = 0;
  let pendingDialogId: ClaudeUnifiedRecognizedDialogId | 'unrecognized_confirmation' | null = null;
  let closedDialogId: ClaudeUnifiedRecognizedDialogId | 'unrecognized_confirmation' | null = null;
  let autoAttemptedDialogId: ClaudeUnifiedRecognizedDialogId | null = null;
  const orphanDialogAnswerAttempts = new Map<ClaudeUnifiedRecognizedDialogId, number>();

  const cancelPending = (): void => {
    pendingGeneration += 1;
    pendingAbort?.abort();
    pendingAbort = null;
    pendingRequest = null;
    pendingDialogId = null;
  };

  const isStartupActive = (): boolean => params.isStartupActive?.() ?? true;

  const answerVia = async (
    dialogId: ClaudeUnifiedRecognizedDialogId,
    dialogOption: ClaudeUnifiedDialogOption,
  ): Promise<boolean> => {
    const result = await answerClaudeUnifiedRegisteredDialog({
      port: params.port,
      dialogId,
      option: dialogOption,
      settleMs: params.settleMs,
      wait: params.wait,
    });
    return result.status === 'answered' || result.status === 'not_visible';
  };

  const resolveOrphanOption = (
    dialog: ClaudeUnifiedVisibleRecognizedDialog,
    screen: ClaudeScreenState,
    config: ClaudeUnifiedStartupRuntimeConfig,
  ): ClaudeUnifiedDialogOption | null => {
    const entry = getClaudeUnifiedRecognizedDialogRegistryEntry(dialog.dialogId);
    if (dialog.dialogId === 'effort_change') {
      const targets = resolveConfiguredEffortTargets(config);
      const choice = screen.effortChangeDialogTarget !== null && targets.includes(screen.effortChangeDialogTarget)
        ? 'confirm'
        : 'cancel';
      return resolveClaudeUnifiedRegisteredDialogOption(screen, entry, choice);
    }
    if (dialog.dialogId === 'switch_model') {
      return resolveClaudeUnifiedRegisteredDialogOption(screen, entry, hasConfiguredModel(config) ? 'confirm' : 'cancel');
    }
    return null;
  };

  const answerOrphan = async (
    dialog: ClaudeUnifiedVisibleRecognizedDialog,
    screen: ClaudeScreenState,
    config: ClaudeUnifiedStartupRuntimeConfig,
  ): Promise<ClaudeUnifiedResumeChoiceStartupResult> => {
    const attempts = orphanDialogAnswerAttempts.get(dialog.dialogId) ?? 0;
    if (attempts >= MAX_ORPHAN_STARTUP_DIALOG_ANSWER_ATTEMPTS) return 'unhandled';
    const dialogOption = resolveOrphanOption(dialog, screen, config);
    if (!dialogOption) return 'unhandled';

    const result = await answerClaudeUnifiedRegisteredDialog({
      port: params.port,
      dialogId: dialog.dialogId,
      option: dialogOption,
      settleMs: params.settleMs,
      wait: params.wait,
    });
    if (result.status === 'answered' || result.status === 'not_visible') {
      orphanDialogAnswerAttempts.delete(dialog.dialogId);
      return 'handled';
    }
    if (result.status === 'dialog_changed') return 'handled';

    const nextAttempts = attempts + 1;
    orphanDialogAnswerAttempts.set(dialog.dialogId, nextAttempts);
    return nextAttempts >= MAX_ORPHAN_STARTUP_DIALOG_ANSWER_ATTEMPTS ? 'unhandled' : 'handled';
  };

  const startAsk = (dialog: ClaudeUnifiedVisibleDialog): void => {
    if (pendingRequest) return;
    const generation = pendingGeneration + 1;
    pendingGeneration = generation;
    const abort = new AbortController();
    pendingAbort = abort;
    pendingDialogId = dialog.dialogId;
    const reason = dialog.kind === 'unrecognized'
      ? CLAUDE_UNIFIED_UNRECOGNIZED_DIALOG_NOTICE.requestReason
      : dialog.requestReason;
    const requestId = `${params.sessionId}:${dialog.dialogId}`;
    pendingRequest = params.ctx.sessions.current.permissions.requestDecision({
      provider: CLAUDE_UNIFIED_TERMINAL_PROVIDER_ID,
      requestId,
      toolCallId: requestId,
      toolName: 'AskUserQuestion',
      input: buildClaudeUnifiedDialogQuestionInput(dialog),
      reason,
    }, { signal: abort.signal }).then(async (result) => {
      if (generation !== pendingGeneration || abort.signal.aborted) return;
      // An unrecognized dialog is a fail-closed NOTICE: nothing is ever typed. Latch it closed so
      // the same unknown dialog is not republished on every subsequent screen tick.
      if (dialog.kind === 'unrecognized') {
        closedDialogId = dialog.dialogId;
        return;
      }
      const dialogOption = resolveClaudeUnifiedDialogSelectedOption(readDecisionAnswers(result), dialog.options);
      const answered = dialogOption ? await answerVia(dialog.dialogId, dialogOption) : false;
      if (!answered) closedDialogId = dialog.dialogId;
    }).catch(() => {
      if (generation === pendingGeneration) closedDialogId = dialog.dialogId;
    }).finally(() => {
      if (generation !== pendingGeneration) return;
      pendingAbort = null;
      pendingRequest = null;
      pendingDialogId = null;
    });
  };

  const publish = (dialog: ClaudeUnifiedVisibleDialog): ClaudeUnifiedResumeChoiceStartupResult => {
    if (closedDialogId === dialog.dialogId) return 'unhandled';
    startAsk(dialog);
    return pendingRequest ? 'waiting_for_user' : 'unhandled';
  };

  const handleResumeChoiceDialog = async (
    dialog: ClaudeUnifiedVisibleRecognizedDialog,
    screen: ClaudeScreenState,
  ): Promise<ClaudeUnifiedResumeChoiceStartupResult> => {
    if (closedDialogId === dialog.dialogId) return 'unhandled';
    if (policy !== 'ask_every_time') {
      if (autoAttemptedDialogId === dialog.dialogId) return 'unhandled';
      autoAttemptedDialogId = dialog.dialogId;
      const entry = getClaudeUnifiedRecognizedDialogRegistryEntry(dialog.dialogId);
      const dialogOption = resolveClaudeUnifiedRegisteredDialogOption(screen, entry, policy);
      const answered = dialogOption ? await answerVia(dialog.dialogId, dialogOption) : false;
      if (!answered) {
        closedDialogId = dialog.dialogId;
        return 'unhandled';
      }
      return 'handled';
    }
    return publish(dialog);
  };

  return Object.freeze({
    async handle(screen) {
      if (disposed) return 'unhandled';

      const dialog = resolveClaudeUnifiedVisibleDialog(screen);
      if (!dialog) {
        if (pendingRequest) cancelPending();
        closedDialogId = null;
        return 'unhandled';
      }

      if (closedDialogId !== null && closedDialogId !== dialog.dialogId) closedDialogId = null;
      // A→B dialog replacement: cancel the stale publish so the new dialog can republish.
      if (pendingDialogId !== null && pendingDialogId !== dialog.dialogId) cancelPending();

      if (dialog.kind === 'unrecognized') {
        return publish(dialog);
      }

      const owner = dialog.owner;
      if (owner?.kind === 'slash_controls') {
        if (params.isRuntimeControlInFlight?.() === true) return 'unhandled';
        if (isStartupActive() && params.runtimeConfig) {
          return answerOrphan(dialog, screen, params.runtimeConfig);
        }
        return publish(dialog);
      }
      if (owner?.kind === 'resume_startup') {
        if (isStartupActive()) return handleResumeChoiceDialog(dialog, screen);
        return publish(dialog);
      }
      // null owner (usage_limit, safeguard_pause): always publish for a user decision.
      return publish(dialog);
    },
    hasPendingUserAction() {
      return pendingRequest !== null;
    },
    dispose() {
      disposed = true;
      cancelPending();
    },
  });
}
