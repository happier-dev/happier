import {
  appendFile,
  mkdir,
  mkdtemp,
  open,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  pageOhMyPiSessionTranscript,
  readAfterOhMyPiSessionTranscript,
} from './transcript.js';

const tempDirs = new Set<string>();

function jsonlLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

afterEach(async () => {
  await Promise.all([...tempDirs].map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
});

describe('readAfterOhMyPiSessionTranscript', () => {
  it('reads appended records after a byte cursor', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'happier-ohmypi-transcript-'));
    tempDirs.add(agentDir);
    const sessionRoot = join(agentDir, 'sessions', '-repo');
    await mkdir(sessionRoot, { recursive: true });
    const header = jsonlLine({
      type: 'session',
      id: 'session-1',
      timestamp: '2026-04-10T10:00:00.000Z',
      cwd: '/repo',
    });
    const existing = jsonlLine({
      type: 'message',
      id: 'old-user',
      parentId: null,
      timestamp: '2026-04-10T10:00:01.000Z',
      message: { role: 'user', content: 'old' },
    });
    const appended = jsonlLine({
      type: 'message',
      id: 'new-user',
      parentId: 'old-user',
      timestamp: '2026-04-10T10:00:02.000Z',
      message: { role: 'user', content: 'new' },
    });
    const transcriptPath = join(sessionRoot, '2026-04-10T10-00-00-000Z_session-1.jsonl');
    await writeFile(transcriptPath, `${header}${existing}`, 'utf8');
    const initial = await pageOhMyPiSessionTranscript({
      source: { kind: 'ohMyPiAgentDir', agentDir },
      env: {},
      providerSessionId: 'session-1',
      direction: 'older',
      maxBytes: 4096,
      maxItems: 10,
    });
    expect(initial.tailCursor).toEqual(expect.any(String));
    if (!initial.tailCursor) return;
    await appendFile(transcriptPath, appended, 'utf8');

    const result = await readAfterOhMyPiSessionTranscript({
      source: { kind: 'ohMyPiAgentDir', agentDir },
      env: {},
      providerSessionId: 'session-1',
      cursor: initial.tailCursor,
      maxBytes: 4096,
      maxItems: 10,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      raw: {
        role: 'user',
        content: { type: 'text', text: 'new' },
      },
    });
  });
});

