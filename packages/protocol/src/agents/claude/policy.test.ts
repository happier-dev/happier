import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as protocol from '../../index.js';
import {
  CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE,
  isClaudeUnifiedTerminalDialogChoiceAgentStateRequest,
} from './index.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');

describe('Claude Agent policy ownership', () => {
  it('preserves the persisted dialog-choice discriminant through the Protocol owner', () => {
    expect(protocol.CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE)
      .toBe(CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE);
    expect(CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE)
      .toBe('claude_unified_terminal_dialog_choice');
    expect(isClaudeUnifiedTerminalDialogChoiceAgentStateRequest({
      source: CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE,
    })).toBe(true);
    expect(isClaudeUnifiedTerminalDialogChoiceAgentStateRequest({ source: 'other' })).toBe(false);
    expect(isClaudeUnifiedTerminalDialogChoiceAgentStateRequest(null)).toBe(false);

    expect(existsSync(join(repoRoot, 'packages/agents/src/providers/claude/permissionRequestSource.ts')))
      .toBe(false);
  });
});
