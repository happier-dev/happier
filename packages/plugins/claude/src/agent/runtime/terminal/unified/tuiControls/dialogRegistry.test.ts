import { describe, expect, it } from 'vitest';

import { parseClaudeScreenState } from '../screenState.js';
import {
  CLAUDE_UNIFIED_RECOGNIZED_DIALOG_REGISTRY,
  resolveClaudeUnifiedDialogBlockedReason,
  resolveClaudeUnifiedVisibleDialog,
} from './dialogRegistry.js';

const EFFORT_DIALOG = [
  '   Change effort level?',
  '   This conversation is cached for the current effort level. Switching to high means the full history gets',
  '   re-read on your next message.',
  '   ❯ 1. Yes, switch to high',
  '     2. No, go back',
].join('\n');

const SAFEGUARD_DIALOG = [
  'Session paused',
  "Fable 5's safeguards flagged this message.",
  '❯ 1. Switch to Opus 4.8',
  '  2. Edit prompt and retry with Fable 5',
].join('\n');

const UNKNOWN_DIALOG = [
  'This session is 18h 2m old and 560.4k tokens.',
  '',
  '❯ 1. Delete history',
  '  2. Continue anyway',
].join('\n');

describe('Claude unified recognized dialog registry', () => {
  it('registers every recognized screen-state detector key exactly once', () => {
    expect(CLAUDE_UNIFIED_RECOGNIZED_DIALOG_REGISTRY.map((entry) => entry.detectorStateKey)).toEqual([
      'switchModelDialogVisible',
      'usageLimitDialogVisible',
      'resumeChoiceDialogVisible',
      'safeguardPauseDialogVisible',
      'effortChangeDialogVisible',
    ]);
    expect(new Set(CLAUDE_UNIFIED_RECOGNIZED_DIALOG_REGISTRY.map((entry) => entry.detectorStateKey)).size).toBe(5);
  });

  it('derives effort choices and answer recipes from parsed screen state without re-matching text', () => {
    const visible = resolveClaudeUnifiedVisibleDialog(parseClaudeScreenState(EFFORT_DIALOG));

    expect(visible).toMatchObject({
      kind: 'recognized',
      dialogId: 'effort_change',
      owner: {
        kind: 'slash_controls',
        controlKeys: ['reasoningEffort', 'launchOption'],
      },
      options: [
        { choice: 'confirm', answer: { kind: 'literal_then_enter', text: '1' } },
        { choice: 'cancel', answer: { kind: 'literal_then_enter', text: '2' } },
      ],
    });
    expect(resolveClaudeUnifiedDialogBlockedReason(parseClaudeScreenState(EFFORT_DIALOG))).toBe('effort_change_dialog');
  });

  it('uses the same registry entry for the safeguard chooser', () => {
    const visible = resolveClaudeUnifiedVisibleDialog(parseClaudeScreenState(SAFEGUARD_DIALOG));

    expect(visible).toMatchObject({
      kind: 'recognized',
      dialogId: 'safeguard_pause',
      owner: null,
      options: [
        { choice: 'switch_model', label: 'Switch to Opus 4.8', answer: { text: '1' } },
        { choice: 'edit_prompt_and_retry', label: 'Edit prompt and retry with Fable 5', answer: { text: '2' } },
      ],
    });
  });

  it('turns an unrecognized confirmation into a typed terminal-only notice', () => {
    expect(resolveClaudeUnifiedVisibleDialog(parseClaudeScreenState(UNKNOWN_DIALOG))).toEqual({
      kind: 'unrecognized',
      dialogId: 'unrecognized_confirmation',
      owner: null,
      notice: 'open_terminal',
    });
    expect(resolveClaudeUnifiedDialogBlockedReason(parseClaudeScreenState(UNKNOWN_DIALOG)))
      .toBe('unrecognized_confirmation_dialog');
  });
});
