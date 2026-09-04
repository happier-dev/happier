import type { ClaudeUnifiedTerminalResumeChoice } from '@happier-dev/agents';
import type { TerminalControlPort } from '@/integrations/terminalHost/controlTypes';

import type { EnhancedMode } from '../../loop';
import { mapEnhancedModeToDesiredRuntimeConfig } from '../runtimeControlIntegration';
import type { ClaudeUnifiedStartupDialogResolver } from '../createClaudeUnifiedTerminalReadinessBridge';
import {
  answerClaudeResumeChoiceDialog,
  isClaudeUnifiedResumeFromSummaryChoice,
  resolveClaudeUnifiedResumeChoiceAnswer,
} from '../tuiControls/resumeChoice';
import {
  captureFailureToResult,
  captureScreenState,
} from '../tuiControls/controlRuntime';
import { answerClaudeUnifiedRegisteredDialog } from '../tuiControls/dialogAnswer';
import {
  getClaudeUnifiedRecognizedDialogRegistryEntry,
  isClaudeUnifiedRegisteredDialogVisible,
  resolveClaudeUnifiedVisibleDialog,
  type ClaudeUnifiedRecognizedDialogRegistryEntry,
} from '../tuiControls/dialogRegistry';
import type { ClaudeUnifiedDialogChoiceBroker } from '../dialogChoice/claudeUnifiedDialogChoiceBroker';

const MAX_STARTUP_DIALOG_ANSWER_ATTEMPTS = 2;

type StartupDialogKind = 'effort_change' | 'switch_model';

const STARTUP_DIALOGS: Readonly<Record<StartupDialogKind, ClaudeUnifiedRecognizedDialogRegistryEntry>> = {
  effort_change: getClaudeUnifiedRecognizedDialogRegistryEntry('effort_change'),
  switch_model: getClaudeUnifiedRecognizedDialogRegistryEntry('switch_model'),
};

type StartupDialogAnswerResult =
  | Readonly<{ kind: 'answered'; stateVisibleAfterAnswer: boolean }>
  | Readonly<{ kind: 'not_visible' }>
  | Readonly<{ kind: 'failed'; reason: string }>
  | Readonly<{ kind: 'unsupported'; reason?: string | undefined }>;

function controlFailureToStartupDialogResult(
  failure: ReturnType<typeof captureFailureToResult>,
): StartupDialogAnswerResult | null {
  if (failure === null) return null;
  if (failure.kind === 'unsupported') return { kind: 'unsupported', reason: failure.reason };
  const reason = 'reason' in failure && typeof failure.reason === 'string'
    ? failure.reason
    : failure.kind;
  return { kind: 'failed', reason };
}

