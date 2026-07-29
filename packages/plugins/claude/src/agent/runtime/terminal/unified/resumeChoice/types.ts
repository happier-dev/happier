import {
  DEFAULT_CLAUDE_UNIFIED_TERMINAL_RESUME_CHOICE,
  normalizeClaudeUnifiedTerminalResumeChoice,
  type ClaudeUnifiedTerminalResumeChoice,
} from '@happier-dev/agents';

export type ClaudeUnifiedResumeChoicePolicy = ClaudeUnifiedTerminalResumeChoice;

export const DEFAULT_CLAUDE_UNIFIED_RESUME_CHOICE: ClaudeUnifiedResumeChoicePolicy =
  DEFAULT_CLAUDE_UNIFIED_TERMINAL_RESUME_CHOICE;

export const CLAUDE_UNIFIED_RESUME_CHOICE_QUESTION =
  'How should Claude resume this session?';

export function normalizeClaudeUnifiedResumeChoice(raw: unknown): ClaudeUnifiedResumeChoicePolicy | null {
  return normalizeClaudeUnifiedTerminalResumeChoice(raw);
}
