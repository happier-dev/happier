import type { TerminalControlPort } from '@/integrations/terminalHost/controlTypes';

import { answerClaudeUnifiedRegisteredDialog } from './dialogAnswer';

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

export async function answerClaudeResumeChoiceDialog(params: Readonly<{
  port: TerminalControlPort;
  choice: ClaudeUnifiedResumeChoiceAnswer;
  wait: (ms: number) => Promise<void>;
  settleMs: number;
  /** Fired after the option's complete answer recipe was successfully written to Claude's terminal. */
  onSubmitted?: (() => void) | undefined;
}>): Promise<ClaudeResumeChoiceDialogAnswerResult> {
  const result = await answerClaudeUnifiedRegisteredDialog({
    port: params.port,
    dialogId: 'resume_choice',
    choice: params.choice,
    settleMs: params.settleMs,
    wait: params.wait,
    onSubmitted: params.onSubmitted,
  });
  if (result.status === 'answered') return { kind: 'answered', choice: params.choice };
  if (result.status === 'not_visible') return { kind: 'not_visible' };
  if (result.status === 'dialog_changed') return { kind: 'not_visible' };
  return {
    kind: 'failed',
    reason: result.reason === 'dialog_still_visible' ? 'resume_choice_dialog_still_visible' : result.reason,
  };
}
