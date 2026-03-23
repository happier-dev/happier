import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { pageClaudeTranscript } from './pageClaudeTranscript';
import { readAfterClaudeTranscript } from './readAfterClaudeTranscript';

function jsonlLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

describe('pageClaudeTranscript', () => {
  it('pages a Claude session JSONL file from newest backwards', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-direct-page-'));
    const configDir = join(root, '.claude');
    const sessionFile = join(configDir, 'projects', 'proj-a', 'sess-1.jsonl');
    await mkdir(join(configDir, 'projects', 'proj-a'), { recursive: true });

    await writeFile(
      sessionFile,
      [
        jsonlLine({ type: 'user', uuid: 'u1', message: { content: 'hello' } }),
        jsonlLine({ type: 'assistant', uuid: 'a1', message: { model: 'm', content: [{ type: 'text', text: 'hi' }] } }),
        // Internal event should be ignored.
        jsonlLine({ type: 'change', uuid: 'c1', payload: { foo: 'bar' } }),
        jsonlLine({ type: 'user', uuid: 'u2', message: { content: 'next' } }),
        jsonlLine({ type: 'assistant', uuid: 'a2', message: { model: 'm', content: [{ type: 'text', text: 'ok' }] } }),
      ].join(''),
      'utf8',
    );

    const first = await pageClaudeTranscript({
      source: { kind: 'claudeConfig', configDir, projectId: 'proj-a' },
      env: {} as NodeJS.ProcessEnv,
      remoteSessionId: 'sess-1',
      direction: 'older',
      maxBytes: 1024 * 1024,
      maxItems: 2,
    });

    expect(first.items).toHaveLength(2);
    expect((first.items[0]?.raw as any)?.role).toBe('user');
    expect(((first.items[0]?.raw as any)?.content as any)?.text).toBe('next');
    expect((first.items[1]?.raw as any)?.role).toBe('agent');
    expect((((first.items[1]?.raw as any)?.content as any)?.data as any)?.message?.role).toBe('assistant');
    expect(first.nextCursor).toBeTruthy();
    expect(first.tailCursor).toBeTruthy();
    expect(first.hasMore).toBe(true);

    const second = await pageClaudeTranscript({
      source: { kind: 'claudeConfig', configDir, projectId: 'proj-a' },
      env: {} as NodeJS.ProcessEnv,
      remoteSessionId: 'sess-1',
      direction: 'older',
      cursor: first.nextCursor ?? undefined,
      maxBytes: 1024 * 1024,
      maxItems: 10,
    });

    expect(second.items.map((m) => (m.raw as any)?.role)).toEqual(['user', 'agent']);
    expect(((second.items[0]?.raw as any)?.content as any)?.text).toBe('hello');
    expect((((second.items[1]?.raw as any)?.content as any)?.data as any)?.message?.role).toBe('assistant');
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();

    await writeFile(
      sessionFile,
      [
        jsonlLine({ type: 'user', uuid: 'u1', message: { content: 'hello' } }),
        jsonlLine({ type: 'assistant', uuid: 'a1', message: { model: 'm', content: [{ type: 'text', text: 'hi' }] } }),
        jsonlLine({ type: 'change', uuid: 'c1', payload: { foo: 'bar' } }),
        jsonlLine({ type: 'user', uuid: 'u2', message: { content: 'next' } }),
        jsonlLine({ type: 'assistant', uuid: 'a2', message: { model: 'm', content: [{ type: 'text', text: 'ok' }] } }),
        jsonlLine({ type: 'user', uuid: 'u3', message: { content: 'follow after initial page' } }),
      ].join(''),
      'utf8',
    );

    const followed = await readAfterClaudeTranscript({
      source: { kind: 'claudeConfig', configDir, projectId: 'proj-a' },
      env: {} as NodeJS.ProcessEnv,
      remoteSessionId: 'sess-1',
      cursor: first.tailCursor ?? 'tail',
      maxBytes: 1024 * 1024,
      maxItems: 10,
    });

    expect(followed.items.map((item) => ((item.raw as any)?.content as any)?.text).filter(Boolean)).toEqual([
      'follow after initial page',
    ]);
  });
});
