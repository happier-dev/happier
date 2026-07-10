import { describe, expect, it } from 'vitest';

import { answerClaudeUnifiedRegisteredDialog } from './dialogAnswer.js';
import { getClaudeUnifiedRecognizedDialogRegistryEntry } from './dialogRegistry.js';
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

const IDLE_COMPOSER = [
  '──────────────────────────────',
  '❯ ',
  '──────────────────────────────',
].join('\n');

function confirmOption(dialogId: 'effort_change') {
  const entry = getClaudeUnifiedRecognizedDialogRegistryEntry(dialogId);
  return entry.options({ effortChangeDialogTarget: 'high' } as never)[0];
}

describe('answerClaudeUnifiedRegisteredDialog', () => {
  it('recaptures before typing and answers the recognized dialog via its recipe', async () => {
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
    expect(port.sentKeys).toEqual(['Enter']);
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
});
