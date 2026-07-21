import { afterEach, describe, expect, it, vi } from 'vitest';

import { logger } from '@/ui/logger';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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
  });

  it('bounds parsing to the file tail when maxBytes is provided', async () => {
    (logger.debug as any).mockClear();
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

  it('drops the first partial line from a truncated tail without logging a parse error', async () => {
    (logger.debug as any).mockClear();
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
      maxBytes: Math.floor(line1.length / 2) + line2.length + line3.length + 2,
    });

    expect(messages.map((m) => m.uuid)).toEqual(['u2', 'u3']);
    expect((logger.debug as any).mock.calls.some((call: unknown[]) => String(call[0]).includes('Error processing message'))).toBe(false);
  });

  it('drops Claude-internal state records that are not conversation content', async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'happier-claude-jsonl-'));
    const sessionFilePath = join(tmpRoot, 'sess.jsonl');

    const lines = [
      JSON.stringify({ type: 'last-prompt', lastPrompt: 'hi', leafUuid: 'leaf-1', sessionId: 's1' }),
      JSON.stringify({ type: 'mode', mode: 'default', sessionId: 's1' }),
      JSON.stringify({ type: 'pr-link', url: 'https://example.test/pr/1', sessionId: 's1' }),
      JSON.stringify({
        type: 'attachment',
        uuid: 'a1',
        sessionId: 's1',
        attachment: { type: 'hook_success', hookEvent: 'SessionStart' },
      }),
      JSON.stringify({ type: 'assistant', uuid: 'u1', message: {} }),
    ];

    await writeFile(sessionFilePath, `${lines.join('\n')}\n`, 'utf8');

    const { readClaudeSessionJsonlMessages } = await import('./readClaudeSessionJsonlMessages');
    const messages = await readClaudeSessionJsonlMessages({ sessionFilePath, logLabel: 'TEST' });

    expect(messages.map((m) => m.type)).toEqual(['assistant']);
  });
});
