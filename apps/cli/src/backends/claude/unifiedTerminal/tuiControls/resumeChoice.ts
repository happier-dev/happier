import type { TerminalControlPort } from '@/integrations/terminalHost/controlTypes';

import {
  captureFailureToResult,
  captureScreenState,
  sendResultToFailure,
} from './controlRuntime';
import {
  getClaudeUnifiedRecognizedDialogRegistryEntry,
  isClaudeUnifiedRegisteredDialogVisible,
  resolveClaudeUnifiedRegisteredDialogOption,
} from './dialogRegistry';

export type ClaudeUnifiedResumeChoiceAnswer =
  | 'resume_from_summary'
  | 'always_resume_from_summary'
  | 'resume_full_session'
  | 'always_resume_full_session';

export function resolveClaudeUnifiedResumeChoiceAnswer(value: string): ClaudeUnifiedResumeChoiceAnswer | null {
  return value === 'resume_from_summary'
    || value === 'always_resume_from_summary'
    || value === 'resume_full_session'
    || value === 'always_resume_full_session'
    ? value
    : null;
}

export function isClaudeUnifiedResumeFromSummaryChoice(choice: ClaudeUnifiedResumeChoiceAnswer): boolean {
  return choice === 'resume_from_summary' || choice === 'always_resume_from_summary';
}

export type ClaudeResumeChoiceDialogAnswerResult =
  | Readonly<{ kind: 'answered'; choice: ClaudeUnifiedResumeChoiceAnswer }>
  | Readonly<{ kind: 'not_visible' }>
  | Readonly<{ kind: 'failed'; reason: string }>
  | Readonly<{ kind: 'unsupported'; reason?: string | undefined }>;

function controlFailureToResumeChoiceResult(
  failure: ReturnType<typeof sendResultToFailure> | ReturnType<typeof captureFailureToResult>,
): ClaudeResumeChoiceDialogAnswerResult | null {
  if (failure === null) return null;
  if (failure.kind === 'unsupported') return { kind: 'unsupported', reason: failure.reason };
  const reason = 'reason' in failure && typeof failure.reason === 'string'
    ? failure.reason
    : failure.kind;
  return { kind: 'failed', reason };
}

const RESUME_CHOICE_DIALOG = getClaudeUnifiedRecognizedDialogRegistryEntry('resume_choice');

export async function answerClaudeResumeChoiceDialog(params: Readonly<{
  port: TerminalControlPort;
  choice: ClaudeUnifiedResumeChoiceAnswer;
  wait: (ms: number) => Promise<void>;
  settleMs: number;
  /** Fired after the option's complete answer recipe was successfully written to Claude's terminal. */
  onSubmitted?: (() => void) | undefined;
}>): Promise<ClaudeResumeChoiceDialogAnswerResult> {
  const before = await captureScreenState(params.port);
  if (before.kind !== 'state') {
    return controlFailureToResumeChoiceResult(captureFailureToResult(before)) ?? { kind: 'failed', reason: 'capture_failed' };
  }
  if (!isClaudeUnifiedRegisteredDialogVisible(before.state, RESUME_CHOICE_DIALOG)) {
    return { kind: 'not_visible' };
  }

  const option = resolveClaudeUnifiedRegisteredDialogOption(before.state, RESUME_CHOICE_DIALOG, params.choice);
  if (!option) return { kind: 'failed', reason: `resume_choice_option_missing:${params.choice}` };

  const sendOptionFailure = controlFailureToResumeChoiceResult(
    sendResultToFailure(await params.port.sendLiteralText(option.answer.text)),
  );
  if (sendOptionFailure) return sendOptionFailure;

  params.onSubmitted?.();

  await params.wait(params.settleMs);
  const after = await captureScreenState(params.port);
  if (after.kind !== 'state') {
    return controlFailureToResumeChoiceResult(captureFailureToResult(after)) ?? { kind: 'failed', reason: 'capture_failed' };
  }
  if (isClaudeUnifiedRegisteredDialogVisible(after.state, RESUME_CHOICE_DIALOG)) {
    return { kind: 'failed', reason: 'resume_choice_dialog_still_visible' };
  }
  return { kind: 'answered', choice: params.choice };
}
