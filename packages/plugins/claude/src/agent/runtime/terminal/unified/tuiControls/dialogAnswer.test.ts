import { readFileSync } from 'node:fs';
import type { ClaudeScreenState } from '../screenState.js';
import type { ClaudeUnifiedVisibleNativeToolDialog } from './dialogRegistry.js';
import { parseClaudeNativePermissionScreen } from './nativePermissionScreen.js';
import { encodeClaudeNativeTextInput as wrapBracketedPaste } from './controlRuntime.js';
import { describe, expect, it, vi } from 'vitest';

import { parseClaudeScreenState } from '../screenState.js';
import { answerClaudeUnifiedRegisteredDialog } from './dialogAnswer.js';
import {
  getClaudeUnifiedDialogIdentity,
  getClaudeUnifiedRecognizedDialogRegistryEntry,
  resolveClaudeUnifiedVisibleDialog,
} from './dialogRegistry.js';
import { createFakeControlPort } from './fakeControlPort.js';

const EFFORT_DIALOG = [
  'Change effort level?',
  'Switching to high means the full history will be processed with high effort.',
  '',
  '❯ 1. Yes, switch to high',
  '  2. No, go back',
].join('\n');

const SAFEGUARD_DIALOG = [
  'Session paused',
  '',
  "Fable 5's safeguards flagged this message.",
  '',
  '❯ 1. Switch to Opus 4.8',
  '  2. Edit prompt and retry with Fable 5',
].join('\n');

const RESUME_CHOICE_DIALOG = [
  'This session is 18h old and 560.4k tokens.',
  '❯ 1. Resume from summary',
  '  2. Resume full session',
].join('\n');

const IDLE_COMPOSER = [
  '──────────────────────────────',
  '❯ ',
  '──────────────────────────────',
].join('\n');

const HIDDEN_TRUST_DIALOG = [
  'Quick safety check: is this a project you created or one you trust?',
  '',
  '❯ No, exit',
  '  Yes, I trust this folder',
  '',
  'Enter to confirm · Esc to cancel',
].join('\n');

const HIDDEN_UNKNOWN_DIALOG = [
  'Allow external CLAUDE.md file imports?',
  '',
  '❯ No, disable external imports',
  '  Yes, allow external imports',
  '',
  'Enter to confirm · Esc to cancel',
].join('\n');

function confirmOption(dialogId: 'effort_change') {
  const entry = getClaudeUnifiedRecognizedDialogRegistryEntry(dialogId);
  return entry.options({ effortChangeDialogTarget: 'high' } as never)[0];
}

