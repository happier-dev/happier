import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createOhMyPiJsonlSessionStore } from './createOhMyPiJsonlSessionStore';

function jsonlLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

const tempDirs = new Set<string>();

function rememberTempDir(path: string): string {
  tempDirs.add(path);
  return path;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe('createOhMyPiJsonlSessionStore', () => {
  it('resolves the visible title and transcript through the shared store contract', async () => {
    const agentDir = rememberTempDir(await mkdtemp(join(tmpdir(), 'happier-oh-my-pi-store-title-')));
    const sessionRoot = join(agentDir, 'sessions', '-repo');
    await mkdir(sessionRoot, { recursive: true });

    const filePath = join(sessionRoot, '2026-04-10T10-00-00-000Z_session-one.jsonl');
    await writeFile(
      filePath,
      [
        jsonlLine({
          type: 'session',
          id: 'session-one',
          timestamp: '2026-04-10T10:00:00.000Z',
          cwd: '/repo',
          title: 'Shared store OMP title',
        }),
        jsonlLine({
          type: 'message',
          id: 'user-1',
          parentId: null,
          timestamp: '2026-04-10T10:00:01.000Z',
          message: { role: 'user', content: 'hello' },
        }),
        jsonlLine({
          type: 'message',
          id: 'assistant-1',
          parentId: 'user-1',
          timestamp: '2026-04-10T10:00:02.000Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'world' }] },
        }),
      ].join(''),
      'utf8',
    );

    const store = createOhMyPiJsonlSessionStore({
      providerId: 'ohMyPi',
      source: { kind: 'ohMyPiAgentDir', agentDir },
      remoteSessionId: 'session-one',
    });

    await expect(store.getTitle()).resolves.toBe('Shared store OMP title');
    await expect(store.getWorkingDirectory()).resolves.toBe('/repo');

    const page = await store.pageOlder({ maxBytes: 1024 * 1024, maxItems: 10 });
    expect(page.items).toHaveLength(2);
    expect(JSON.stringify(page.items)).toContain('hello');
    expect(JSON.stringify(page.items)).toContain('world');
    expect(page.tailCursor).toBe('idx:2');
  });

  it('subscribes to appended transcript items via the shared read-after path', async () => {
    const agentDir = rememberTempDir(await mkdtemp(join(tmpdir(), 'happier-oh-my-pi-store-subscribe-')));
    const sessionRoot = join(agentDir, 'sessions', '-repo');
    await mkdir(sessionRoot, { recursive: true });

    const filePath = join(sessionRoot, '2026-04-10T10-00-00-000Z_session-two.jsonl');
    await writeFile(
      filePath,
      [
        jsonlLine({
          type: 'session',
          id: 'session-two',
          timestamp: '2026-04-10T10:00:00.000Z',
          cwd: '/repo',
          title: 'OMP follow',
        }),
        jsonlLine({
          type: 'message',
          id: 'assistant-1',
          parentId: null,
          timestamp: '2026-04-10T10:00:01.000Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'initial message' }] },
        }),
      ].join(''),
      'utf8',
    );

    const store = createOhMyPiJsonlSessionStore({
      providerId: 'ohMyPi',
      source: { kind: 'ohMyPiAgentDir', agentDir },
      remoteSessionId: 'session-two',
    });

    const page = await store.pageOlder({ maxBytes: 1024 * 1024, maxItems: 10 });
    expect(page.tailCursor).toBeTruthy();

    const events: Array<{ items: readonly unknown[]; nextCursor: string | null; truncated: boolean }> = [];
    const unsubscribe = store.subscribe((event) => {
      events.push(event);
    });

    await appendFile(
      filePath,
      jsonlLine({
        type: 'message',
        id: 'assistant-2',
        parentId: 'assistant-1',
        timestamp: '2026-04-10T10:00:02.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'follow-up message' }] },
      }),
      'utf8',
    );

    const deadline = Date.now() + 5_000;
    while (events.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    unsubscribe();

    expect(events).toHaveLength(1);
    expect(events[0]?.items).toHaveLength(1);
    expect(JSON.stringify(events[0]?.items[0] ?? null)).toContain('follow-up message');
    expect(events[0]?.nextCursor).toBe('idx:2');
    expect(events[0]?.truncated).toBe(false);
  });

  it('ignores an incomplete trailing jsonl line while paging the transcript', async () => {
    const agentDir = rememberTempDir(await mkdtemp(join(tmpdir(), 'happier-oh-my-pi-store-partial-line-')));
    const sessionRoot = join(agentDir, 'sessions', '-repo');
    await mkdir(sessionRoot, { recursive: true });

    const filePath = join(sessionRoot, '2026-04-10T10-00-00-000Z_session-three.jsonl');
    await writeFile(
      filePath,
      [
        jsonlLine({
          type: 'session',
          id: 'session-three',
          timestamp: '2026-04-10T10:00:00.000Z',
          cwd: '/repo',
          title: 'OMP partial line',
        }),
        jsonlLine({
          type: 'message',
          id: 'assistant-1',
          parentId: null,
          timestamp: '2026-04-10T10:00:01.000Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'stable message' }] },
        }),
        '{"type":"message","id":"partial',
      ].join(''),
      'utf8',
    );

    const store = createOhMyPiJsonlSessionStore({
      providerId: 'ohMyPi',
      source: { kind: 'ohMyPiAgentDir', agentDir },
      remoteSessionId: 'session-three',
    });

    const page = await store.pageOlder({ maxBytes: 1024 * 1024, maxItems: 10 });
    expect(page.items).toHaveLength(1);
    expect(JSON.stringify(page.items[0] ?? null)).toContain('stable message');
    expect(page.tailCursor).toBe('idx:1');
  });
});
