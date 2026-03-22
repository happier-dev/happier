import { appendFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readAfterClaudeTranscript } from './readAfterClaudeTranscript';

function jsonlLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

describe('readAfterClaudeTranscript', () => {
  it('supports tail cursors and waits for full lines before parsing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-direct-after-'));
    const configDir = join(root, '.claude');
    const sessionFile = join(configDir, 'projects', 'proj-a', 'sess-1.jsonl');
    await mkdir(join(configDir, 'projects', 'proj-a'), { recursive: true });

    await writeFile(sessionFile, jsonlLine({ type: 'user', uuid: 'u1', message: { content: 'hello' } }), 'utf8');

    const tail = await readAfterClaudeTranscript({
      source: { kind: 'claudeConfig', configDir, projectId: 'proj-a' },
      env: {} as NodeJS.ProcessEnv,
      remoteSessionId: 'sess-1',
      cursor: 'tail',
      maxBytes: 1024 * 1024,
      maxItems: 100,
    });

    expect(tail.items).toHaveLength(0);
    expect(tail.nextCursor).toBeTruthy();
    expect(tail.truncated).toBe(false);

    const fullLine = JSON.stringify({ type: 'assistant', uuid: 'a2', message: { model: 'm', content: [{ type: 'text', text: 'ok' }] } });
    await appendFile(sessionFile, fullLine.slice(0, -1), 'utf8'); // partial JSON, no newline

    const afterPartial = await readAfterClaudeTranscript({
      source: { kind: 'claudeConfig', configDir, projectId: 'proj-a' },
      env: {} as NodeJS.ProcessEnv,
      remoteSessionId: 'sess-1',
      cursor: tail.nextCursor ?? 'tail',
      maxBytes: 1024 * 1024,
      maxItems: 100,
    });

    expect(afterPartial.items).toHaveLength(0);
    expect(afterPartial.truncated).toBe(false);
    expect(afterPartial.nextCursor).toBeTruthy();

    await appendFile(sessionFile, `${fullLine.slice(-1)}\n`, 'utf8');

    const afterFull = await readAfterClaudeTranscript({
      source: { kind: 'claudeConfig', configDir, projectId: 'proj-a' },
      env: {} as NodeJS.ProcessEnv,
      remoteSessionId: 'sess-1',
      cursor: afterPartial.nextCursor ?? 'tail',
      maxBytes: 1024 * 1024,
      maxItems: 100,
    });

    expect(afterFull.items).toHaveLength(1);
    expect((afterFull.items[0]?.raw as any)?.role).toBe('agent');
    expect((((afterFull.items[0]?.raw as any)?.content as any)?.data as any)?.message?.role).toBe('assistant');
    expect(afterFull.nextCursor).toBeTruthy();
    expect(afterFull.truncated).toBe(false);
  });

  it('returns truncated=true for invalid cursors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-direct-after-bad-'));
    const configDir = join(root, '.claude');
    const sessionFile = join(configDir, 'projects', 'proj-a', 'sess-1.jsonl');
    await mkdir(join(configDir, 'projects', 'proj-a'), { recursive: true });
    await writeFile(sessionFile, jsonlLine({ type: 'user', uuid: 'u1', message: { content: 'hello' } }), 'utf8');

    const res = await readAfterClaudeTranscript({
      source: { kind: 'claudeConfig', configDir, projectId: 'proj-a' },
      env: {} as NodeJS.ProcessEnv,
      remoteSessionId: 'sess-1',
      cursor: 'not-a-valid-cursor',
      maxBytes: 1024 * 1024,
      maxItems: 100,
    });

    expect(res.items).toHaveLength(0);
    expect(res.truncated).toBe(true);
  });
});