describe('answerClaudeUnifiedRegisteredDialog', () => {
  it('navigates a hidden-shortcut dialog to the semantic target and confirms it', async () => {
    const state = parseClaudeScreenState(HIDDEN_TRUST_DIALOG);
    const dialog = resolveClaudeUnifiedVisibleDialog(state);
    expect(dialog?.kind).toBe('recognized');
    const option = dialog?.kind === 'recognized'
      ? dialog.options.find((candidate) => candidate.choice === 'trust_once')
      : null;
    const focusedTrust = HIDDEN_TRUST_DIALOG.replace('❯ No, exit', '  No, exit').replace('  Yes, I trust this folder', '❯ Yes, I trust this folder');
    const port = createFakeControlPort({ captures: [HIDDEN_TRUST_DIALOG, focusedTrust, IDLE_COMPOSER] });

    const result = await answerClaudeUnifiedRegisteredDialog({
      port,
      dialogId: 'trust_folder',
      option: option!,
      settleMs: 0,
      wait: async () => undefined,
    });

    expect(result).toEqual({ status: 'answered' });
    expect(port.sentLiteral).toEqual([]);
    expect(port.sentKeys).toEqual(['ArrowDown', 'Enter']);
  });

  it('never presses Enter when hidden-shortcut focus does not visibly move', async () => {
    const state = parseClaudeScreenState(HIDDEN_TRUST_DIALOG);
    const dialog = resolveClaudeUnifiedVisibleDialog(state);
    const option = dialog?.kind === 'recognized'
      ? dialog.options.find((candidate) => candidate.choice === 'trust_once')
      : null;
    const port = createFakeControlPort({ captures: [HIDDEN_TRUST_DIALOG, HIDDEN_TRUST_DIALOG] });

    const result = await answerClaudeUnifiedRegisteredDialog({
      port,
      dialogId: 'trust_folder',
      option: option!,
      settleMs: 0,
      wait: async () => undefined,
    });

    expect(result.status).toBe('failed');
    expect(port.sentKeys).toEqual(['ArrowDown']);
  });

  it('uses verified navigation for a future hidden-shortcut dialog parsed generically', async () => {
    const state = parseClaudeScreenState(HIDDEN_UNKNOWN_DIALOG);
    const dialog = resolveClaudeUnifiedVisibleDialog(state);
    expect(dialog?.kind).toBe('unrecognized');
    const option = dialog?.kind === 'unrecognized' ? dialog.options[1] : null;
    const focusedTarget = HIDDEN_UNKNOWN_DIALOG
      .replace('❯ No, disable external imports', '  No, disable external imports')
      .replace('  Yes, allow external imports', '❯ Yes, allow external imports');
    const port = createFakeControlPort({ captures: [HIDDEN_UNKNOWN_DIALOG, focusedTarget, IDLE_COMPOSER] });

    const result = await answerClaudeUnifiedRegisteredDialog({
      port,
      dialogId: 'unrecognized_confirmation',
      expectedIdentity: getClaudeUnifiedDialogIdentity(dialog!),
      option: option!,
      settleMs: 0,
      wait: async () => undefined,
    });

    expect(result).toEqual({ status: 'answered' });
    expect(port.sentLiteral).toEqual([]);
    expect(port.sentKeys).toEqual(['ArrowDown', 'Enter']);
  });

  it('types zero bytes when a same-id dialog option mutates before the answer', async () => {
    const original = parseClaudeScreenState([
      'Session paused',
      "Fable 5's safeguards flagged this message.",
      '❯ 1. Switch to Opus 4.8',
      '  2. Edit prompt and retry with Fable 5',
    ].join('\n'));
    const changed = [
      'Session paused',
      "Fable 5's safeguards flagged this message.",
      '❯ 1. Switch to Sonnet 4.7',
      '  2. Edit prompt and retry with Fable 5',
    ].join('\n');
    const dialog = resolveClaudeUnifiedVisibleDialog(original);
    expect(dialog?.kind).toBe('recognized');
    const option = dialog?.kind === 'recognized' ? dialog.options[0] : null;
    const port = createFakeControlPort({ captures: [changed] });

    const result = await answerClaudeUnifiedRegisteredDialog({
      port,
      dialogId: 'safeguard_pause',
      expectedIdentity: getClaudeUnifiedDialogIdentity(dialog!),
      option: option!,
      settleMs: 0,
      wait: async () => undefined,
    });

    expect(result.status).toBe('dialog_changed');
    expect(port.sentLiteral).toEqual([]);
    expect(port.sentKeys).toEqual([]);
  });
  it('recaptures before typing and answers a numbered dialog without appending Enter', async () => {
    const port = createFakeControlPort({ captures: [EFFORT_DIALOG, IDLE_COMPOSER] });
    const result = await answerClaudeUnifiedRegisteredDialog({
      port,
      dialogId: 'effort_change',
      option: confirmOption('effort_change'),
      settleMs: 0,
      wait: async () => undefined,
    });

    expect(result).toEqual({ status: 'answered' });
    expect(port.sentLiteral).toEqual(['1']);
    expect(port.sentKeys).toEqual([]);
  });

  it('does not append Enter after Claude auto-submits a resume-choice numeric shortcut', async () => {
    const state = parseClaudeScreenState(RESUME_CHOICE_DIALOG);
    const dialog = resolveClaudeUnifiedVisibleDialog(state);
    expect(dialog?.kind).toBe('recognized');
    const option = dialog?.kind === 'recognized' ? dialog.options[0] : null;
    const port = createFakeControlPort({ captures: [RESUME_CHOICE_DIALOG, IDLE_COMPOSER] });

    const result = await answerClaudeUnifiedRegisteredDialog({
      port,
      dialogId: 'resume_choice',
      option: option!,
      settleMs: 0,
      wait: async () => undefined,
    });

    expect(result).toEqual({ status: 'answered' });
    expect(port.sentLiteral).toEqual(['1']);
    expect(port.sentKeys).toEqual([]);
  });

  it('types nothing when the recaptured screen shows a DIFFERENT dialog (A→B replacement)', async () => {
    const port = createFakeControlPort({ captures: [SAFEGUARD_DIALOG] });
    const result = await answerClaudeUnifiedRegisteredDialog({
      port,
      dialogId: 'effort_change',
      option: confirmOption('effort_change'),
      settleMs: 0,
      wait: async () => undefined,
    });

    expect(result).toEqual({ status: 'dialog_changed', dialogId: 'safeguard_pause' });
    expect(port.sentLiteral).toEqual([]);
    expect(port.sentKeys).toEqual([]);
  });

  it('reports not_visible when no dialog is on the recaptured screen', async () => {
    const port = createFakeControlPort({ captures: [IDLE_COMPOSER] });
    const result = await answerClaudeUnifiedRegisteredDialog({
      port,
      dialogId: 'effort_change',
      option: confirmOption('effort_change'),
      settleMs: 0,
      wait: async () => undefined,
    });

    expect(result).toEqual({ status: 'not_visible' });
    expect(port.sentLiteral).toEqual([]);
  });

  it('waits through delayed terminal redraws after Claude accepts the numbered shortcut', async () => {
    const port = createFakeControlPort({
      captures: [EFFORT_DIALOG, EFFORT_DIALOG, EFFORT_DIALOG, IDLE_COMPOSER],
    });
    const result = await answerClaudeUnifiedRegisteredDialog({
      port,
      dialogId: 'effort_change',
      option: confirmOption('effort_change'),
      settleMs: 0,
      wait: async () => undefined,
    });

    expect(result).toEqual({ status: 'answered' });
    expect(port.captureCount()).toBe(4);
    expect(port.sentLiteral).toEqual(['1']);
  });

  it('fails when the same dialog is still visible after answering', async () => {
    const port = createFakeControlPort({ captures: [EFFORT_DIALOG, EFFORT_DIALOG] });
    const result = await answerClaudeUnifiedRegisteredDialog({
      port,
      dialogId: 'effort_change',
      option: confirmOption('effort_change'),
      settleMs: 0,
      wait: async () => undefined,
    });

    expect(result).toEqual({ status: 'failed', reason: 'dialog_still_visible' });
    expect(port.sentLiteral).toEqual(['1']);
  });

  it('publishes the exact submission boundary even when post-submit recapture fails', async () => {
    const onSubmitted = vi.fn();
    const port = createFakeControlPort({
      captures: [EFFORT_DIALOG],
      failCaptureAtIndexes: [1],
    });
    const result = await answerClaudeUnifiedRegisteredDialog({
      port,
      dialogId: 'effort_change',
      option: confirmOption('effort_change'),
      settleMs: 0,
      wait: async () => undefined,
      onSubmitted,
    });

    expect(result).toEqual({ status: 'failed', reason: 'host_dead:unrecoverable' });
    expect(onSubmitted).toHaveBeenCalledTimes(1);
  });
});

