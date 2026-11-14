import {
  appendFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HAPPIER_BASE_SYSTEM_PROMPT_OPTIONS_V1,
  HAPPIER_BASE_SYSTEM_PROMPT_SESSION_TITLE_INITIAL_V1,
} from '@happier-dev/plugin-sdk/sessions/external';

import {
  formatOhMyPiCandidateTitle,
  listOhMyPiSessionCandidates,
  OhMyPiCandidateSourceChangedError,
} from './candidates.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: vi.fn(actual.open),
    readFile: vi.fn(async () => {
      throw new Error('full-file read is forbidden during candidate discovery');
    }),
  };
});

const tempDirs = new Set<string>();

function jsonlLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

afterEach(async () => {
  vi.mocked(open).mockClear();
  vi.mocked(readFile).mockClear();
  vi.restoreAllMocks();
  await Promise.all([...tempDirs].map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
});

describe('listOhMyPiSessionCandidates', () => {
  it('serves Browse newest-activity-first and reads titles only for the served rows', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'happier-ohmypi-activity-candidates-'));
    tempDirs.add(agentDir);
    const sessionRoot = join(agentDir, 'sessions', '-repo');
    await mkdir(sessionRoot, { recursive: true });
    const count = 120;
    const base = Date.UTC(2026, 6, 23);
    for (let index = 0; index < count; index += 1) {
      // Created in index order; the first created was active most recently.
      const remoteSessionId = `session-${String(index).padStart(3, '0')}`;
      const createdAt = new Date(base + index * 1_000).toISOString();
      const lastAt = new Date(base + 10_000_000 + (count - index) * 60_000).toISOString();
      await writeFile(
        join(sessionRoot, `${createdAt.replaceAll(':', '-').replace('.', '-')}_${remoteSessionId}.jsonl`),
        jsonlLine({ type: 'session', version: 3, id: remoteSessionId, timestamp: createdAt, cwd: '/repo' })
          + jsonlLine({ type: 'message', id: `${remoteSessionId}-user`, parentId: null, timestamp: lastAt,
            message: { role: 'user', content: `prompt ${index}` } }),
        'utf8',
      );
    }
    vi.mocked(open).mockClear();
    const first = await listOhMyPiSessionCandidates({ source: { kind: 'ohMyPiAgentDir', agentDir }, env: {}, limit: 10 });
    const firstOpens = vi.mocked(open).mock.calls.length;
    expect({
      ids: first.candidates.map((candidate) => candidate.remoteSessionId),
      titles: first.candidates.map((candidate) => candidate.title),
      preparation: (first as { preparation?: unknown }).preparation,
    }).toEqual({
      ids: Array.from({ length: 10 }, (_, index) => `session-${String(index).padStart(3, '0')}`),
      titles: Array.from({ length: 10 }, (_, index) => `prompt ${index}`),
      preparation: undefined,
    });
    // One tail read per file for its activity time; head and tail scans only
    // for the 10 served rows.
    expect(firstOpens).toBe(count + 2 * 10);
    if (!first.nextCursor) throw new Error('expected a Browse continuation');
    const second = await listOhMyPiSessionCandidates({
      source: { kind: 'ohMyPiAgentDir', agentDir }, env: {}, limit: 10, cursor: first.nextCursor,
    });
    expect(second.candidates.map((candidate) => candidate.remoteSessionId))
      .toEqual(Array.from({ length: 10 }, (_, index) => `session-${String(index + 10).padStart(3, '0')}`));
    expect(second.candidates[0]?.updatedAtMs).toBe(base + 10_000_000 + (count - 10) * 60_000);
  });

  it('continues after the served row when a session becomes newer between pages', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'happier-ohmypi-activity-moved-'));
    tempDirs.add(agentDir);
    const sessionRoot = join(agentDir, 'sessions', '-repo');
    await mkdir(sessionRoot, { recursive: true });
    const paths = await Promise.all(Array.from({ length: 4 }, async (_, index) => {
      const remoteSessionId = `session-${index}`;
      const path = join(sessionRoot, `2026-07-23T10-00-0${index}-000Z_${remoteSessionId}.jsonl`);
      await writeFile(path, jsonlLine({
        type: 'session', version: 3, id: remoteSessionId, timestamp: `2026-07-23T10:00:0${index}.000Z`, cwd: '/repo',
      }), 'utf8');
      return path;
    }));
    const first = await listOhMyPiSessionCandidates({ source: { kind: 'ohMyPiAgentDir', agentDir }, env: {}, limit: 2 });
    expect(first.candidates.map((candidate) => candidate.remoteSessionId)).toEqual(['session-3', 'session-2']);
    if (!first.nextCursor) throw new Error('expected a Browse continuation');
    await appendFile(paths[0]!, jsonlLine({ type: 'session_info', name: 'later', timestamp: '2026-07-23T11:00:00.000Z' }), 'utf8');
    const second = await listOhMyPiSessionCandidates({
      source: { kind: 'ohMyPiAgentDir', agentDir }, env: {}, limit: 2, cursor: first.nextCursor,
    });
    // session-0 moved above the continuation: the next listing from the top shows it first.
    expect(second).toMatchObject({ candidates: [expect.objectContaining({ remoteSessionId: 'session-1' })], nextCursor: null });
    const refreshed = await listOhMyPiSessionCandidates({ source: { kind: 'ohMyPiAgentDir', agentDir }, env: {}, limit: 1 });
    expect(refreshed.candidates.map((candidate) => candidate.remoteSessionId)).toEqual(['session-0']);
  });

  it('stops Browse when the signal is cancelled', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'happier-ohmypi-cancel-candidates-'));
    tempDirs.add(agentDir);
    const sessionRoot = join(agentDir, 'sessions', '-repo');
    await mkdir(sessionRoot, { recursive: true });
    await Promise.all(Array.from({ length: 100 }, async (_, index) => {
      const remoteSessionId = `cancel-${index}`;
      await writeFile(
        join(sessionRoot, `2026-07-23T10-00-00-000Z_${remoteSessionId}.jsonl`),
        jsonlLine({ type: 'session', id: remoteSessionId, timestamp: '2026-07-23T10:00:00.000Z' }),
        'utf8',
      );
    }));
    vi.mocked(open).mockClear();
    const controller = new AbortController();
    const listing = listOhMyPiSessionCandidates({
      source: { kind: 'ohMyPiAgentDir', agentDir },
      env: {},
      limit: 50,
      signal: controller.signal,
    });
    queueMicrotask(() => controller.abort());

    await expect(listing).rejects.toMatchObject({ name: 'AbortError' });
    expect(vi.mocked(open).mock.calls.length).toBeLessThan(100 * 2);
  });

  it('discovers current v3 files whose session header follows the fixed-width title slot', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-07-24T00:00:00.000Z'));
    const agentDir = await mkdtemp(join(tmpdir(), 'happier-ohmypi-current-candidates-'));
    tempDirs.add(agentDir);
    const sessionRoot = join(agentDir, 'sessions', '-repo');
    await mkdir(sessionRoot, { recursive: true });
    await writeFile(join(sessionRoot, '2026-07-21T10-00-00-000Z_session-current.jsonl'), [
      jsonlLine({
        type: 'title',
        v: 1,
        title: 'Current slot title',
        updatedAt: '2026-07-21T10:00:05.000Z',
        pad: ' ',
      }),
      jsonlLine({
        type: 'session',
        version: 3,
        id: 'session-current',
        timestamp: '2026-07-21T10:00:00.000Z',
        cwd: '/repo',
        title: 'Stale header title',
      }),
      jsonlLine({
        type: 'message',
        id: 'user-1',
        parentId: null,
        timestamp: '2026-07-21T10:00:01.000Z',
        message: { role: 'user', content: 'hello' },
      }),
    ].join(''), 'utf8');

    const result = await listOhMyPiSessionCandidates({
      source: { kind: 'ohMyPiAgentDir', agentDir },
      env: {},
      limit: 10,
    });

    expect(result.candidates).toEqual([
      expect.objectContaining({
        remoteSessionId: 'session-current',
        title: 'Current slot title',
        createdAtMs: Date.parse('2026-07-21T10:00:00.000Z'),
        activity: 'idle',
      }),
    ]);
  });

  it('discovers candidates with bounded scanner reads and header-authoritative ids', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'happier-ohmypi-candidates-'));
    tempDirs.add(agentDir);
    const sessionRoot = join(agentDir, 'sessions', '-repo');
    await mkdir(sessionRoot, { recursive: true });
    const filePath = join(sessionRoot, 'a_b_c.jsonl');
    await writeFile(filePath, [
      jsonlLine({
        type: 'session',
        id: 'c',
        timestamp: '2026-04-10T10:00:00.000Z',
        cwd: '/repo',
        title: 'Header title',
      }),
      jsonlLine({
        type: 'message',
        id: 'user-1',
        timestamp: '2026-04-10T10:00:01.000Z',
        message: { role: 'user', content: 'hello' },
      }),
      jsonlLine({
        type: 'session_info',
        name: 'Tail title',
        timestamp: '2026-04-10T10:00:02.000Z',
      }),
    ].join(''), 'utf8');
    const canonicalAgentDir = await realpath(agentDir);

    const result = await listOhMyPiSessionCandidates({
      source: { kind: 'ohMyPiAgentDir', agentDir },
      env: {},
      limit: 10,
    });

    expect(vi.mocked(readFile)).not.toHaveBeenCalled();
    expect(result.candidates).toEqual([
      expect.objectContaining({
        remoteSessionId: 'c',
        title: 'Tail title',
        createdAtMs: Date.parse('2026-04-10T10:00:00.000Z'),
        details: expect.objectContaining({
          workingDirectory: '/repo',
          agentDir: canonicalAgentDir,
        }),
      }),
    ]);
    expect(result.candidates[0]?.remoteSessionId).not.toBe('b_c');
  });

  it('derives a title from the first user message and suppresses the injected base system prompt', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'happier-ohmypi-derived-titles-'));
    tempDirs.add(agentDir);
    const sessionRoot = join(agentDir, 'sessions', '-repo');
    await mkdir(sessionRoot, { recursive: true });

    const write = async (
      remoteSessionId: string,
      firstUserText: string | null,
    ): Promise<void> => {
      await writeFile(
        join(sessionRoot, `2026-07-23T10-00-00-000Z_${remoteSessionId}.jsonl`),
        [
          jsonlLine({
            type: 'session',
            version: 3,
            id: remoteSessionId,
            timestamp: '2026-07-23T10:00:00.000Z',
            cwd: '/repo',
          }),
          ...(firstUserText === null ? [] : [jsonlLine({
            type: 'message',
            id: `${remoteSessionId}-user`,
            parentId: null,
            timestamp: '2026-07-23T10:00:01.000Z',
            message: { role: 'user', content: [{ type: 'text', text: firstUserText }] },
          })]),
        ].join(''),
        'utf8',
      );
    };

    await write('153e1829e9d3e497', 'Investigate the failing external-session link');
    await write(
      '153e1829e9d3e498',
      `${HAPPIER_BASE_SYSTEM_PROMPT_SESSION_TITLE_INITIAL_V1}\n\nreal prompt`,
    );
    await write(
      '153e1829e9d3e499',
      `${HAPPIER_BASE_SYSTEM_PROMPT_OPTIONS_V1}\n\nreal prompt`,
    );
    // A model_change-only session, exactly what Oh My Pi writes before the first turn.
    await write('153e1829e9d3e500', null);

    const result = await listOhMyPiSessionCandidates({
      source: { kind: 'ohMyPiAgentDir', agentDir },
      env: {},
      limit: 10,
    });

    // The bounded scan is the only read; no candidate opens the session file again.
    expect(vi.mocked(readFile)).not.toHaveBeenCalled();
    expect(Object.fromEntries(result.candidates.map(
      (candidate) => [candidate.remoteSessionId, candidate.title ?? null],
    ))).toEqual({
      '153e1829e9d3e497': 'Investigate the failing external-session link',
      '153e1829e9d3e498': 'real prompt',
      '153e1829e9d3e499': 'real prompt',
      '153e1829e9d3e500': null,
    });
  });

  it('bounds persisted titles before candidate publication without changing session identity', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'happier-ohmypi-persisted-titles-'));
    tempDirs.add(agentDir);
    const sessionRoot = join(agentDir, 'sessions', '-repo');
    await mkdir(sessionRoot, { recursive: true });
    const normalTitle = 'Continue the compiler error investigation';
    const asciiTitle = `Keep this useful persisted prefix ${'a'.repeat(10_001)} tail-search-token`;
    const unicodeTitle = `🚀${'😀'.repeat(5_001)}`;
    const sessions = [
      ['153e1829e9d3e501', normalTitle],
      ['153e1829e9d3e502', asciiTitle],
      ['153e1829e9d3e503', unicodeTitle],
    ] as const;
    await Promise.all(sessions.map(async ([remoteSessionId, title]) => {
      await writeFile(
        join(sessionRoot, `2026-07-23T10-00-00-000Z_${remoteSessionId}.jsonl`),
        jsonlLine({
          type: 'session',
          version: 3,
          id: remoteSessionId,
          timestamp: '2026-07-23T10:00:00.000Z',
          cwd: '/repo',
          title,
        }),
        'utf8',
      );
    }));

    const result = await listOhMyPiSessionCandidates({
      source: { kind: 'ohMyPiAgentDir', agentDir },
      env: {},
      limit: 10,
    });
    const titles = new Map(result.candidates.map((candidate) => [
      candidate.remoteSessionId,
      candidate.title,
    ]));

    expect(result.candidates.map((candidate) => candidate.remoteSessionId)).toEqual(
      expect.arrayContaining(sessions.map(([remoteSessionId]) => remoteSessionId)),
    );
    expect(titles.get('153e1829e9d3e501')).toBe(normalTitle);
    expect(titles.get('153e1829e9d3e502')).toBe('Keep this useful persisted prefix ' + 'a'.repeat(83) + '...');
    expect(titles.get('153e1829e9d3e503')).toBe(`🚀${'😀'.repeat(57)}...`);

    const searched = await listOhMyPiSessionCandidates({
      source: { kind: 'ohMyPiAgentDir', agentDir },
      env: {},
      limit: 10,
      searchTerm: 'tail-search-token',
    });
    expect(searched.candidates.map((candidate) => candidate.remoteSessionId)).toEqual([
      '153e1829e9d3e502',
    ]);
  });

  it('normalizes and truncates a long derived title instead of publishing a wall of text', () => {
    expect(formatOhMyPiCandidateTitle('  multi\n  line   prompt  ')).toBe('multi line prompt');
    expect(formatOhMyPiCandidateTitle('   ')).toBeNull();
    expect(formatOhMyPiCandidateTitle(null)).toBeNull();
    const long = formatOhMyPiCandidateTitle('a'.repeat(400));
    expect(long).toHaveLength(120);
    expect(long?.endsWith('...')).toBe(true);
  });
});
