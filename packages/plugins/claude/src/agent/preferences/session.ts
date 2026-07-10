import {
  CLAUDE_REMOTE_AGENT_SETTINGS_DEFAULTS,
  normalizeClaudeUnifiedTerminalResumeChoice,
  type ClaudeUnifiedTerminalResumeChoice,
} from '../../protocol/remoteSettings.js';

export type ClaudeSessionRuntimePreferences = Readonly<{
  claudeUnifiedTerminalResumeChoice: ClaudeUnifiedTerminalResumeChoice;
}>;

const DEFAULT_CLAUDE_UNIFIED_TERMINAL_RESUME_CHOICE: ClaudeUnifiedTerminalResumeChoice =
  normalizeClaudeUnifiedTerminalResumeChoice(CLAUDE_REMOTE_AGENT_SETTINGS_DEFAULTS.claudeUnifiedTerminalResumeChoice)
  ?? 'ask_every_time';

export function resolveClaudeSessionRuntimePreferences(params: Readonly<{
  settings: Readonly<Record<string, unknown>>;
}>): ClaudeSessionRuntimePreferences {
  return {
    claudeUnifiedTerminalResumeChoice:
      normalizeClaudeUnifiedTerminalResumeChoice(params.settings.claudeUnifiedTerminalResumeChoice)
      ?? DEFAULT_CLAUDE_UNIFIED_TERMINAL_RESUME_CHOICE,
  };
}
