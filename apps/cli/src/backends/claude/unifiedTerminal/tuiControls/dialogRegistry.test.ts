import { describe, expect, it } from 'vitest';

import { parseClaudeScreenState } from './screenState';
import {
  buildClaudeUnifiedDialogQuestionInput,
  CLAUDE_UNIFIED_RECOGNIZED_DIALOG_REGISTRY,
  getClaudeUnifiedDialogIdentity,
  resolveClaudeUnifiedVisibleDialog,
} from './dialogRegistry';

const EFFORT_DIALOG = [
  'Change effort level?',
  'Switching to high means the full history gets re-read before Claude can continue.',
  '❯ 1. Yes, switch to high',
  '  2. No, go back',
].join('\n');

const SAFEGUARD_DIALOG = [
  'Session paused',
  'Fable 5\'s safeguards flagged this message.',
  '❯ 1. Switch to Opus 4.8',
  '  2. Edit prompt and retry with Fable 5',
].join('\n');

const UNKNOWN_DIALOG = [
  'Reset conversation cache?',
  '❯ 1. Yes, reset it',
  '  2. No, go back',
].join('\n');

const TRUST_FOLDER_DIALOG = [
  'Accessing workspace:',
  '/private/tmp/new-project',
  'Quick safety check: Is this a project you created or one you trust?',
  '❯ 1. Yes, I trust this folder',
  '  2. No, exit',
].join('\n');

const RESUME_DIALOG = [
  'This session is 18h 2m old and 560.4k tokens.',
  'To reduce startup time, Claude can resume from the saved summary or load the full session.',
  '',
  '❯ 1. Resume from summary',
  '  2. Resume full session',
].join('\n');

const CURRENT_USAGE_LIMIT_DIALOG = [
  "You've hit your session limit · resets 2:40am (Europe/Zurich)",
  'What do you want to do?',
  '❯ 1. Stop and wait for limit to reset',
  '  2. Switch to usage credits',
  '  3. Switch to Team plan',
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
  it('presents the exact current provider-owned usage-limit choices', () => {
    const visible = resolveClaudeUnifiedVisibleDialog(parseClaudeScreenState(CURRENT_USAGE_LIMIT_DIALOG));

    expect(visible).toMatchObject({
      kind: 'recognized',
      dialogId: 'usage_limit',
      options: [
        { choice: '1', label: 'Stop and wait for limit to reset', answer: { text: '1' } },
        { choice: '2', label: 'Switch to usage credits', answer: { text: '2' } },
        { choice: '3', label: 'Switch to Team plan', answer: { text: '3' } },
      ],
    });
  });

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

  it('turns a strictly parsed unrecognized confirmation into an exact generic choice request', () => {
    const dialog = resolveClaudeUnifiedVisibleDialog(parseClaudeScreenState(UNKNOWN_DIALOG));
    expect(dialog).toMatchObject({
      kind: 'unrecognized',
      mode: 'generic',
      dialogId: 'unrecognized_confirmation',
      owner: null,
      context: ['Reset conversation cache?'],
      options: [
        { choice: '1', label: 'Yes, reset it', answer: { kind: 'literal', text: '1' } },
        { choice: '2', label: 'No, go back', answer: { kind: 'literal', text: '2' } },
      ],
    });
    expect(buildClaudeUnifiedDialogQuestionInput(dialog!)).toMatchObject({
      happierDialog: {
        kind: 'unrecognized',
        mode: 'generic',
        secondaryAction: 'open_terminal',
      },
      questions: [{
        question: 'Reset conversation cache?',
        options: [{ label: 'Yes, reset it' }, { label: 'No, go back' }],
      }],
    });
  });

  it('includes exact context and visible choices in the request identity', () => {
    const first = resolveClaudeUnifiedVisibleDialog(parseClaudeScreenState(UNKNOWN_DIALOG));
    const changedContext = resolveClaudeUnifiedVisibleDialog(parseClaudeScreenState(
      UNKNOWN_DIALOG.replace('Reset conversation cache?', 'Delete conversation cache?'),
    ));
    const changedOption = resolveClaudeUnifiedVisibleDialog(parseClaudeScreenState(
      UNKNOWN_DIALOG.replace('No, go back', 'Keep cache'),
    ));

    expect(getClaudeUnifiedDialogIdentity(first!)).not.toBe(getClaudeUnifiedDialogIdentity(changedContext!));
    expect(getClaudeUnifiedDialogIdentity(first!)).not.toBe(getClaudeUnifiedDialogIdentity(changedOption!));
  });

  it('falls back to an unanswerable terminal notice when a numbered block is ambiguous', () => {
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
          settingMutation: {
            settingId: 'claudeUnifiedTerminalWorkspaceTrust',
            value: 'always_reject_happier_workspaces',
          },
        },
      ],
    });
  });

  it('offers one-shot and remembered policies through the same resume dialog registry', () => {
    expect(resolveClaudeUnifiedVisibleDialog(parseClaudeScreenState(RESUME_DIALOG))).toMatchObject({
      kind: 'recognized',
      dialogId: 'resume_choice',
      options: [
        { choice: 'resume_from_summary', answer: { text: '1' } },
        {
          choice: 'always_resume_from_summary',
          answer: { text: '1' },
          settingMutation: {
            settingId: 'claudeUnifiedTerminalResumeChoice',
            value: 'resume_from_summary',
          },
        },
        { choice: 'resume_full_session', answer: { text: '2' } },
        {
          choice: 'always_resume_full_session',
          answer: { text: '2' },
          settingMutation: {
            settingId: 'claudeUnifiedTerminalResumeChoice',
            value: 'resume_full_session',
          },
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
