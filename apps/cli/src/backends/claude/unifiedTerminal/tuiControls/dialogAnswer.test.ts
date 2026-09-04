import { describe, expect, it } from 'vitest';

import { createFakeControlPort } from './fakeControlPort';
import { answerClaudeUnifiedRegisteredDialog } from './dialogAnswer';
import { getClaudeUnifiedDialogIdentity, resolveClaudeUnifiedVisibleDialog } from './dialogRegistry';
import { parseClaudeScreenState } from './screenState';

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

function trustDialog(screen: string) {
  const dialog = resolveClaudeUnifiedVisibleDialog(parseClaudeScreenState(screen));
  expect(dialog?.dialogId).toBe('trust_folder');
  return dialog!;
}

describe('answerClaudeUnifiedRegisteredDialog', () => {
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
