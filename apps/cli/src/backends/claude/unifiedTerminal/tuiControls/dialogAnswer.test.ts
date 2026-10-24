import { describe, expect, it } from 'vitest';

import { createFakeControlPort } from './fakeControlPort';
import { answerClaudeUnifiedRegisteredDialog } from './dialogAnswer';
import { getClaudeUnifiedDialogIdentity, resolveClaudeUnifiedVisibleDialog } from './dialogRegistry';
import type { ClaudeUnifiedVisibleNativeToolDialog } from './dialogRegistry';
import { parseClaudeScreenState } from './screenState';
import type { ClaudeScreenState } from './screenState';
import { parseClaudeNativePermissionScreen } from './nativePermissionScreen';
import { readFileSync } from 'node:fs';
import { wrapBracketedPaste } from '@/agent/runtime/terminal/injection/bracketedPaste';

const HIDDEN_TRUST_REJECT_FOCUSED = [
  'Accessing workspace:',
  '/tmp/happier-claude-dialog-probe',
  '',
  'Quick safety check: Is this a project you created or one you trust?',
  '',
  '❯ No, exit',
  '  Yes, I trust this folder',
  '',
  'Enter to confirm · Esc to cancel',
].join('\n');

const HIDDEN_TRUST_ACCEPT_FOCUSED = HIDDEN_TRUST_REJECT_FOCUSED
  .replace('❯ No, exit', '  No, exit')
  .replace('  Yes, I trust this folder', '❯ Yes, I trust this folder');

const HIDDEN_UNKNOWN_FIRST_FOCUSED = [
  'Allow external CLAUDE.md file imports?',
  '',
  '❯ No, disable external imports',
  '  Yes, allow external imports',
  '',
  'Enter to confirm · Esc to cancel',
].join('\n');

const HIDDEN_UNKNOWN_SECOND_FOCUSED = HIDDEN_UNKNOWN_FIRST_FOCUSED
  .replace('❯ No, disable external imports', '  No, disable external imports')
  .replace('  Yes, allow external imports', '❯ Yes, allow external imports');

const NUMBERED_TRUST = [
  'Do you trust the files in this folder?',
  '❯ 1. Yes, I trust this folder',
  '  2. No, exit',
].join('\n');

const IDLE = 'What would you like to work on?\n❯ ';
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

function trustDialog(screen: string) {
  const dialog = resolveClaudeUnifiedVisibleDialog(parseClaudeScreenState(screen));
  expect(dialog?.dialogId).toBe('trust_folder');
  return dialog!;
}

