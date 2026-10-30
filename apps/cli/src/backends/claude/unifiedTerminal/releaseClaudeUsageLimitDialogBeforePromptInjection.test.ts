import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createFakeControlPort } from './tuiControls/fakeControlPort';
import { releaseClaudeUsageLimitDialogBeforePromptInjection } from './releaseClaudeUsageLimitDialogBeforePromptInjection';

function fixture(name: string): string {
  return readFileSync(resolve(__dirname, 'tuiControls/__fixtures__', name), 'utf8');
}

describe('releaseClaudeUsageLimitDialogBeforePromptInjection', () => {
  it('dismisses only a freshly observed usage-limit dialog before injection', async () => {
    const port = createFakeControlPort({
      captures: [
        fixture('incident-89861-ratelimit-resume.ansi'),
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
