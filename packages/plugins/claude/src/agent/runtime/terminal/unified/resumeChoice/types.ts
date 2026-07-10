import type { ClaudeUnifiedResumeChoiceAnswer } from '../screenState.js';

export type ClaudeUnifiedResumeChoicePolicy =
  | 'ask_every_time'
  | ClaudeUnifiedResumeChoiceAnswer;

export const DEFAULT_CLAUDE_UNIFIED_RESUME_CHOICE: ClaudeUnifiedResumeChoicePolicy = 'ask_every_time';

export const CLAUDE_UNIFIED_RESUME_CHOICE_QUESTION =
  'How should Claude resume this session?';

export function normalizeClaudeUnifiedResumeChoice(raw: unknown): ClaudeUnifiedResumeChoicePolicy | null {
  if (
    raw === 'ask_every_time'
    || raw === 'resume_from_summary'
    || raw === 'resume_full_session'
  ) {
    return raw;
  }
  return null;
}