describe('answerClaudeUnifiedRegisteredDialog', () => {
  it('navigates to native No through scopes whose footer omits the unavailable amendment hint', async () => {
    const second = readFileSync(new URL('./__fixtures__/claude-2.1.309-permission-remember-focused.txt', import.meta.url), 'utf8');
    const initial = second.replace(' ❯ 2.', '   2.').replace('   1.', ' ❯ 1.').replace(' Esc to cancel', ' Esc to cancel · Tab to amend');
    const third = second.replace(' ❯ 2.', '   2.').replace('   3.', ' ❯ 3.');
    const fourth = readFileSync(new URL('./__fixtures__/claude-2.1.309-permission-no-focused.txt', import.meta.url), 'utf8');
    const port = createFakeControlPort({ captures: [initial, second, third, fourth, IDLE] });
    await expect(answerClaudeUnifiedRegisteredDialog({ port, dialogId: 'tool_permission', choice: '4',
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
    await expect(answerClaudeUnifiedRegisteredDialog({ port, dialogId: 'tool_permission', choice: '3', feedback,
      resolveDialog: nativePermission, isCurrent: () => true, settleMs: 0, wait: async () => undefined,
      verifyPollIntervalMs: 1, verifyPollTimeoutMs: 2,
    })).resolves.toEqual({ status: 'answered' });
    expect(port.sentRaw).toEqual([wrapBracketedPaste(feedback)]);
    expect(port.sentKeys).toEqual(['Enter']);
    const conflicting = createFakeControlPort({ captures: [filled] });
    await expect(answerClaudeUnifiedRegisteredDialog({ port: conflicting, dialogId: 'tool_permission', choice: '3', feedback: 'Different feedback',
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
    await expect(answerClaudeUnifiedRegisteredDialog({ port, dialogId: 'tool_permission', choice: '3', feedback,
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
    await expect(answerClaudeUnifiedRegisteredDialog({ port, dialogId: 'tool_permission', choice: '3', feedback,
      resolveDialog: nativePermission, isCurrent: () => true, settleMs: 0, wait: async () => undefined,
      verifyPollIntervalMs: 1, verifyPollTimeoutMs: 2,
    })).resolves.toEqual({ status: 'answered' });
    expect(port.sentRaw).toEqual([wrapBracketedPaste(feedback)]);
    expect(port.sentKeys).toEqual(['Enter']);
  });
  it('confirms a native permission only after its form is gone and the canonical composer is visible', async () => {
    const port = createFakeControlPort({ captures: [NATIVE_PERMISSION, IDLE] });
    await expect(answerClaudeUnifiedRegisteredDialog({ port, dialogId: 'tool_permission', choice: '1',
      resolveDialog: nativePermission, isCurrent: () => true, settleMs: 0, wait: async () => undefined,
      verifyPollIntervalMs: 1, verifyPollTimeoutMs: 2,
    })).resolves.toEqual({ status: 'answered' });
    expect(port.sentKeys).toEqual(['Enter']);
  });
  it('does not report a changed native permission form or an incomplete redraw as completed approval', async () => {
    for (const after of [NATIVE_PERMISSION.replace('remember python3 *', 'remember every command'), 'redrawing']) {
      const port = createFakeControlPort({ captures: [NATIVE_PERMISSION, after] });
      await expect(answerClaudeUnifiedRegisteredDialog({ port, dialogId: 'tool_permission', choice: '1',
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
    await expect(answerClaudeUnifiedRegisteredDialog({ port, dialogId: 'tool_permission', choice: '1',
      initialState, expectedIdentity: getClaudeUnifiedDialogIdentity(initial), resolveDialog: nativePermission,
      isCurrent: () => true, settleMs: 0, wait: async () => undefined,
      verifyPollIntervalMs: 1, verifyPollTimeoutMs: 2,
    })).resolves.toMatchObject({ status: 'dialog_changed' });
    expect(port.sentKeys).toEqual([]);
  });

  it('requires native form completion even if a generic caller requests no verification', async () => {
    const port = createFakeControlPort({ captures: [NATIVE_PERMISSION] });
    await expect(answerClaudeUnifiedRegisteredDialog({ port, dialogId: 'tool_permission', choice: '1',
      resolveDialog: nativePermission, isCurrent: () => true, settleMs: 0, wait: async () => undefined,
      verifyAfterSubmit: false, verifyPollIntervalMs: 1, verifyPollTimeoutMs: 2,
    })).resolves.toMatchObject({ status: 'failed' });
    expect(port.sentKeys).toEqual(['Enter']);
  });
  it('uses the exact visible numeric shortcut when indexes are present', async () => {
    const dialog = trustDialog(NUMBERED_TRUST);
    const port = createFakeControlPort({ captures: [NUMBERED_TRUST, IDLE] });

    await expect(answerClaudeUnifiedRegisteredDialog({
      port,
      dialogId: 'trust_folder',
      expectedIdentity: getClaudeUnifiedDialogIdentity(dialog),
      choice: 'trust_once',
      settleMs: 0,
      wait: async () => undefined,
    })).resolves.toEqual({ status: 'answered' });

    expect(port.sentLiteral).toEqual(['1']);
    expect(port.sentKeys).toEqual([]);
  });

  it('navigates a hidden-index chooser one verified focus step at a time before Enter', async () => {
    const dialog = trustDialog(HIDDEN_TRUST_REJECT_FOCUSED);
    const port = createFakeControlPort({
      captures: [HIDDEN_TRUST_REJECT_FOCUSED, HIDDEN_TRUST_ACCEPT_FOCUSED, IDLE],
    });

    await expect(answerClaudeUnifiedRegisteredDialog({
      port,
      dialogId: 'trust_folder',
      choice: 'trust_once',
      settleMs: 0,
      wait: async () => undefined,
    })).resolves.toEqual({ status: 'answered' });

    expect(port.sentLiteral).toEqual([]);
    expect(port.sentKeys).toEqual(['ArrowDown', 'Enter']);
  });

  it('fails closed without Enter when a hidden-index chooser does not move', async () => {
    const dialog = trustDialog(HIDDEN_TRUST_REJECT_FOCUSED);
    const port = createFakeControlPort({
      captures: [HIDDEN_TRUST_REJECT_FOCUSED, HIDDEN_TRUST_REJECT_FOCUSED],
    });

    await expect(answerClaudeUnifiedRegisteredDialog({
      port,
      dialogId: 'trust_folder',
      choice: 'trust_once',
      settleMs: 0,
      wait: async () => undefined,
    })).resolves.toEqual({ status: 'failed', reason: 'selection_did_not_move' });

    expect(port.sentLiteral).toEqual([]);
    expect(port.sentKeys).toEqual(['ArrowDown']);
  });

  it('uses the same verified navigation for a future hidden-index dialog parsed generically', async () => {
    const dialog = resolveClaudeUnifiedVisibleDialog(parseClaudeScreenState(HIDDEN_UNKNOWN_FIRST_FOCUSED));
    expect(dialog?.dialogId).toBe('unrecognized_confirmation');
    const port = createFakeControlPort({
      captures: [HIDDEN_UNKNOWN_FIRST_FOCUSED, HIDDEN_UNKNOWN_SECOND_FOCUSED, IDLE],
    });

    await expect(answerClaudeUnifiedRegisteredDialog({
      port,
      dialogId: 'unrecognized_confirmation',
      expectedIdentity: getClaudeUnifiedDialogIdentity(dialog!),
      choice: 'option_2',
      settleMs: 0,
      wait: async () => undefined,
    })).resolves.toEqual({ status: 'answered' });

    expect(port.sentLiteral).toEqual([]);
    expect(port.sentKeys).toEqual(['ArrowDown', 'Enter']);
  });
});
