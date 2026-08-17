export const CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE = 'claude_unified_terminal_dialog_choice' as const;

type ClaudeUnifiedTerminalDialogChoiceAgentStateRequest = Readonly<{
  source: typeof CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE;
}>;

export function isClaudeUnifiedTerminalDialogChoiceAgentStateRequest(
  request: unknown,
): request is ClaudeUnifiedTerminalDialogChoiceAgentStateRequest {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return false;
  }

  return (request as { source?: unknown }).source === CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE;
}
