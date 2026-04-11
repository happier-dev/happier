import { afterEach, describe, expect, it, vi } from 'vitest';

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { logger } from '@/ui/logger';

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
  },
}));

describe('readClaudeSessionJsonlMessages', () => {
  let tmpRoot: string | null = null;

  afterEach(async () => {
    if (tmpRoot) {
      await rm(tmpRoot, { recursive: true, force: true });
      tmpRoot = null;
    }
    vi.mocked(logger.debug).mockReset();
  });

  it('bounds parsing to the file tail when maxBytes is provided', async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'happier-claude-jsonl-'));
    const sessionFilePath = join(tmpRoot, 'sess.jsonl');

    const line1 = JSON.stringify({
      type: 'assistant',
      uuid: 'u1',
      message: {},
      pad: 'x'.repeat(5000),
    });
    const line2 = JSON.stringify({ type: 'assistant', uuid: 'u2', message: {} });
    const line3 = JSON.stringify({ type: 'assistant', uuid: 'u3', message: {} });

    await writeFile(sessionFilePath, `${line1}\n${line2}\n${line3}\n`, 'utf8');

    const { readClaudeSessionJsonlMessages } = await import('./readClaudeSessionJsonlMessages');
    const messages = await readClaudeSessionJsonlMessages({
      sessionFilePath,
      logLabel: 'TEST',
      maxBytes: line2.length + line3.length + 10,
    });

    expect(messages.map((m) => m.uuid)).toEqual(['u2', 'u3']);
  });

  it('skips a truncated head line without logging a parse error', async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'happier-claude-jsonl-'));
    const sessionFilePath = join(tmpRoot, 'sess.jsonl');

    const line1 = JSON.stringify({
      type: 'assistant',
      uuid: 'u1',
      message: {},
      pad: 'x'.repeat(5000),
    });
    const line2 = JSON.stringify({ type: 'assistant', uuid: 'u2', message: {} });
    const line3 = JSON.stringify({ type: 'assistant', uuid: 'u3', message: {} });

    await writeFile(sessionFilePath, `${line1}\n${line2}\n${line3}\n`, 'utf8');

    const { readClaudeSessionJsonlMessages } = await import('./readClaudeSessionJsonlMessages');
    const messages = await readClaudeSessionJsonlMessages({
      sessionFilePath,
      logLabel: 'TEST',
      maxBytes: line2.length + line3.length + 10,
    });

    expect(messages.map((m) => m.uuid)).toEqual(['u2', 'u3']);
    expect(vi.mocked(logger.debug).mock.calls.some(([message]) => typeof message === 'string' && message.includes('Error processing message'))).toBe(false);
  });
});
