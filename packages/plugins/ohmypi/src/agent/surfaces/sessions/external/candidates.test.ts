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
  it('emits a bounded preparation chunk instead of scanning the whole corpus before slicing', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'happier-ohmypi-bounded-candidates-'));
    tempDirs.add(agentDir);
    const sessionRoot = join(agentDir, 'sessions', '-repo');
    await mkdir(sessionRoot, { recursive: true });
    await Promise.all(Array.from({ length: 100 }, async (_, index) => {
      const remoteSessionId = `session-${String(index).padStart(3, '0')}`;
      await writeFile(
        join(sessionRoot, `2026-07-23T10-00-00-000Z_${remoteSessionId}.jsonl`),
        jsonlLine({
          type: 'session',
          version: 3,
          id: remoteSessionId,
          timestamp: `2026-07-23T10:${String(index % 60).padStart(2, '0')}:00.000Z`,
          cwd: '/repo',
        }),
        'utf8',
      );
    }));
    vi.mocked(open).mockClear();

    const result = await listOhMyPiSessionCandidates({
      source: { kind: 'ohMyPiAgentDir', agentDir },
      env: {},
      limit: 5,
    });

    expect(vi.mocked(open).mock.calls.length).toBeLessThanOrEqual(12);
    expect(result).toMatchObject({
      candidates: expect.any(Array),
      nextCursor: expect.any(String),
      preparation: {
        kind: 'building_candidate_index',
        scanned: 5,
      },
    });
    expect(result.candidates).toHaveLength(5);
  });

  it('rejects a generation-bound continuation after replacement would reorder prior results', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'happier-ohmypi-generation-candidates-'));
    tempDirs.add(agentDir);
    const sessionRoot = join(agentDir, 'sessions', '-repo');
    await mkdir(sessionRoot, { recursive: true });
    const paths = await Promise.all(Array.from({ length: 4 }, async (_, index) => {
      const remoteSessionId = `session-${index}`;
      const path = join(sessionRoot, `2026-07-23T10-00-0${index}-000Z_${remoteSessionId}.jsonl`);
      await writeFile(path, jsonlLine({
        type: 'session',
        version: 3,
        id: remoteSessionId,
        timestamp: `2026-07-23T10:00:0${index}.000Z`,
        cwd: '/repo',
      }), 'utf8');
      return path;
    }));

    const first = await listOhMyPiSessionCandidates({
      source: { kind: 'ohMyPiAgentDir', agentDir },
      env: {},
      limit: 2,
    });
    expect(first.nextCursor).toEqual(expect.any(String));
    if (!first.nextCursor) return;

    const replacement = `${paths[2]}.replacement`;
    await writeFile(replacement, jsonlLine({
      type: 'session',
      version: 3,
      id: 'session-2',
      timestamp: '2026-07-23T11:00:00.000Z',
      cwd: '/repo',
    }), 'utf8');
    await rename(replacement, paths[2]);

    await expect(listOhMyPiSessionCandidates({
      source: { kind: 'ohMyPiAgentDir', agentDir },
      env: {},
      cursor: first.nextCursor,
      limit: 2,
    })).rejects.toBeInstanceOf(OhMyPiCandidateSourceChangedError);
  });

  it('rejects the completed preparation when a previously scanned file changes in place', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'happier-ohmypi-verify-candidates-'));
    tempDirs.add(agentDir);
    const sessionRoot = join(agentDir, 'sessions', '-repo');
    await mkdir(sessionRoot, { recursive: true });
    await Promise.all(Array.from({ length: 6 }, async (_, index) => {
      const remoteSessionId = `verify-${index}`;
      await writeFile(
        join(sessionRoot, `2026-07-23T10-00-0${index}-000Z_${remoteSessionId}.jsonl`),
        jsonlLine({
          type: 'session',
          version: 3,
          id: remoteSessionId,
          timestamp: `2026-07-23T10:00:0${index}.000Z`,
          cwd: '/repo',
        }),
        'utf8',
      );
    }));

    const first = await listOhMyPiSessionCandidates({
      source: { kind: 'ohMyPiAgentDir', agentDir },
      env: {},
      limit: 2,
    });
    const firstCandidateDetails = first.candidates[0]?.details as
      | Readonly<{ sessionFilePath?: unknown }>
      | undefined;
    expect(firstCandidateDetails?.sessionFilePath).toEqual(expect.any(String));
    expect(first.nextCursor).toEqual(expect.any(String));
    if (typeof firstCandidateDetails?.sessionFilePath !== 'string' || !first.nextCursor) return;

    const second = await listOhMyPiSessionCandidates({
      source: { kind: 'ohMyPiAgentDir', agentDir },
      env: {},
      cursor: first.nextCursor,
      limit: 2,
    });
    expect(second.nextCursor).toEqual(expect.any(String));
    if (!second.nextCursor) return;
    await appendFile(firstCandidateDetails.sessionFilePath, jsonlLine({
      type: 'session_info',
      name: 'mutated after its scan chunk',
      timestamp: '2026-07-23T12:00:00.000Z',
    }), 'utf8');

    let cursor = second.nextCursor;
    let rejection: unknown = null;
    for (let attempt = 0; attempt < 10 && cursor; attempt += 1) {
      try {
        const page = await listOhMyPiSessionCandidates({
          source: { kind: 'ohMyPiAgentDir', agentDir },
          env: {},
          cursor,
          limit: 2,
        });
        cursor = page.nextCursor ?? '';
      } catch (error) {
        rejection = error;
        break;
      }
    }
    expect(rejection).toBeInstanceOf(OhMyPiCandidateSourceChangedError);
  });

  it('keeps every scan and verification chunk bounded while covering the stable corpus exactly once', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'happier-ohmypi-bounded-verification-'));
    tempDirs.add(agentDir);
    const sessionRoot = join(agentDir, 'sessions', '-repo');
    await mkdir(sessionRoot, { recursive: true });
    const expectedIds = Array.from({ length: 6 }, (_, index) => `bounded-verify-${index}`);
    await Promise.all(expectedIds.map(async (remoteSessionId, index) => {
      await writeFile(
        join(sessionRoot, `2026-07-23T10-00-0${index}-000Z_${remoteSessionId}.jsonl`),
        jsonlLine({
          type: 'session',
          version: 3,
          id: remoteSessionId,
          timestamp: `2026-07-23T10:00:0${index}.000Z`,
          cwd: '/repo',
        }),
        'utf8',
      );
    }));

    const seen: string[] = [];
    let cursor: string | undefined;
    let sawVerificationChunk = false;
    for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
      vi.mocked(open).mockClear();
      const page = await listOhMyPiSessionCandidates({
        source: { kind: 'ohMyPiAgentDir', agentDir },
        env: {},
        ...(cursor ? { cursor } : {}),
        limit: 2,
      });
      expect(vi.mocked(open).mock.calls.length).toBeLessThanOrEqual(4);
      expect(page.candidates.length).toBeLessThanOrEqual(2);
      expect(page.preparation).toMatchObject({ kind: 'building_candidate_index' });
      if (page.candidates.length === 0 && page.nextCursor) sawVerificationChunk = true;
      seen.push(...page.candidates.map((candidate) => candidate.remoteSessionId));
      cursor = page.nextCursor ?? undefined;
      if (!cursor) break;
    }

    expect(sawVerificationChunk).toBe(true);
    expect(seen).toHaveLength(expectedIds.length);
    expect(new Set(seen)).toEqual(new Set(expectedIds));
  });

  it('stops bounded preparation when the browse signal is cancelled', async () => {
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
});
