import { describe, expect, it } from 'vitest';

import {
  CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE,
  isClaudeUnifiedTerminalDialogChoiceAgentStateRequest,
} from './permissionRequestSource.js';

describe('Claude permission request source', () => {
  it('identifies unified terminal dialog-choice agent-state requests', () => {
    expect(CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE)
      .toBe('claude_unified_terminal_dialog_choice');
    expect(isClaudeUnifiedTerminalDialogChoiceAgentStateRequest({
      source: CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE,
    })).toBe(true);
    expect(isClaudeUnifiedTerminalDialogChoiceAgentStateRequest({ source: 'other' })).toBe(false);
    expect(isClaudeUnifiedTerminalDialogChoiceAgentStateRequest(null)).toBe(false);
  });
});
