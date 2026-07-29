import { createHash, randomUUID } from 'node:crypto';

import type { TerminalControlPort } from '@happier-dev/agents';
import type {
  ClaudePermissionContext,
  ClaudePermissionDecision,
} from '../../../../permissions/createClaudePermissionEngine.js';
import {
  DEFAULT_CLAUDE_UNIFIED_TERMINAL_WORKSPACE_TRUST_POLICY,
  CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE,
  normalizeClaudeUnifiedTerminalWorkspaceTrustPolicy,
  type ClaudeUnifiedTerminalWorkspaceTrustPolicy,
} from '@happier-dev/agents';

import { CLAUDE_UNIFIED_TERMINAL_PROVIDER_ID } from '../constants.js';
import type { ClaudeScreenState } from '../screenState.js';
import { answerClaudeUnifiedRegisteredDialog } from '../tuiControls/dialogAnswer.js';
import {
  buildClaudeUnifiedDialogQuestionInput,
  getClaudeUnifiedDialogIdentity,
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

type PermissionDecisionResult = ClaudePermissionDecision;

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
  ctx: ClaudePermissionContext;
  sessionId: string;
  policy?: ClaudeUnifiedResumeChoicePolicy | null | undefined;
  workspaceTrustPolicy?: ClaudeUnifiedTerminalWorkspaceTrustPolicy | null | undefined;
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
  /** Event edge used by startup readiness to suspend every timeout/relaunch timer while a human owns the prompt. */
  onPendingUserActionChange?: ((pending: boolean) => void) | undefined;
  /** Arms runtime-local ownership only when resume-from-summary Enter reaches the terminal. */
  onResumeSummaryCompactResidue?: (() => void) | undefined;
}>): Readonly<{
  handle(screen: ClaudeScreenState): Promise<ClaudeUnifiedResumeChoiceStartupResult>;
  hasPendingUserAction(): boolean;
  dispose(): Promise<void>;
}> {
  const policy = normalizeClaudeUnifiedResumeChoice(params.policy) ?? DEFAULT_CLAUDE_UNIFIED_RESUME_CHOICE;
  const workspaceTrustPolicy = normalizeClaudeUnifiedTerminalWorkspaceTrustPolicy(params.workspaceTrustPolicy)
    ?? DEFAULT_CLAUDE_UNIFIED_TERMINAL_WORKSPACE_TRUST_POLICY;
  let disposed = false;
  let pendingAbort: AbortController | null = null;
  let pendingRequest: Promise<void> | null = null;
  let pendingIdentity: string | null = null;
  let closedIdentity: string | null = null;
  let autoAttemptedIdentity: string | null = null;
  let pendingUserActionNotified = false;
  const runtimeInstanceId = randomUUID();
  const orphanDialogAnswerAttempts = new Map<ClaudeUnifiedRecognizedDialogId, number>();

  const cancelPending = async (): Promise<void> => {
    const task = pendingRequest;
    pendingAbort?.abort();
    pendingAbort = null;
    pendingRequest = null;
    pendingIdentity = null;
    if (task) await task.catch(() => undefined);
    if (pendingUserActionNotified) {
      pendingUserActionNotified = false;
      params.onPendingUserActionChange?.(false);
    }
  };

  const isStartupActive = (): boolean => params.isStartupActive?.() ?? true;

  const answerVia = async (
    dialogId: ClaudeUnifiedRecognizedDialogId,
    expectedIdentity: string,
    dialogOption: ClaudeUnifiedDialogOption,
  ): Promise<boolean> => {
    const result = await answerClaudeUnifiedRegisteredDialog({
      port: params.port,
      dialogId,
      expectedIdentity,
      option: dialogOption,
      settleMs: params.settleMs,
      wait: params.wait,
      onSubmitted: dialogId === 'resume_choice' && dialogOption.choice === 'resume_from_summary'
        ? params.onResumeSummaryCompactResidue
        : undefined,
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

    const identity = getClaudeUnifiedDialogIdentity(dialog);
    const result = await answerClaudeUnifiedRegisteredDialog({
      port: params.port,
      dialogId: dialog.dialogId,
      expectedIdentity: identity,
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
    const identity = getClaudeUnifiedDialogIdentity(dialog);
    const abort = new AbortController();
    pendingAbort = abort;
    pendingIdentity = identity;
    const digest = createHash('sha256')
      .update(`${runtimeInstanceId}\0${identity}`, 'utf8')
      .digest('hex')
      .slice(0, 24);
    const requestId = `${params.sessionId}:claude-dialog:${digest}`;
    const task = params.ctx.sessions.current.permissions.requestDecision({
      provider: CLAUDE_UNIFIED_TERMINAL_PROVIDER_ID,
      source: CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE,
      requestId,
      toolCallId: requestId,
      toolName: 'AskUserQuestion',
      input: buildClaudeUnifiedDialogQuestionInput(dialog),
      reason: dialog.requestReason,
    }, { signal: abort.signal }).then(async (result) => {
      if (pendingRequest !== task || pendingIdentity !== identity || abort.signal.aborted) return;
      // An incomplete/ambiguous prompt is navigation-only. A returned UI value can never become
      // terminal input; the exact episode remains closed until the visible identity changes.
      if (dialog.kind === 'unrecognized' && dialog.mode === 'notice') {
        closedIdentity = identity;
        return;
      }
      const dialogOption = resolveClaudeUnifiedDialogSelectedOption(readDecisionAnswers(result), dialog.options);
      const answered = dialogOption && dialog.kind === 'recognized'
        ? await answerVia(dialog.dialogId, identity, dialogOption)
        : dialogOption && dialog.kind === 'unrecognized'
          ? await answerClaudeUnifiedRegisteredDialog({
            port: params.port,
            dialogId: 'unrecognized_confirmation',
            expectedIdentity: identity,
            option: dialogOption,
            settleMs: params.settleMs,
            wait: params.wait,
          }).then((answerResult) => answerResult.status === 'answered' || answerResult.status === 'not_visible')
          : false;
      if (!answered) closedIdentity = identity;
    }).catch(() => {
      if (pendingRequest === task) closedIdentity = identity;
    }).finally(() => {
      if (pendingRequest !== task) return;
      pendingAbort = null;
      pendingRequest = null;
      pendingIdentity = null;
      if (pendingUserActionNotified) {
        pendingUserActionNotified = false;
        params.onPendingUserActionChange?.(false);
      }
    });
    pendingRequest = task;
    if (!pendingUserActionNotified) {
      pendingUserActionNotified = true;
      params.onPendingUserActionChange?.(true);
    }
  };

  const publish = (dialog: ClaudeUnifiedVisibleDialog): ClaudeUnifiedResumeChoiceStartupResult => {
    const identity = getClaudeUnifiedDialogIdentity(dialog);
    if (closedIdentity === identity) return 'unhandled';
    startAsk(dialog);
    return pendingRequest ? 'waiting_for_user' : 'unhandled';
  };

  const handleResumeChoiceDialog = async (
    dialog: ClaudeUnifiedVisibleRecognizedDialog,
    screen: ClaudeScreenState,
  ): Promise<ClaudeUnifiedResumeChoiceStartupResult> => {
    const identity = getClaudeUnifiedDialogIdentity(dialog);
    if (closedIdentity === identity) return 'unhandled';
    if (policy !== 'ask_every_time') {
      if (autoAttemptedIdentity === identity) return 'unhandled';
      autoAttemptedIdentity = identity;
      const entry = getClaudeUnifiedRecognizedDialogRegistryEntry(dialog.dialogId);
      const dialogOption = resolveClaudeUnifiedRegisteredDialogOption(screen, entry, policy);
      const answered = dialogOption ? await answerVia(dialog.dialogId, identity, dialogOption) : false;
      if (!answered) {
        closedIdentity = identity;
        return 'unhandled';
      }
      return 'handled';
    }
    return publish(dialog);
  };

  const handleTrustFolderDialog = async (
    dialog: ClaudeUnifiedVisibleRecognizedDialog,
    screen: ClaudeScreenState,
  ): Promise<ClaudeUnifiedResumeChoiceStartupResult> => {
    if (workspaceTrustPolicy === 'ask_every_time') return publish(dialog);
    const identity = getClaudeUnifiedDialogIdentity(dialog);
    if (autoAttemptedIdentity === identity) return 'unhandled';
    autoAttemptedIdentity = identity;
    const entry = getClaudeUnifiedRecognizedDialogRegistryEntry('trust_folder');
    const optionChoice = workspaceTrustPolicy === 'always_trust_happier_workspaces'
      ? 'always_trust_happier_workspaces'
      : 'always_reject_happier_workspaces';
    const dialogOption = resolveClaudeUnifiedRegisteredDialogOption(screen, entry, optionChoice);
    const answered = dialogOption ? await answerVia('trust_folder', identity, dialogOption) : false;
    if (!answered) {
      closedIdentity = identity;
      return 'unhandled';
    }
    return 'handled';
  };

  return Object.freeze({
    async handle(screen) {
      if (disposed) return 'unhandled';

      const dialog = resolveClaudeUnifiedVisibleDialog(screen);
      if (!dialog) {
        if (pendingRequest) await cancelPending();
        closedIdentity = null;
        return 'unhandled';
      }

      const identity = getClaudeUnifiedDialogIdentity(dialog);
      if (closedIdentity !== null && closedIdentity !== identity) closedIdentity = null;
      // Any identity mutation replaces the episode, including same-id context/option changes.
      if (pendingIdentity !== null && pendingIdentity !== identity) await cancelPending();

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
      if (dialog.dialogId === 'trust_folder') return handleTrustFolderDialog(dialog, screen);
      // null owner (usage_limit, safeguard_pause): always publish for a user decision.
      return publish(dialog);
    },
    hasPendingUserAction() {
      return pendingRequest !== null;
    },
    async dispose() {
      disposed = true;
      await cancelPending();
    },
  });
}
