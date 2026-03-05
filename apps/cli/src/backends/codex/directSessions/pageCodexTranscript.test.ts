import { mkdir, mkdtemp, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { pageCodexTranscript } from './pageCodexTranscript';
import { readJsonlFileBackwardPage } from '@/backends/directSessions/filePaging/jsonlBackwardPager';

function sessionMetaLine(payload: Record<string, unknown>): string {
  return `${JSON.stringify({ type: 'session_meta', payload })}\n`;
}

function responseItemLine(params: { timestamp: string; payload: Record<string, unknown> }): string {
  return `${JSON.stringify({ type: 'response_item', timestamp: params.timestamp, payload: params.payload })}\n`;
}

describe('pageCodexTranscript', () => {
  it('pages newest-first (direction=older) from a rollout jsonl transcript', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-page-'));
    const codexHome = join(root, 'codex-home');
    const sessionsDir = join(codexHome, 'sessions');
    await mkdir(sessionsDir, { recursive: true });

    const sessionId = '11111111-1111-1111-1111-111111111111';
    const filePath = join(sessionsDir, `rollout-2026-01-02T00-00-00-${sessionId}.jsonl`);

    await writeFile(
      filePath,
      sessionMetaLine({ id: sessionId, timestamp: '2026-01-02T00:00:00.000Z', cwd: '/repo/one' })
        + responseItemLine({
          timestamp: '2026-01-02T00:00:01.000Z',
          payload: { type: 'message', role: 'user', content: [{ type: 'text', text: 'hi' }] },
        })
        + responseItemLine({
          timestamp: '2026-01-02T00:00:02.000Z',
          payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
        })
        + responseItemLine({
          timestamp: '2026-01-02T00:00:03.000Z',
          payload: { type: 'function_call', call_id: 'call1', name: 'read_file', arguments: JSON.stringify({ path: 'README.md' }) },
        })
        + responseItemLine({
          timestamp: '2026-01-02T00:00:04.000Z',
          payload: { type: 'function_call_output', call_id: 'call1', output: JSON.stringify({ ok: true }) },
        }),
      'utf8',
    );
    await utimes(filePath, new Date('2026-01-02T00:00:04.000Z'), new Date('2026-01-02T00:00:04.000Z'));

    const rawPage = await readJsonlFileBackwardPage({
      filePath,
      endOffsetBytes: null,
      maxBytes: 1024 * 1024,
      maxItems: 2,
    });
    expect(rawPage.items.map((item) => (item.value as any)?.payload?.type)).toEqual([
      'function_call',
      'function_call_output',
    ]);

    const first = await pageCodexTranscript({
      source: { kind: 'codexHome', home: 'user' },
      env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      activeServerDir: join(root, 'servers', 'cloud'),
      remoteSessionId: sessionId,
      direction: 'older',
      maxBytes: 1024 * 1024,
      maxItems: 2,
    });

    expect(first.items).toHaveLength(2);
    const firstTypes = first.items.map((item) => {
      const raw: any = item.raw;
      if (raw?.role !== 'agent') return raw?.content?.type;
      return raw?.content?.data?.type;
    });
    expect(firstTypes).toEqual(['tool-call', 'tool-call-result']);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBeTruthy();

    const second = await pageCodexTranscript({
      source: { kind: 'codexHome', home: 'user' },
      env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      activeServerDir: join(root, 'servers', 'cloud'),
      remoteSessionId: sessionId,
      direction: 'older',
      cursor: first.nextCursor ?? undefined,
      maxBytes: 1024 * 1024,
      maxItems: 10,
    });

    expect(second.items.map((m) => m.raw.role)).toEqual(['user', 'agent']);
    const secondTypes = second.items.map((item) => {
      const raw: any = item.raw;
      if (raw?.role !== 'agent') return raw?.content?.type;
      return raw?.content?.data?.type;
    });
    expect(secondTypes).toEqual(['text', 'message']);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();
  });
});