function normalizeNonEmptyString(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveConfiguredEffortTargets(startupMode: EnhancedMode | undefined): readonly string[] {
  if (!startupMode) return [];
  // This resolver only answers an effort-change dialog Claude has already rendered. The visible
  // dialog is provider evidence that the target exists, so compare it with the configured startup
  // intent directly. The stricter runtime-control mapper still owns whether Happier may proactively
  // request an effort for a model whose capabilities are not evidenced.
  if (startupMode.ultracode === true) return ['ultracode', 'xhigh'];
  const effort = normalizeNonEmptyString(startupMode.reasoningEffort);
  return effort ? [effort] : [];
}

function hasConfiguredModel(startupMode: EnhancedMode | undefined): boolean {
  if (!startupMode) return false;
  return normalizeNonEmptyString(mapEnhancedModeToDesiredRuntimeConfig(startupMode).model) !== null;
}

async function answerStartupDialogOption(params: Readonly<{
  port: TerminalControlPort;
  kind: StartupDialogKind;
  choice: 'confirm' | 'cancel';
  wait: (ms: number) => Promise<void>;
  settleMs: number;
}>): Promise<StartupDialogAnswerResult> {
  const entry = STARTUP_DIALOGS[params.kind];
  const result = await answerClaudeUnifiedRegisteredDialog({
    port: params.port,
    dialogId: entry.dialogId,
    choice: params.choice,
    settleMs: params.settleMs,
    wait: params.wait,
  });
  if (result.status === 'not_visible') return { kind: 'not_visible' };
  if (result.status === 'answered') return { kind: 'answered', stateVisibleAfterAnswer: false };
  return {
    kind: 'failed',
    reason: result.status === 'failed' ? result.reason : `startup_dialog_changed:${result.dialog.dialogId}`,
  };
}

export function createClaudeUnifiedResumeChoiceStartupResolver(params: Readonly<{
  choice: ClaudeUnifiedTerminalResumeChoice;
  broker: ClaudeUnifiedDialogChoiceBroker;
  port: TerminalControlPort;
  wait: (ms: number) => Promise<void>;
  settleMs: number;
  startupMode?: EnhancedMode | undefined;
  isRuntimeControlInFlight?: (() => boolean) | undefined;
  onResumeSummaryCompactionSubmitted?: (() => void) | undefined;
}>): ClaudeUnifiedStartupDialogResolver {
  let pendingAnswerTask: Promise<void> | null = null;
  let terminalAnswerInFlight = false;
  let autoAnswerFailed = false;
  let userChoiceClosed = false;
  const startupDialogAnswerAttempts = new Map<StartupDialogKind, number>();

  const answerOrphanStartupDialog = async (
    kind: StartupDialogKind,
    choice: 'confirm' | 'cancel',
  ): Promise<Readonly<{ status: 'handled' | 'unhandled' }>> => {
    const attempts = startupDialogAnswerAttempts.get(kind) ?? 0;
    if (attempts >= MAX_STARTUP_DIALOG_ANSWER_ATTEMPTS) {
      return { status: 'unhandled' };
    }
    const result = await answerStartupDialogOption({
      port: params.port,
      kind,
      choice,
      wait: params.wait,
      settleMs: params.settleMs,
    });
    if (result.kind === 'not_visible' || (result.kind === 'answered' && !result.stateVisibleAfterAnswer)) {
      startupDialogAnswerAttempts.delete(kind);
      return { status: 'handled' };
    }
    startupDialogAnswerAttempts.set(kind, attempts + 1);
    return attempts + 1 >= MAX_STARTUP_DIALOG_ANSWER_ATTEMPTS
      ? { status: 'unhandled' }
      : { status: 'handled' };
  };

  const startUserChoice = (signal: AbortSignal): void => {
    params.broker.activate();
    if (userChoiceClosed || params.broker.hasPendingChoice('resume_choice') || pendingAnswerTask) return;
    const captured = resolveClaudeUnifiedVisibleDialog(lastScreenState);
    if (!captured || captured.dialogId !== 'resume_choice') return;
    pendingAnswerTask = params.broker.requestDialogChoice({ dialog: captured, signal })
      .then(async (decision) => {
        const choice = resolveClaudeUnifiedResumeChoiceAnswer(decision.choice);
        if (!choice) {
          userChoiceClosed = true;
          return;
        }
        terminalAnswerInFlight = true;
        const result = await answerClaudeResumeChoiceDialog({
          port: params.port,
          choice,
          wait: params.wait,
          settleMs: params.settleMs,
          onSubmitted: isClaudeUnifiedResumeFromSummaryChoice(choice)
            ? params.onResumeSummaryCompactionSubmitted
            : undefined,
        }).finally(() => {
          terminalAnswerInFlight = false;
        });
        if (result.kind === 'answered') {
          params.broker.noteTerminalAnswerSucceeded(captured);
        } else {
          params.broker.noteTerminalAnswerFailed(captured);
        }
        if (result.kind !== 'answered' && result.kind !== 'not_visible') {
          userChoiceClosed = true;
        }
      })
      .catch(() => {
        userChoiceClosed = true;
      })
      .finally(() => {
        pendingAnswerTask = null;
      });
  };

  let lastScreenState: Parameters<ClaudeUnifiedStartupDialogResolver>[0]['screenState'];

  return async ({ screenState, abortSignal }) => {
    lastScreenState = screenState;
    if (params.isRuntimeControlInFlight?.() !== true) {
      if (isClaudeUnifiedRegisteredDialogVisible(screenState, STARTUP_DIALOGS.effort_change)) {
        const targets = resolveConfiguredEffortTargets(params.startupMode);
        const choice = screenState.effortChangeDialogTarget !== null
          && targets.includes(screenState.effortChangeDialogTarget)
          ? 'confirm'
          : 'cancel';
        return answerOrphanStartupDialog('effort_change', choice);
      }
      if (isClaudeUnifiedRegisteredDialogVisible(screenState, STARTUP_DIALOGS.switch_model)) {
        return answerOrphanStartupDialog('switch_model', hasConfiguredModel(params.startupMode) ? 'confirm' : 'cancel');
      }
    }

    const visibleDialog = resolveClaudeUnifiedVisibleDialog(screenState);
    if (visibleDialog && params.broker.hasUnresolvedTerminalAnswerForDialog(visibleDialog)) {
      return { status: 'waiting_for_user' };
    }
    if (
      visibleDialog
      && visibleDialog.dialogId !== 'resume_choice'
      && params.broker.hasPendingChoiceForDialog(visibleDialog)
    ) {
      return { status: 'waiting_for_user' };
    }

    if (!screenState.resumeChoiceDialogVisible) {
      if (params.broker.hasPendingChoice('resume_choice')) {
        await params.wait(params.settleMs);
        const recaptured = await captureScreenState(params.port);
        if (recaptured.kind !== 'state' || recaptured.state.resumeChoiceDialogVisible) {
          return { status: 'waiting_for_user' };
        }
        await params.broker.noteDialogResolvedInTerminal('resume_dialog_resolved_in_terminal');
        return { status: 'handled' };
      }
      return pendingAnswerTask ? { status: 'waiting_for_user' } : { status: 'unhandled' };
    }

    if (params.choice === 'ask_every_time') {
      if (userChoiceClosed) {
        return { status: 'unhandled' };
      }
      startUserChoice(abortSignal);
      return pendingAnswerTask || params.broker.hasPendingChoice('resume_choice') || terminalAnswerInFlight
        ? { status: 'waiting_for_user' }
        : { status: 'unhandled' };
    }

    if (autoAnswerFailed) {
      return { status: 'unhandled' };
    }

    const result = await answerClaudeResumeChoiceDialog({
      port: params.port,
      choice: params.choice,
      wait: params.wait,
      settleMs: params.settleMs,
      onSubmitted: params.choice === 'resume_from_summary'
        ? params.onResumeSummaryCompactionSubmitted
        : undefined,
    });
    if (result.kind === 'answered' || result.kind === 'not_visible') {
      return { status: 'handled' };
    }
    autoAnswerFailed = true;
    return { status: 'unhandled' };
  };
}
