import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as protocol from '../../index.js';
import {
  CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE,
  CURRENT_FLAGSHIP_CLAUDE_MODEL_ID,
  isClaudeUnifiedTerminalDialogChoiceAgentStateRequest,
} from './index.js';

const protocolPackageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const repoRoot = resolve(protocolPackageDir, '..', '..');

describe('Claude Agent policy ownership', () => {
  it('exports one root identity for the shared flagship model policy', () => {
    expect(protocol.CURRENT_FLAGSHIP_CLAUDE_MODEL_ID).toBe(CURRENT_FLAGSHIP_CLAUDE_MODEL_ID);
    expect(CURRENT_FLAGSHIP_CLAUDE_MODEL_ID).toBe('claude-opus-5');

    expect(existsSync(join(protocolPackageDir, 'src/providers/claude/flagshipModel.ts'))).toBe(false);
    const claudeReasoningSource = readFileSync(
      join(repoRoot, 'packages/plugins/claude/src/agent/runtime/reasoningEffort.ts'),
      'utf8',
    );
    expect(claudeReasoningSource).not.toMatch(/export const CURRENT_FLAGSHIP_CLAUDE_MODEL_ID\b/u);
  });

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
