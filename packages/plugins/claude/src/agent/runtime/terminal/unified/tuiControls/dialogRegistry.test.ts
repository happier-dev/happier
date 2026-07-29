import { describe, expect, it } from 'vitest';

import { parseClaudeScreenState } from '../screenState.js';
import {
  buildClaudeUnifiedDialogQuestionInput,
  CLAUDE_UNIFIED_RECOGNIZED_DIALOG_REGISTRY,
  getClaudeUnifiedDialogIdentity,
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

const TRUST_FOLDER_DIALOG = [
  'Accessing workspace:',
  '/private/tmp/new-project',
  'Quick safety check: Is this a project you created or one you trust?',
  '❯ 1. Yes, I trust this folder',
  '  2. No, exit',
].join('\n');

// Live Claude 2.1.170+ terminal capture can crop the trust question while retaining the exact
// numbered choices. Those choices still uniquely identify Claude's provider-owned trust gate.
const CROPPED_TRUST_FOLDER_DIALOG = [
  'execute files here.',
  'Security guide',
  '❯ 1. Yes, I trust this folder',
  '  2. No, exit',
].join('\n');

describe('Claude unified recognized dialog registry', () => {
  it('registers every recognized screen-state detector key exactly once', () => {
    expect(CLAUDE_UNIFIED_RECOGNIZED_DIALOG_REGISTRY.map((entry) => entry.detectorStateKey)).toEqual([
      'switchModelDialogVisible',
      'usageLimitDialogVisible',
      'resumeChoiceDialogVisible',
      'safeguardPauseDialogVisible',
      'effortChangeDialogVisible',
      'trustFolderPromptVisible',
    ]);
    expect(new Set(CLAUDE_UNIFIED_RECOGNIZED_DIALOG_REGISTRY.map((entry) => entry.detectorStateKey)).size).toBe(6);
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
        { choice: 'confirm', answer: { kind: 'literal', text: '1' } },
        { choice: 'cancel', answer: { kind: 'literal', text: '2' } },
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
    const dialog = resolveClaudeUnifiedVisibleDialog(parseClaudeScreenState(UNKNOWN_DIALOG));
    expect(dialog).toMatchObject({
      kind: 'unrecognized',
      mode: 'generic',
      dialogId: 'unrecognized_confirmation',
      owner: null,
      context: ['This session is 18h 2m old and 560.4k tokens.'],
      options: [
        { choice: '1', label: 'Delete history', answer: { kind: 'literal', text: '1' } },
        { choice: '2', label: 'Continue anyway', answer: { kind: 'literal', text: '2' } },
      ],
    });
    expect(buildClaudeUnifiedDialogQuestionInput(dialog!)).toMatchObject({
      happierDialog: { kind: 'unrecognized', mode: 'generic' },
      questions: [{
        question: 'This session is 18h 2m old and 560.4k tokens.',
        options: [{ label: 'Delete history' }, { label: 'Continue anyway' }],
      }],
    });
    expect(resolveClaudeUnifiedDialogBlockedReason(parseClaudeScreenState(UNKNOWN_DIALOG)))
      .toBe('unrecognized_confirmation_dialog');
  });

  it('includes context and exact visible options in dialog identity', () => {
    const first = resolveClaudeUnifiedVisibleDialog(parseClaudeScreenState(UNKNOWN_DIALOG));
    const changedContext = resolveClaudeUnifiedVisibleDialog(parseClaudeScreenState(
      UNKNOWN_DIALOG.replace('560.4k tokens', '561.0k tokens'),
    ));
    const changedOption = resolveClaudeUnifiedVisibleDialog(parseClaudeScreenState(
      UNKNOWN_DIALOG.replace('Continue anyway', 'Keep history'),
    ));

    expect(first).not.toBeNull();
    expect(getClaudeUnifiedDialogIdentity(first!)).not.toBe(getClaudeUnifiedDialogIdentity(changedContext!));
    expect(getClaudeUnifiedDialogIdentity(first!)).not.toBe(getClaudeUnifiedDialogIdentity(changedOption!));
  });

  it('falls back to terminal-only presentation when a numbered block is ambiguous', () => {
    const ambiguous = [UNKNOWN_DIALOG, '', '❯ 1. A second block', '  2. Must not type'].join('\n');
    const dialog = resolveClaudeUnifiedVisibleDialog(parseClaudeScreenState(ambiguous));

    expect(dialog).toMatchObject({ kind: 'unrecognized', mode: 'notice', options: [] });
    expect(buildClaudeUnifiedDialogQuestionInput(dialog!)).toMatchObject({
      happierDialog: { kind: 'unrecognized', mode: 'notice', action: 'open_terminal' },
      questions: [{ options: [] }],
    });
  });

  it('requires an explicit trust-or-exit decision for Claude pre-hook workspace trust', () => {
    expect(resolveClaudeUnifiedVisibleDialog(parseClaudeScreenState(TRUST_FOLDER_DIALOG))).toMatchObject({
      kind: 'recognized',
      dialogId: 'trust_folder',
      owner: null,
      questionId: 'claudeUnifiedTerminalTrustFolder',
      requestReason: 'claude_unified_terminal_trust_folder',
      options: [
        { choice: 'trust_once', answer: { kind: 'literal', text: '1' } },
        {
          choice: 'always_trust_happier_workspaces',
          answer: { kind: 'literal', text: '1' },
          settingMutation: {
            settingId: 'claudeUnifiedTerminalWorkspaceTrust',
            value: 'always_trust_happier_workspaces',
          },
        },
        { choice: 'reject_once', answer: { kind: 'literal', text: '2' } },
        {
          choice: 'always_reject_happier_workspaces',
          answer: { kind: 'literal', text: '2' },
        },
      ],
    });
  });

  it('recognizes the live cropped trust screen from its exact numbered choices', () => {
    expect(resolveClaudeUnifiedVisibleDialog(parseClaudeScreenState(CROPPED_TRUST_FOLDER_DIALOG))).toMatchObject({
      kind: 'recognized',
      dialogId: 'trust_folder',
      options: [
        { choice: 'trust_once', answer: { text: '1' } },
        { choice: 'always_trust_happier_workspaces', answer: { text: '1' } },
        { choice: 'reject_once', answer: { text: '2' } },
        { choice: 'always_reject_happier_workspaces', answer: { text: '2' } },
      ],
    });
  });
});