describe('pageOhMyPiSessionTranscript', () => {
  it('bounds physical source reads for the initial page instead of loading the whole file', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'happier-ohmypi-bounded-initial-'));
    tempDirs.add(agentDir);
    const sessionRoot = join(agentDir, 'sessions', '-repo');
    await mkdir(sessionRoot, { recursive: true });
    const transcriptPath = join(sessionRoot, '2026-04-10T10-00-00-000Z_large-session.jsonl');
    const records = [
      {
        type: 'session',
        id: 'large-session',
        timestamp: '2026-04-10T10:00:00.000Z',
        cwd: '/repo',
      },
      {
        type: 'message',
        id: 'root',
        parentId: null,
        timestamp: '2026-04-10T10:00:01.000Z',
        message: { role: 'user', content: 'root' },
      },
      ...Array.from({ length: 4_000 }, (_, index) => ({
        type: 'unknown',
        payload: `${index}:${'x'.repeat(256)}`,
      })),
      {
        type: 'compaction',
        id: 'compact',
        parentId: 'root',
        timestamp: '2026-04-10T10:00:02.000Z',
        summary: 'current compacted context',
      },
      {
        type: 'message',
        id: 'leaf',
        parentId: 'compact',
        timestamp: '2026-04-10T10:00:03.000Z',
        message: { role: 'assistant', content: 'latest answer' },
      },
    ];
    const content = records.map(jsonlLine).join('');
    await writeFile(transcriptPath, content, 'utf8');

    let bytesRead = 0;
    const fileSystem = {
      async stat(path: string) {
        return await stat(path);
      },
      async read(path: string, position: number, length: number) {
        const handle = await open(path, 'r');
        try {
          const buffer = Buffer.alloc(length);
          const result = await handle.read(buffer, 0, length, position);
          bytesRead += result.bytesRead;
          return buffer.subarray(0, result.bytesRead);
        } finally {
          await handle.close();
        }
      },
    };

    const page = await pageOhMyPiSessionTranscript({
      source: { kind: 'ohMyPiAgentDir', agentDir },
      env: {},
      providerSessionId: 'large-session',
      direction: 'older',
      maxBytes: 4 * 1024,
      maxItems: 2,
      scannerFileSystem: fileSystem,
    });

    expect(Buffer.byteLength(content, 'utf8')).toBeGreaterThan(1024 * 1024);
    expect(bytesRead).toBeGreaterThan(0);
    expect(bytesRead).toBeLessThanOrEqual(4 * 1024);
    expect(page.items.map((item) => item.id)).toEqual([
      expect.stringContaining(':compact:compaction'),
      expect.stringContaining(':leaf:text:0'),
    ]);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toEqual(expect.any(String));
  });

  it('continues the active parent chain across bounded pages and ignores off-branch records', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'happier-ohmypi-bounded-tree-'));
    tempDirs.add(agentDir);
    const sessionRoot = join(agentDir, 'sessions', '-repo');
    await mkdir(sessionRoot, { recursive: true });
    const transcriptPath = join(sessionRoot, '2026-04-10T10-00-00-000Z_tree-session.jsonl');
    await writeFile(transcriptPath, [
      jsonlLine({ type: 'session', id: 'tree-session', timestamp: '2026-04-10T10:00:00.000Z' }),
      jsonlLine({
        type: 'message',
        id: 'root',
        parentId: null,
        timestamp: '2026-04-10T10:00:01.000Z',
        message: { role: 'user', content: 'root' },
      }),
      ...Array.from({ length: 20 }, (_, index) => jsonlLine({
        type: 'message',
        id: `abandoned-${index}`,
        parentId: index === 0 ? 'root' : `abandoned-${index - 1}`,
        timestamp: `2026-04-10T10:00:${String(index + 2).padStart(2, '0')}.000Z`,
        message: { role: 'user', content: `abandoned ${index}` },
      })),
      jsonlLine({
        type: 'branch_summary',
        id: 'summary',
        parentId: 'root',
        timestamp: '2026-04-10T10:01:00.000Z',
        summary: 'selected branch',
      }),
      jsonlLine({
        type: 'future_extension',
        id: 'unknown-chain-node',
        parentId: 'summary',
        timestamp: '2026-04-10T10:01:00.500Z',
        payload: { preservedForTreeTraversal: true },
      }),
      jsonlLine({
        type: 'compaction',
        id: 'compact',
        parentId: 'unknown-chain-node',
        timestamp: '2026-04-10T10:01:01.000Z',
        summary: 'compacted context',
      }),
      jsonlLine({
        type: 'message',
        id: 'leaf',
        parentId: 'compact',
        timestamp: '2026-04-10T10:01:02.000Z',
        message: { role: 'assistant', content: 'latest answer' },
      }),
    ].join(''), 'utf8');

    const pages: string[][] = [];
    let cursor: string | undefined;
    let tailCursor: string | null = null;
    for (let invocation = 0; invocation < 20; invocation += 1) {
      const page = await pageOhMyPiSessionTranscript({
        source: { kind: 'ohMyPiAgentDir', agentDir },
        env: {},
        providerSessionId: 'tree-session',
        direction: 'older',
        ...(cursor ? { cursor } : {}),
        maxBytes: 1024,
        maxItems: 1,
      });
      pages.push(page.items.map((item) => item.id));
      tailCursor = page.tailCursor ?? null;
      cursor = page.nextCursor ?? undefined;
      if (!page.hasMore) break;
    }

    expect(pages.flat()).toEqual([
      expect.stringContaining(':leaf:text:0'),
      expect.stringContaining(':compact:compaction'),
      expect.stringContaining(':summary:branch_summary'),
      expect.stringContaining(':root'),
    ]);
    expect(JSON.stringify(pages)).not.toContain('abandoned');
    expect(tailCursor).toEqual(expect.any(String));
    if (!tailCursor) return;
    await appendFile(transcriptPath, jsonlLine({
      type: 'message',
      id: 'continued',
      parentId: 'leaf',
      timestamp: '2026-04-10T10:01:03.000Z',
      message: { role: 'assistant', content: 'continued answer' },
    }), 'utf8');
    await expect(readAfterOhMyPiSessionTranscript({
      source: { kind: 'ohMyPiAgentDir', agentDir },
      env: {},
      providerSessionId: 'tree-session',
      cursor: tailCursor,
      maxBytes: 1024,
      maxItems: 1,
    })).resolves.toMatchObject({
      items: [expect.objectContaining({ id: expect.stringContaining(':continued:text:0') })],
    });
  });

  it('continues within a multi-item native record without exceeding the item budget', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'happier-ohmypi-bounded-record-'));
    tempDirs.add(agentDir);
    const sessionRoot = join(agentDir, 'sessions', '-repo');
    await mkdir(sessionRoot, { recursive: true });
    await writeFile(
      join(sessionRoot, '2026-04-10T10-00-00-000Z_multi-item.jsonl'),
      [
        jsonlLine({ type: 'session', id: 'multi-item' }),
        jsonlLine({
          type: 'message',
          id: 'root',
          parentId: null,
          message: { role: 'user', content: 'root' },
        }),
        jsonlLine({
          type: 'message',
          id: 'assistant',
          parentId: 'root',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'first' },
              { type: 'text', text: 'second' },
              { type: 'text', text: 'third' },
            ],
          },
        }),
      ].join(''),
      'utf8',
    );

    const ids: string[] = [];
    let cursor: string | undefined;
    for (let invocation = 0; invocation < 5; invocation += 1) {
      const page = await pageOhMyPiSessionTranscript({
        source: { kind: 'ohMyPiAgentDir', agentDir },
        env: {},
        providerSessionId: 'multi-item',
        direction: 'older',
        ...(cursor ? { cursor } : {}),
        maxBytes: 1024,
        maxItems: 1,
      });
      expect(page.items.length).toBeLessThanOrEqual(1);
      ids.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor ?? undefined;
      if (!page.hasMore) break;
    }

    expect(ids).toEqual([
      expect.stringContaining(':assistant:text:2'),
      expect.stringContaining(':assistant:text:1'),
      expect.stringContaining(':assistant:text:0'),
      expect.stringContaining(':root'),
    ]);
  });

  it('fails an orphaned branch at physical source start instead of publishing its reachable suffix', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'happier-ohmypi-orphan-branch-'));
    tempDirs.add(agentDir);
    const sessionRoot = join(agentDir, 'sessions', '-repo');
    await mkdir(sessionRoot, { recursive: true });
    const transcriptPath = join(sessionRoot, '2026-04-10T10-00-00-000Z_orphan-session.jsonl');
    await writeFile(transcriptPath, [
      jsonlLine({ type: 'session', id: 'orphan-session', timestamp: '2026-04-10T10:00:00.000Z' }),
      // The oldest surviving entry names a parent no byte of this file carries.
      ...Array.from({ length: 3 }, (_, index) => jsonlLine({
        type: 'message',
        id: `orphan-${index}`,
        parentId: index === 0 ? 'orphan-missing-root' : `orphan-${index - 1}`,
        timestamp: `2026-04-10T10:00:0${index + 1}.000Z`,
        message: { role: 'user', content: `prompt ${index}` },
      })),
    ].join(''), 'utf8');

    const page = (cursor?: string) => pageOhMyPiSessionTranscript({
      source: { kind: 'ohMyPiAgentDir', agentDir },
      env: {},
      providerSessionId: 'orphan-session',
      direction: 'older' as const,
      ...(cursor ? { cursor } : {}),
      maxBytes: 4096,
      maxItems: 1,
    });

    // While older bytes remain, an unresolved parent is the ordinary paging
    // handoff and must keep the continuation alive.
    const first = await page();
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).not.toBeNull();

    // At physical source start the parent is still absent, so the reachable
    // suffix is not the whole branch and must not be published as complete.
    let cursor = first.nextCursor ?? undefined;
    let failure: unknown = null;
    for (let invocation = 0; invocation < 8 && cursor; invocation += 1) {
      try {
        const next = await page(cursor);
        cursor = next.nextCursor ?? undefined;
      } catch (error) {
        failure = error;
        break;
      }
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).name).toBe('OhMyPiExternalSessionIncompleteBranchError');
  });

  it('fails a whole-file orphaned branch instead of reporting ordinary completion', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'happier-ohmypi-orphan-whole-'));
    tempDirs.add(agentDir);
    const sessionRoot = join(agentDir, 'sessions', '-repo');
    await mkdir(sessionRoot, { recursive: true });
    const transcriptPath = join(sessionRoot, '2026-04-10T10-00-00-000Z_orphan-whole.jsonl');
    await writeFile(transcriptPath, [
      jsonlLine({ type: 'session', id: 'orphan-whole', timestamp: '2026-04-10T10:00:00.000Z' }),
      jsonlLine({
        type: 'message',
        id: 'orphan-whole-leaf',
        parentId: 'orphan-whole-missing',
        timestamp: '2026-04-10T10:00:01.000Z',
        message: { role: 'user', content: 'only surviving prompt' },
      }),
    ].join(''), 'utf8');

    await expect(pageOhMyPiSessionTranscript({
      source: { kind: 'ohMyPiAgentDir', agentDir },
      env: {},
      providerSessionId: 'orphan-whole',
      direction: 'older',
      maxBytes: 4096,
      maxItems: 50,
    })).rejects.toMatchObject({ name: 'OhMyPiExternalSessionIncompleteBranchError' });
  });

  it('rejects a page cursor after atomic source replacement', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'happier-ohmypi-page-replacement-'));
    tempDirs.add(agentDir);
    const sessionRoot = join(agentDir, 'sessions', '-repo');
    await mkdir(sessionRoot, { recursive: true });
    const transcriptPath = join(sessionRoot, '2026-04-10T10-00-00-000Z_replaced-session.jsonl');
    await writeFile(transcriptPath, [
      jsonlLine({ type: 'session', id: 'replaced-session' }),
      jsonlLine({
        type: 'message',
        id: 'root',
        parentId: null,
        message: { role: 'user', content: 'root' },
      }),
      jsonlLine({
        type: 'message',
        id: 'leaf',
        parentId: 'root',
        message: { role: 'assistant', content: 'leaf' },
      }),
    ].join(''), 'utf8');
    const first = await pageOhMyPiSessionTranscript({
      source: { kind: 'ohMyPiAgentDir', agentDir },
      env: {},
      providerSessionId: 'replaced-session',
      direction: 'older',
      maxBytes: 1024,
      maxItems: 1,
    });
    expect(first.nextCursor).toEqual(expect.any(String));
    if (!first.nextCursor) return;

    await appendFile(transcriptPath, jsonlLine({
      type: 'message',
      id: 'new-branch',
      parentId: 'root',
      message: { role: 'assistant', content: 'branch switch' },
    }), 'utf8');
    await expect(pageOhMyPiSessionTranscript({
      source: { kind: 'ohMyPiAgentDir', agentDir },
      env: {},
      providerSessionId: 'replaced-session',
      direction: 'older',
      cursor: first.nextCursor,
      maxBytes: 1024,
      maxItems: 1,
    })).rejects.toMatchObject({ name: 'OhMyPiExternalSessionSourceChangedError' });

    const replacementPath = `${transcriptPath}.replacement`;
    await writeFile(replacementPath, [
      jsonlLine({ type: 'session', id: 'replaced-session' }),
      jsonlLine({
        type: 'message',
        id: 'replacement',
        parentId: null,
        message: { role: 'user', content: 'replacement' },
      }),
    ].join(''), 'utf8');
    await rename(replacementPath, transcriptPath);

    await expect(pageOhMyPiSessionTranscript({
      source: { kind: 'ohMyPiAgentDir', agentDir },
      env: {},
      providerSessionId: 'replaced-session',
      direction: 'older',
      cursor: first.nextCursor,
      maxBytes: 1024,
      maxItems: 1,
    })).rejects.toMatchObject({ name: 'OhMyPiExternalSessionSourceChangedError' });
  });
});
