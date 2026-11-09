import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { createFakeControlPort } from './tuiControls/fakeControlPort.js';
import { releaseUsageLimitDialogBeforePromptInjection } from './usageLimitPromptInjection.js';

function fixture(name: string): string {
  return readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8');
}

describe('releaseUsageLimitDialogBeforePromptInjection', () => {
  it.each([
    [1, 'Stop and wait for limit to reset', 'at Nov 8, 4pm'],
    [2, 'Stop and wait for limit to reset', 'shortly'],
    [3, 'Stop and wait for limit to reset', 'when the limit resets'],
    [1, 'Stop', 'when the limit resets'],
    [2, 'Stop', 'at Nov 8, 4pm'],
    [3, 'Stop', 'shortly'],
  ] as const)('releases the parsed cropped 2.1.316 chooser focused on %i with %s / %s', async (focus, stop, automatic) => {
    const capture = fixture('claude-2.1.316-cropped-usage-limit.txt')
      .replace('Stop and wait for limit to reset', stop)
      .replace('at Nov 8, 4pm', automatic)
      .replace('❯ 1.', '  1.')
      .replace(`  ${focus}.`, `❯ ${focus}.`);
    const port = createFakeControlPort({ captures: [capture, fixture('healthy-92862-idle.ansi')] });

    await expect(releaseUsageLimitDialogBeforePromptInjection({
      port,
      wait: async () => undefined,
      settleMs: 0,
    })).resolves.toBeUndefined();
    expect(port.sentKeys).toEqual(['Escape']);
  });

  it.each([
    fixture('claude-2.1.316-cropped-usage-limit.txt').replace('  2.', '  4.'),
    ['What do you want to do?', '', '❯ 1. Stop', '  2. Continue the build'].join('\n'),
  ])('keeps unknown or malformed menus untouched', async (capture) => {
    const port = createFakeControlPort({ captures: [capture] });

    await expect(releaseUsageLimitDialogBeforePromptInjection({
      port,
      wait: async () => undefined,
      settleMs: 0,
    })).resolves.toBeUndefined();
    expect(port.sentKeys).toEqual([]);
  });

  it('does not report closure when the chooser remains visible with another option focused', async () => {
    const capture = fixture('claude-2.1.316-cropped-usage-limit.txt');
    const port = createFakeControlPort({
      captures: [capture, capture.replace('❯ 1.', '  1.').replace('  3.', '❯ 3.')],
    });

    await expect(releaseUsageLimitDialogBeforePromptInjection({
      port,
      wait: async () => undefined,
      settleMs: 0,
    })).rejects.toThrow('claude_usage_dialog_not_released');
    expect(port.sentKeys).toEqual(['Escape']);
  });

  it('dismisses the current weekly-limit chooser independently of numbered transcript history', async () => {
    const port = createFakeControlPort({ captures: [
      readFileSync(new URL('./__fixtures__/incident-weekly-limit-after-numbered-transcript.txt', import.meta.url), 'utf8'),
      readFileSync(new URL('./__fixtures__/healthy-92862-idle.ansi', import.meta.url), 'utf8'),
    ] });
    await expect(releaseUsageLimitDialogBeforePromptInjection({
      port, wait: async () => undefined, settleMs: 0,
    })).resolves.toBeUndefined();
    expect(port.sentKeys).toEqual(['Escape']);
  });
});
