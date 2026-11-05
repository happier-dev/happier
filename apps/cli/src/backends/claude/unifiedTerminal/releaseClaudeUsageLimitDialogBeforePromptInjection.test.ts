import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createFakeControlPort } from './tuiControls/fakeControlPort';
import { releaseClaudeUsageLimitDialogBeforePromptInjection } from './releaseClaudeUsageLimitDialogBeforePromptInjection';

function fixture(name: string): string {
  return readFileSync(resolve(__dirname, 'tuiControls/__fixtures__', name), 'utf8');
}

describe('releaseClaudeUsageLimitDialogBeforePromptInjection', () => {
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

    await expect(releaseClaudeUsageLimitDialogBeforePromptInjection({
      port,
      wait: async () => undefined,
      settleMs: 0,
    })).resolves.toEqual({ status: 'released' });
    expect(port.sentKeys).toEqual(['Escape']);
  });

  it.each([
    fixture('claude-2.1.316-cropped-usage-limit.txt').replace('  2.', '  4.'),
    ['What do you want to do?', '', '❯ 1. Stop', '  2. Continue the build'].join('\n'),
  ])('keeps unknown or malformed menus untouched', async (capture) => {
    const port = createFakeControlPort({ captures: [capture] });

    await expect(releaseClaudeUsageLimitDialogBeforePromptInjection({
      port,
      wait: async () => undefined,
      settleMs: 0,
    })).resolves.toEqual({ status: 'not_visible' });
    expect(port.sentKeys).toEqual([]);
  });

  it('does not report closure when the chooser remains visible with another option focused', async () => {
    const capture = fixture('claude-2.1.316-cropped-usage-limit.txt');
    const port = createFakeControlPort({
      captures: [capture, capture.replace('❯ 1.', '  1.').replace('  3.', '❯ 3.')],
    });

    await expect(releaseClaudeUsageLimitDialogBeforePromptInjection({
      port,
      wait: async () => undefined,
      settleMs: 0,
    })).resolves.toEqual({ status: 'failed', reason: 'usage_limit_dialog_still_visible' });
    expect(port.sentKeys).toEqual(['Escape']);
  });

  it.each(['incident-89861-ratelimit-resume.ansi', 'incident-weekly-limit-after-numbered-transcript.txt'])(
    'dismisses only a freshly observed usage-limit dialog before injection (%s)', async (name) => {
    const port = createFakeControlPort({
      captures: [
        fixture(name),
        fixture('healthy-92862-idle.ansi'),
      ],
    });

    await expect(releaseClaudeUsageLimitDialogBeforePromptInjection({
      port,
      wait: async () => undefined,
      settleMs: 0,
    })).resolves.toEqual({ status: 'released' });
    expect(port.sentKeys).toEqual(['Escape']);
  });

  it('does not press a key when the exact current screen has no usage-limit dialog', async () => {
    const port = createFakeControlPort({ captures: [fixture('healthy-92862-idle.ansi')] });

    await expect(releaseClaudeUsageLimitDialogBeforePromptInjection({
      port,
      wait: async () => undefined,
      settleMs: 0,
    })).resolves.toEqual({ status: 'not_visible' });
    expect(port.sentKeys).toEqual([]);
  });
});