const IDLE = IDLE_COMPOSER;
const NATIVE_PERMISSION = [
  '──────────────────', 'Bash command', 'python3 -c "print(671)"',
  'Do you want to proceed?', '❯ 1. Yes', '  2. Yes, remember python3 *', '  3. No',
  'Esc to cancel · Tab to amend',
].join('\n');

function nativePermission(state: ClaudeScreenState): ClaudeUnifiedVisibleNativeToolDialog | null {
  const presentation = parseClaudeNativePermissionScreen(state.text);
  if (!presentation) return null;
  return {
    kind: 'native', dialogId: 'tool_permission', occurrenceId: 'native-permission-1',
    toolName: presentation.kind === 'plan' ? 'ExitPlanMode' : 'Bash',
    toolInput: presentation.kind === 'plan' ? { plan: '# A harmless probe plan' } : { command: 'python3 -c "print(671)"' }, questions: [], responseLocation: 'app_and_terminal',
    owner: null, questionId: 'permission', requestReason: 'permission', header: 'Bash', question: presentation.context,
    options: presentation.options.map((option, index) => ({
      choice: String(index + 1), label: option.label, description: option.label,
      answer: { kind: 'selection', targetLabel: option.label },
    })),
    permissionPresentation: presentation,
  };
}

describe('native Claude permission answers', () => {
  it.each(['2', '3'])('submits choice %s through a clipped file permission whose remembered scope hides the amendment hint', async (choice) => {
    // Claude 2.1.316: a long Write preview pushes "Create file" off-screen.
    const initial = [
      '   4 harmless probe preview', '╌╌╌╌╌╌╌',
      ' Do you want to create native-write-probe.txt?',
      ' ❯ 1. Yes',
      '   2. Yes, and always allow access to /tmp/issue671-native-probe/',
      '      workspace for this session', '      (shift+tab)',
      '   3. No', '', ' Esc to cancel · Tab to amend',
    ].join('\n');
    const remembered = initial.replace(' ❯ 1.', '   1.').replace('   2.', ' ❯ 2.').replace(' · Tab to amend', '');
    const rejected = initial.replace(' ❯ 1.', '   1.').replace('   3.', ' ❯ 3.');
    const port = createFakeControlPort({ captures: [initial, remembered, ...(choice === '3' ? [rejected] : []), IDLE] });
    await expect(answerClaudeUnifiedRegisteredDialog({
      port, dialogId: 'tool_permission', option: nativePermission(parseClaudeScreenState(initial))!.options[Number(choice) - 1]!, resolveDialog: nativePermission,
      isCurrent: () => true, settleMs: 0, wait: async () => undefined,
      verifyPollIntervalMs: 1, verifyPollTimeoutMs: 2,
    })).resolves.toEqual({ status: 'answered' });
    expect(port.sentKeys).toEqual(choice === '2' ? ['ArrowDown', 'Enter'] : ['ArrowDown', 'ArrowDown', 'Enter']);
  });

  it('navigates to native No through scopes whose footer omits the unavailable amendment hint', async () => {
    const second = readFileSync(new URL('./__fixtures__/claude-2.1.309-permission-remember-focused.txt', import.meta.url), 'utf8');
    const initial = second.replace(' ❯ 2.', '   2.').replace('   1.', ' ❯ 1.').replace(' Esc to cancel', ' Esc to cancel · Tab to amend');
    const third = second.replace(' ❯ 2.', '   2.').replace('   3.', ' ❯ 3.');
    const fourth = readFileSync(new URL('./__fixtures__/claude-2.1.309-permission-no-focused.txt', import.meta.url), 'utf8');
    const port = createFakeControlPort({ captures: [initial, second, third, fourth, IDLE] });
    await expect(answerClaudeUnifiedRegisteredDialog({ port, dialogId: 'tool_permission', option: nativePermission(parseClaudeScreenState(initial))!.options[3]!,
      resolveDialog: nativePermission, isCurrent: () => true, settleMs: 0, wait: async () => undefined,
      verifyPollIntervalMs: 1, verifyPollTimeoutMs: 2,
    })).resolves.toEqual({ status: 'answered' });
    expect(port.sentKeys).toEqual(['ArrowDown', 'ArrowDown', 'ArrowDown', 'Enter']);
  });
  it('uses canonical bracketed paste for plan feedback and preserves conflicting terminal text', async () => {
    const filled = readFileSync(new URL('./__fixtures__/claude-2.1.304-plan-feedback.txt', import.meta.url), 'utf8');
    const feedback = 'Keep this harmless probe; do not execute the plan.';
    const empty = filled.replace(feedback, 'Tell Claude what to change');
    const port = createFakeControlPort({ captures: [empty, filled, IDLE] });
    await expect(answerClaudeUnifiedRegisteredDialog({ port, dialogId: 'tool_permission', option: nativePermission(parseClaudeScreenState(empty))!.options[2]!, feedback,
      resolveDialog: nativePermission, isCurrent: () => true, settleMs: 0, wait: async () => undefined,
      verifyPollIntervalMs: 1, verifyPollTimeoutMs: 2,
    })).resolves.toEqual({ status: 'answered' });
    expect(port.sentRaw).toEqual([wrapBracketedPaste(feedback)]);
    expect(port.sentKeys).toEqual(['Enter']);
    const conflicting = createFakeControlPort({ captures: [filled] });
    await expect(answerClaudeUnifiedRegisteredDialog({ port: conflicting, dialogId: 'tool_permission', option: nativePermission(parseClaudeScreenState(filled))!.options[2]!, feedback: 'Different feedback',
      resolveDialog: nativePermission, isCurrent: () => true, settleMs: 0, wait: async () => undefined,
      verifyPollIntervalMs: 1, verifyPollTimeoutMs: 2,
    })).resolves.toMatchObject({ status: 'failed' });
    expect(conflicting.sentRaw).toEqual([]);
    expect(conflicting.sentKeys).toEqual([]);
  });
  it('preserves multiline plan feedback through the same native rejection choice', async () => {
    const filled = readFileSync(new URL('./__fixtures__/claude-2.1.304-plan-feedback-multiline.txt', import.meta.url), 'utf8');
    const feedback = 'Keep this harmless probe.\nDo not execute the plan — 雪 🦦';
    const empty = filled.replace('Keep this harmless probe.\n        Do not execute the plan — 雪 🦦', 'Tell Claude what to change');
    const port = createFakeControlPort({ captures: [empty, filled, IDLE] });
    await expect(answerClaudeUnifiedRegisteredDialog({ port, dialogId: 'tool_permission', option: nativePermission(parseClaudeScreenState(empty))!.options[2]!, feedback,
      resolveDialog: nativePermission, isCurrent: () => true, settleMs: 0, wait: async () => undefined,
      verifyPollIntervalMs: 1, verifyPollTimeoutMs: 2,
    })).resolves.toEqual({ status: 'answered' });
    expect(port.sentRaw).toEqual([wrapBracketedPaste(feedback)]);
    expect(port.sentKeys).toEqual(['Enter']);
  });
  it('preserves a TAB in plan feedback through canonical bracketed paste', async () => {
    const filled = readFileSync(new URL('./__fixtures__/claude-2.1.304-plan-feedback-tab.txt', import.meta.url), 'utf8');
    const feedback = 'Keep\tthis harmless probe.\nDo not execute the plan.';
    const empty = filled.replace('Keep    this harmless probe.\n        Do not execute the plan.', 'Tell Claude what to change');
    const port = createFakeControlPort({ captures: [empty, filled, IDLE] });
    await expect(answerClaudeUnifiedRegisteredDialog({ port, dialogId: 'tool_permission', option: nativePermission(parseClaudeScreenState(empty))!.options[2]!, feedback,
      resolveDialog: nativePermission, isCurrent: () => true, settleMs: 0, wait: async () => undefined,
      verifyPollIntervalMs: 1, verifyPollTimeoutMs: 2,
    })).resolves.toEqual({ status: 'answered' });
    expect(port.sentRaw).toEqual([wrapBracketedPaste(feedback)]);
    expect(port.sentKeys).toEqual(['Enter']);
  });
  it('confirms a native permission only after its form is gone and the canonical composer is visible', async () => {
    const port = createFakeControlPort({ captures: [NATIVE_PERMISSION, IDLE] });
    await expect(answerClaudeUnifiedRegisteredDialog({ port, dialogId: 'tool_permission', option: nativePermission(parseClaudeScreenState(NATIVE_PERMISSION))!.options[0]!,
      resolveDialog: nativePermission, isCurrent: () => true, settleMs: 0, wait: async () => undefined,
      verifyPollIntervalMs: 1, verifyPollTimeoutMs: 2,
    })).resolves.toEqual({ status: 'answered' });
    expect(port.sentKeys).toEqual(['Enter']);
  });
  it('does not report a changed native permission form or an incomplete redraw as completed approval', async () => {
    for (const after of [NATIVE_PERMISSION.replace('remember python3 *', 'remember every command'), 'redrawing']) {
      const port = createFakeControlPort({ captures: [NATIVE_PERMISSION, after] });
      await expect(answerClaudeUnifiedRegisteredDialog({ port, dialogId: 'tool_permission', option: nativePermission(parseClaudeScreenState(NATIVE_PERMISSION))!.options[0]!,
        resolveDialog: nativePermission, isCurrent: () => true, settleMs: 0, wait: async () => undefined,
        verifyPollIntervalMs: 1, verifyPollTimeoutMs: 2,
      })).resolves.toMatchObject({ status: 'failed' });
      expect(port.sentKeys).toEqual(['Enter']);
    }
  });

  it('recaptures a native permission before typing even when its caller supplied an earlier capture', async () => {
    const initialState = parseClaudeScreenState(NATIVE_PERMISSION);
    const initial = nativePermission(initialState)!;
    const port = createFakeControlPort({ captures: [NATIVE_PERMISSION.replace('remember python3 *', 'remember every command')] });
    await expect(answerClaudeUnifiedRegisteredDialog({ port, dialogId: 'tool_permission', option: nativePermission(parseClaudeScreenState(NATIVE_PERMISSION))!.options[0]!,
      initialState, expectedIdentity: getClaudeUnifiedDialogIdentity(initial), resolveDialog: nativePermission,
      isCurrent: () => true, settleMs: 0, wait: async () => undefined,
      verifyPollIntervalMs: 1, verifyPollTimeoutMs: 2,
    })).resolves.toMatchObject({ status: 'dialog_changed' });
    expect(port.sentKeys).toEqual([]);
  });

  it('requires native form completion even if a generic caller requests no verification', async () => {
    const port = createFakeControlPort({ captures: [NATIVE_PERMISSION] });
    await expect(answerClaudeUnifiedRegisteredDialog({ port, dialogId: 'tool_permission', option: nativePermission(parseClaudeScreenState(NATIVE_PERMISSION))!.options[0]!,
      resolveDialog: nativePermission, isCurrent: () => true, settleMs: 0, wait: async () => undefined,
      verifyAfterSubmit: false, verifyPollIntervalMs: 1, verifyPollTimeoutMs: 2,
    })).resolves.toMatchObject({ status: 'failed' });
    expect(port.sentKeys).toEqual(['Enter']);
  });
});
