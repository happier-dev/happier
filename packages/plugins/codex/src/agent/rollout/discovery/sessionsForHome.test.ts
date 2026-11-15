import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const fsBoundary = vi.hoisted(() => ({
  open: vi.fn(),
  readdir: vi.fn(),
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    open: (...args: Parameters<typeof actual.open>) => fsBoundary.open(...args),
    readdir: (...args: Parameters<typeof actual.readdir>) => (
      fsBoundary.readdir(...args)
    ),
  };
});

import {
  collectCodexRootSessionRolloutFiles,
  collectCodexSessionRolloutFiles,
  inventoryCodexRootSessionRolloutFiles,
  resolveCodexHomeFromRolloutFilePath,
} from './sessionsForHome.js';

describe('collectCodexSessionRolloutFiles', () => {
  beforeEach(async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    fsBoundary.open.mockReset();
    fsBoundary.open.mockImplementation(actual.open);
    fsBoundary.readdir.mockReset();
    fsBoundary.readdir.mockImplementation(actual.readdir);
  });

  it('collects rollout files from date-derived day directories without reading the sessions root', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-rollout-fast-'));
    const remoteSessionId = '019c5b0c-b765-72e0-b799-6eca4714a46b';
    const dayDir = join(codexHome, 'sessions', '2026', '02', '14');
    await mkdir(dayDir, { recursive: true });
    await writeFile(
      join(dayDir, `rollout-2026-02-14T08-28-05-${remoteSessionId}.jsonl`),
      '{"event":"one"}\n',
      'utf8',
    );
    await writeFile(
      join(dayDir, `rollout-2026-02-14T12-45-10-${remoteSessionId}.jsonl`),
      '{"event":"two"}\n',
      'utf8',
    );

    fsBoundary.readdir.mockImplementation(async (dir, options) => {
      const dirPath = String(dir);
      if (dirPath === join(codexHome, 'sessions') || dirPath === join(codexHome, 'archived_sessions')) {
        throw Object.assign(new Error('root scan disabled for fast-path test'), { code: 'EACCES' });
      }
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      return actual.readdir(dir, options as any);
    });

    const files = await collectCodexSessionRolloutFiles({ codexHome, remoteSessionId });

    expect(files.map((file) => file.fileRelPath)).toEqual([
      `sessions/2026/02/14/rollout-2026-02-14T08-28-05-${remoteSessionId}.jsonl`,
      `sessions/2026/02/14/rollout-2026-02-14T12-45-10-${remoteSessionId}.jsonl`,
    ]);
  });

  it('falls back to recursive scanning for non timestamp-derived session ids', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-rollout-fallback-'));
    const remoteSessionId = 'legacy-session-id';
    const nestedDir = join(codexHome, 'sessions', 'custom', 'tree');
    await mkdir(nestedDir, { recursive: true });
    await writeFile(
      join(nestedDir, `rollout-2026-02-14T08-28-05-${remoteSessionId}.jsonl`),
      '{"event":"legacy"}\n',
      'utf8',
    );

    const files = await collectCodexSessionRolloutFiles({ codexHome, remoteSessionId });

    expect(files.map((file) => file.fileRelPath)).toEqual([
      `sessions/custom/tree/rollout-2026-02-14T08-28-05-${remoteSessionId}.jsonl`,
    ]);
  });

  it('falls back to session_meta matching for flat rollout files whose name does not include the session id', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-rollout-session-meta-'));
    const remoteSessionId = 'session-meta-match';
    const sessionsDir = join(codexHome, 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(
      join(sessionsDir, 'rollout-test.jsonl'),
      `${JSON.stringify({
        type: 'session_meta',
        payload: {
          id: remoteSessionId,
          timestamp: '2026-02-14T08:28:05.000Z',
          cwd: '/repo/meta-match',
        },
      })}\n`,
      'utf8',
    );

    const files = await collectCodexSessionRolloutFiles({ codexHome, remoteSessionId });

    expect(files.map((file) => file.fileRelPath)).toEqual([
      'sessions/rollout-test.jsonl',
    ]);
  });

  it('keeps exact-thread collection separate from official root-session child membership', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-rollout-child-'));
    const remoteSessionId = 'root-session';
    const sessionsDir = join(codexHome, 'sessions', 'child-rollouts');
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(
      join(sessionsDir, 'rollout-root.jsonl'),
      `${JSON.stringify({
        type: 'session_meta',
        payload: { id: remoteSessionId },
      })}\n`,
      'utf8',
    );
    await writeFile(
      join(sessionsDir, 'rollout-child-thread.jsonl'),
      `${JSON.stringify({
        type: 'session_meta',
        payload: {
          id: 'child-thread',
          session_id: remoteSessionId,
        },
      })}\n`,
      'utf8',
    );
    await writeFile(
      join(sessionsDir, 'rollout-other-root-child.jsonl'),
      `${JSON.stringify({
        type: 'session_meta',
        payload: {
          id: 'other-child-thread',
          session_id: 'other-root-session',
        },
      })}\n`,
      'utf8',
    );

    const [threadFiles, rootSessionFiles] = await Promise.all([
      collectCodexSessionRolloutFiles({ codexHome, remoteSessionId }),
      collectCodexRootSessionRolloutFiles({ codexHome, remoteSessionId }),
    ]);

    expect(threadFiles.map((file) => file.fileRelPath)).toEqual([
      'sessions/child-rollouts/rollout-root.jsonl',
    ]);
    expect(rootSessionFiles.map((file) => file.fileRelPath).sort()).toEqual([
      'sessions/child-rollouts/rollout-child-thread.jsonl',
      'sessions/child-rollouts/rollout-root.jsonl',
    ]);
  });

  it('does not match rollout filenames that only contain the remote session id as a substring', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-rollout-substring-'));
    const sessionsDir = join(codexHome, 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(
      join(sessionsDir, 'rollout-2026-02-14T08-28-05-abc123.jsonl'),
      `${JSON.stringify({
        type: 'session_meta',
        payload: {
          id: 'abc123',
          timestamp: '2026-02-14T08:28:05.000Z',
        },
      })}\n`,
      'utf8',
    );

    const files = await collectCodexSessionRolloutFiles({ codexHome, remoteSessionId: 'abc' });

    expect(files).toEqual([]);
  });
});

describe('inventoryCodexRootSessionRolloutFiles', () => {
  it('does not turn an unreadable rollout directory into proof of source removal', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-inventory-unavailable-'));
    const dir = join(codexHome, 'sessions');
    const file = join(dir, 'rollout-owned.jsonl');
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(file, JSON.stringify({ type: 'session_meta', payload: { id: 'owned-session' } }) + '\n');
      const request = { codexHome, remoteSessionIds: ['owned-session'], signal: new AbortController().signal };
      expect((await inventoryCodexRootSessionRolloutFiles(request)).requested[0]?.files).toHaveLength(1);
      fsBoundary.readdir.mockImplementation(async (...args: Parameters<typeof actual.readdir>) => {
        if (String(args[0]) === dir) throw Object.assign(new Error('storage access revoked'), { code: 'EACCES' });
        return actual.readdir(...args);
      });
      await expect(inventoryCodexRootSessionRolloutFiles(request)).rejects.toMatchObject({ code: 'EACCES' });
      fsBoundary.readdir.mockImplementation(actual.readdir);
      await rm(file);
      expect((await inventoryCodexRootSessionRolloutFiles(request)).requested[0]?.files).toEqual([]);
    } finally { fsBoundary.readdir.mockImplementation(actual.readdir); await rm(codexHome, { recursive: true, force: true }); }
  });
  beforeEach(async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>(
      'node:fs/promises',
    );
    fsBoundary.open.mockReset();
    fsBoundary.open.mockImplementation(actual.open);
    fsBoundary.readdir.mockReset();
    fsBoundary.readdir.mockImplementation(actual.readdir);
  });

  it('inventories a current UUID root family without opening unrelated historical rollouts', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-inventory-fast-'));
    const timestampMs = Date.now();
    const timestampHex = timestampMs.toString(16).padStart(12, '0').slice(-12);
    const remoteSessionId = [
      timestampHex.slice(0, 8),
      timestampHex.slice(8),
      '7000',
      '8000',
      '000000000001',
    ].join('-');
    const observedAt = new Date(timestampMs);
    const dayDir = join(
      codexHome,
      'sessions',
      String(observedAt.getUTCFullYear()),
      String(observedAt.getUTCMonth() + 1).padStart(2, '0'),
      String(observedAt.getUTCDate()).padStart(2, '0'),
    );
    await mkdir(dayDir, { recursive: true });
    const archivedDir = join(codexHome, 'archived_sessions');
    await mkdir(archivedDir, { recursive: true });
    const unrelatedHistoricalFile = join(
      archivedDir,
      'rollout-2020-01-01T00-00-00-00000000-0000-7000-8000-000000000002.jsonl',
    );
    await Promise.all([
      writeFile(
        join(dayDir, `rollout-current-${remoteSessionId}.jsonl`),
        JSON.stringify({
          type: 'session_meta',
          payload: { id: remoteSessionId },
        }),
        'utf8',
      ),
      writeFile(
        join(dayDir, 'rollout-current-child.jsonl'),
        JSON.stringify({
          type: 'session_meta',
          payload: {
            id: 'child-thread',
            session_id: remoteSessionId,
          },
        }),
        'utf8',
      ),
      writeFile(
        unrelatedHistoricalFile,
        JSON.stringify({
          type: 'session_meta',
          payload: { id: 'unrelated-historical-thread' },
        }),
        'utf8',
      ),
    ]);

    const inventory = await inventoryCodexRootSessionRolloutFiles({
      codexHome,
      remoteSessionIds: [remoteSessionId],
      signal: new AbortController().signal,
    });

    expect(
      inventory.requested[0]?.files.map(({ fileRelPath }) => fileRelPath).sort(),
    ).toEqual([
      relative(codexHome, join(dayDir, 'rollout-current-child.jsonl')),
      relative(
        codexHome,
        join(dayDir, `rollout-current-${remoteSessionId}.jsonl`),
      ),
    ].sort());
    expect(
      fsBoundary.open.mock.calls.some(
        ([path]) => String(path) === unrelatedHistoricalFile,
      ),
    ).toBe(false);
  });

  it('reads rollout heads only inside the family activity window and still finds late continuations and their children', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-inventory-activity-'));
    const hourMs = 60 * 60 * 1000;
    const dayMs = 24 * hourMs;
    const rootStartMs = Math.trunc((Date.now() - 20 * dayMs) / 1000) * 1000;
    const hex = rootStartMs.toString(16).padStart(12, '0').slice(-12);
    const rootId = [hex.slice(0, 8), hex.slice(8), '7000', '8000', '000000000001'].join('-');
    const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const rollout = async (atMs: number, suffix: string, payload: Record<string, unknown>, lastWriteMs: number) => {
      const at = new Date(atMs);
      const dir = join(codexHome, 'sessions', String(at.getUTCFullYear()),
        String(at.getUTCMonth() + 1).padStart(2, '0'), String(at.getUTCDate()).padStart(2, '0'));
      await mkdir(dir, { recursive: true });
      const stamp = at.toISOString().slice(0, 19).replace(/:/g, '-');
      const file = join(dir, `rollout-${stamp}-${suffix}.jsonl`);
      await writeFile(file, JSON.stringify({ type: 'session_meta', payload }) + '\n', 'utf8');
      await utimes(file, new Date(lastWriteMs), new Date(lastWriteMs));
      return file;
    };
    try {
      // The root ran for an hour and spawned a child during that hour.
      const root = await rollout(rootStartMs, rootId, { id: rootId }, rootStartMs + hourMs);
      const child = await rollout(rootStartMs + 30 * 60 * 1000, uuid(2), { id: uuid(2), session_id: rootId }, rootStartMs + 50 * 60 * 1000);
      // Unrelated work after the root went quiet; nothing of the family was being written.
      const quiet = await Promise.all([3, 4].map(async (offsetDays) => rollout(rootStartMs + offsetDays * dayMs, uuid(10 + offsetDays),
        { id: uuid(10 + offsetDays) }, rootStartMs + offsetDays * dayMs + hourMs)));
      // A later continuation of the same thread (found by its file name), a child it spawned that
      // kept running, and a grandchild that long-running child spawned a day later.
      const continuation = await rollout(rootStartMs + 6 * dayMs, `${rootId}_${uuid(20)}`, { id: rootId }, rootStartMs + 6 * dayMs + hourMs);
      const lateChild = await rollout(rootStartMs + 6 * dayMs + 10 * 60 * 1000, uuid(21), { id: uuid(21), session_id: rootId },
        rootStartMs + 8 * dayMs + 2 * hourMs);
      const grandchild = await rollout(rootStartMs + 8 * dayMs + hourMs, uuid(22), { id: uuid(22), session_id: rootId },
        rootStartMs + 8 * dayMs + 90 * 60 * 1000);
      // Codex `thread/revert` writes a new `<thread>_<rollout>` file for a thread, here a child,
      // whenever the user reverts it, independent of the family's last write.
      const revertedChild = await rollout(rootStartMs + 15 * dayMs, `${uuid(2)}_${uuid(23)}`, { id: uuid(2), session_id: rootId },
        rootStartMs + 15 * dayMs + 60 * 1000);
      const afterAllActivity = await Promise.all([17, 18, 19].map(async (offsetDays) => rollout(rootStartMs + offsetDays * dayMs, uuid(30 + offsetDays),
        { id: uuid(30 + offsetDays) }, rootStartMs + offsetDays * dayMs + hourMs)));

      const inventory = await inventoryCodexRootSessionRolloutFiles({
        codexHome, remoteSessionIds: [rootId], signal: new AbortController().signal,
      });

      expect(inventory.requested[0]?.files.map(({ filePath }) => filePath).sort()).toEqual(
        [root, child, continuation, lateChild, grandchild, revertedChild].sort());
      const opened = new Set(fsBoundary.open.mock.calls.map(([path]) => String(path)));
      // Heads inside the activity window are still read; later unrelated heads are not.
      expect(quiet.filter((file) => opened.has(file))).toHaveLength(2);
      expect(afterAllActivity.filter((file) => opened.has(file))).toHaveLength(0);
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('does not list dated rollout directories that end before the requested root started', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-inventory-dated-'));
    const rootStartMs = Date.UTC(2026, 2, 10, 12, 0, 0);
    const hex = rootStartMs.toString(16).padStart(12, '0').slice(-12);
    const rootId = [hex.slice(0, 8), hex.slice(8), '7000', '8000', '000000000001'].join('-');
    const dirs = {
      oldYear: join(codexHome, 'sessions', '2025', '12', '31'),
      oldMonth: join(codexHome, 'sessions', '2026', '02', '27'),
      dayBeforeWindow: join(codexHome, 'sessions', '2026', '03', '08'),
      dayInsideWindow: join(codexHome, 'sessions', '2026', '03', '09'),
      rootDay: join(codexHome, 'sessions', '2026', '03', '10'),
    };
    try {
      for (const [name, dir] of Object.entries(dirs)) {
        await mkdir(dir, { recursive: true });
        const stamp = `${dir.split('/').slice(-3).join('-')}T23-00-00`;
        const id = name === 'rootDay' ? rootId : `00000000-0000-4000-8000-${String(Object.keys(dirs).indexOf(name)).padStart(12, '0')}`;
        await writeFile(join(dir, `rollout-${name === 'rootDay' ? '2026-03-10T12-00-00' : stamp}-${id}.jsonl`),
          JSON.stringify({ type: 'session_meta', payload: { id } }) + '\n', 'utf8');
      }
      const inventory = await inventoryCodexRootSessionRolloutFiles({
        codexHome, remoteSessionIds: [rootId], signal: new AbortController().signal,
      });
      expect(inventory.requested[0]?.files.map(({ filePath }) => filePath)).toEqual([
        join(dirs.rootDay, `rollout-2026-03-10T12-00-00-${rootId}.jsonl`)]);
      const listed = new Set(fsBoundary.readdir.mock.calls.map(([path]) => String(path)));
      expect([dirs.oldYear, join(codexHome, 'sessions', '2025'), dirs.oldMonth, join(codexHome, 'sessions', '2026', '02'), dirs.dayBeforeWindow]
        .filter((dir) => listed.has(dir))).toEqual([]);
      expect(listed.has(dirs.dayInsideWindow)).toBe(true);
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('opens each same-day rollout once when batching current UUIDv7 root families', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-inventory-batch-'));
    const timestampMs = Date.now();
    const timestampHex = timestampMs.toString(16).padStart(12, '0').slice(-12);
    const remoteSessionIdA = [
      timestampHex.slice(0, 8),
      timestampHex.slice(8),
      '7000',
      '8000',
      '00000000000a',
    ].join('-');
    const remoteSessionIdB = [
      timestampHex.slice(0, 8),
      timestampHex.slice(8),
      '7000',
      '8000',
      '00000000000b',
    ].join('-');
    const observedAt = new Date(timestampMs);
    const dayDir = join(
      codexHome,
      'sessions',
      String(observedAt.getUTCFullYear()),
      String(observedAt.getUTCMonth() + 1).padStart(2, '0'),
      String(observedAt.getUTCDate()).padStart(2, '0'),
    );
    await mkdir(dayDir, { recursive: true });
    const rootA = join(dayDir, 'rollout-current-root-a.jsonl');
    const rootB = join(dayDir, 'rollout-current-root-b.jsonl');
    const childA = join(dayDir, 'rollout-current-child-a.jsonl');
    await Promise.all([
      writeFile(
        rootA,
        JSON.stringify({
          type: 'session_meta',
          payload: { id: remoteSessionIdA },
        }),
        'utf8',
      ),
      writeFile(
        rootB,
        JSON.stringify({
          type: 'session_meta',
          payload: { id: remoteSessionIdB },
        }),
        'utf8',
      ),
      writeFile(
        childA,
        JSON.stringify({
          type: 'session_meta',
          payload: {
            id: 'child-thread-a',
            session_id: remoteSessionIdA,
          },
        }),
        'utf8',
      ),
    ]);

    const inventory = await inventoryCodexRootSessionRolloutFiles({
      codexHome,
      remoteSessionIds: [remoteSessionIdB, remoteSessionIdA],
      signal: new AbortController().signal,
    });

    expect(
      inventory.requested.map(({ remoteSessionId, files }) => ({
        remoteSessionId,
        files: files.map(({ filePath }) => filePath).sort(),
      })),
    ).toEqual([
      { remoteSessionId: remoteSessionIdB, files: [rootB] },
      {
        remoteSessionId: remoteSessionIdA,
        files: [childA, rootA].sort(),
      },
    ]);
    for (const file of [rootA, rootB, childA]) {
      expect(
        fsBoundary.open.mock.calls.filter(
          ([path]) => String(path) === file,
        ),
      ).toHaveLength(1);
    }
  });

  it('stops targeted first-line probes after the inventory is aborted', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-inventory-abort-targeted-'));
    const timestampMs = Date.now();
    const timestampHex = timestampMs.toString(16).padStart(12, '0').slice(-12);
    const remoteSessionId = [
      timestampHex.slice(0, 8),
      timestampHex.slice(8),
      '7000',
      '8000',
      '000000000005',
    ].join('-');
    const observedAt = new Date(timestampMs);
    const dayDir = join(
      codexHome,
      'sessions',
      String(observedAt.getUTCFullYear()),
      String(observedAt.getUTCMonth() + 1).padStart(2, '0'),
      String(observedAt.getUTCDate()).padStart(2, '0'),
    );
    await mkdir(dayDir, { recursive: true });
    await Promise.all(['one', 'two', 'three'].map(async (suffix) => {
      await writeFile(
        join(dayDir, `rollout-current-${suffix}.jsonl`),
        JSON.stringify({
          type: 'session_meta',
          payload: { id: `unrelated-${suffix}` },
        }),
        'utf8',
      );
    }));
    const controller = new AbortController();
    const actual = await vi.importActual<typeof import('node:fs/promises')>(
      'node:fs/promises',
    );
    fsBoundary.open.mockImplementation(async (path, flags) => {
      const handle = await actual.open(path, flags);
      controller.abort();
      return handle;
    });

    await expect(inventoryCodexRootSessionRolloutFiles({
      codexHome,
      remoteSessionIds: [remoteSessionId],
      signal: controller.signal,
    })).rejects.toThrow();
    expect(fsBoundary.open).toHaveBeenCalledTimes(1);
  });

  it('keeps current flat archived rollouts when local filename time is behind UUIDv7 time', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-inventory-tz-'));
    const timestampMs = Date.now();
    const timestampHex = timestampMs.toString(16).padStart(12, '0').slice(-12);
    const remoteSessionId = [
      timestampHex.slice(0, 8),
      timestampHex.slice(8),
      '7000',
      '8000',
      '000000000004',
    ].join('-');
    const archivedDir = join(codexHome, 'archived_sessions');
    await mkdir(archivedDir, { recursive: true });
    const localFilenameTime = new Date(timestampMs - 8 * 60 * 60 * 1_000)
      .toISOString()
      .slice(0, 19)
      .replaceAll(':', '-');
    const archivedFile = join(
      archivedDir,
      `rollout-${localFilenameTime}-${remoteSessionId}.jsonl`,
    );
    await writeFile(
      archivedFile,
      JSON.stringify({
        type: 'session_meta',
        payload: { id: remoteSessionId },
      }),
      'utf8',
    );

    const inventory = await inventoryCodexRootSessionRolloutFiles({
      codexHome,
      remoteSessionIds: [remoteSessionId],
      signal: new AbortController().signal,
    });

    expect(inventory.requested[0]?.files.map(({ filePath }) => filePath)).toEqual([
      archivedFile,
    ]);
  });

  it('retains full fallback discovery for UUID-shaped non-v7 session ids', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-inventory-v4-'));
    const timestampHex = Date.now().toString(16).padStart(12, '0').slice(-12);
    const remoteSessionId = [
      timestampHex.slice(0, 8),
      timestampHex.slice(8),
      '4000',
      '8000',
      '000000000003',
    ].join('-');
    const archivedDir = join(codexHome, 'archived_sessions', 'legacy');
    await mkdir(archivedDir, { recursive: true });
    const legacyFile = join(
      archivedDir,
      'rollout-2020-01-01T00-00-00-legacy-v4.jsonl',
    );
    await writeFile(
      legacyFile,
      JSON.stringify({
        type: 'session_meta',
        payload: { id: remoteSessionId },
      }),
      'utf8',
    );

    const inventory = await inventoryCodexRootSessionRolloutFiles({
      codexHome,
      remoteSessionIds: [remoteSessionId],
      signal: new AbortController().signal,
    });

    expect(inventory.requested[0]?.files.map(({ filePath }) => filePath)).toEqual([
      legacyFile,
    ]);
  });

  it('groups requested roots and official children in requested order while excluding unrelated roots', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-inventory-'));
    const sessionsDir = join(codexHome, 'sessions', 'nested');
    const archivedDir = join(codexHome, 'archived_sessions', 'nested');
    await mkdir(sessionsDir, { recursive: true });
    await mkdir(archivedDir, { recursive: true });
    await Promise.all([
      writeFile(
        join(sessionsDir, 'rollout-root-a.jsonl'),
        JSON.stringify({
          type: 'session_meta',
          payload: { id: 'root-a' },
        }),
        'utf8',
      ),
      writeFile(
        join(sessionsDir, 'rollout-child-a.jsonl'),
        JSON.stringify({
          type: 'session_meta',
          payload: { id: 'child-a', session_id: 'root-a' },
        }),
        'utf8',
      ),
      writeFile(
        join(archivedDir, 'rollout-root-b.jsonl'),
        JSON.stringify({
          type: 'session_meta',
          payload: { id: 'root-b' },
        }),
        'utf8',
      ),
      writeFile(
        join(sessionsDir, 'rollout-unrelated.jsonl'),
        JSON.stringify({
          type: 'session_meta',
          payload: { id: 'unrelated-root' },
        }),
        'utf8',
      ),
    ]);

    const inventory = await inventoryCodexRootSessionRolloutFiles({
      codexHome,
      remoteSessionIds: ['root-b', 'root-a', 'missing-root'],
      signal: new AbortController().signal,
    });

    expect(
      inventory.requested.map(({ remoteSessionId }) => remoteSessionId),
    ).toEqual(['root-b', 'root-a', 'missing-root']);
    expect(
      inventory.requested.map(({ files }) => (
        files.map(({ fileRelPath }) => fileRelPath).sort()
      )),
    ).toEqual([
      ['archived_sessions/nested/rollout-root-b.jsonl'],
      [
        'sessions/nested/rollout-child-a.jsonl',
        'sessions/nested/rollout-root-a.jsonl',
      ],
      [],
    ]);
    expect(JSON.stringify(inventory)).not.toContain('unrelated-root');
    expect(
      fsBoundary.readdir.mock.calls.filter(
        ([path]) => String(path) === join(codexHome, 'sessions'),
      ),
    ).toHaveLength(1);
    expect(
      fsBoundary.readdir.mock.calls.filter(
        ([path]) => String(path) === join(codexHome, 'archived_sessions'),
      ),
    ).toHaveLength(1);
  });

  it('aborts the inventory before traversing the second topology root', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-abort-'));
    await mkdir(join(codexHome, 'sessions'), { recursive: true });
    await mkdir(join(codexHome, 'archived_sessions'), { recursive: true });
    const controller = new AbortController();
    const actual = await vi.importActual<typeof import('node:fs/promises')>(
      'node:fs/promises',
    );
    fsBoundary.readdir.mockImplementation(async (path, options) => {
      const entries = await actual.readdir(path, options as never);
      if (String(path) === join(codexHome, 'sessions')) {
        controller.abort();
      }
      return entries;
    });

    await expect(inventoryCodexRootSessionRolloutFiles({
      codexHome,
      remoteSessionIds: ['root-a'],
      signal: controller.signal,
    })).rejects.toThrow();
    expect(
      fsBoundary.readdir.mock.calls.some(
        ([path]) => String(path) === join(codexHome, 'archived_sessions'),
      ),
    ).toBe(false);
  });
});

describe('resolveCodexHomeFromRolloutFilePath', () => {
  it('resolves the Codex home from active and archived rollout file paths', () => {
    expect(resolveCodexHomeFromRolloutFilePath('/home/user/.codex/sessions/rollout-session.jsonl')).toBe('/home/user/.codex');
    expect(resolveCodexHomeFromRolloutFilePath('/home/user/.codex/archived_sessions/rollout-session.jsonl')).toBe('/home/user/.codex');
    expect(resolveCodexHomeFromRolloutFilePath(String.raw`C:\Users\me\.codex\sessions\rollout-session.jsonl`)).toBe('C:/Users/me/.codex');
  });

  it('returns null for paths outside Codex rollout roots', () => {
    expect(resolveCodexHomeFromRolloutFilePath('/home/user/.codex/session-files/rollout-session.jsonl')).toBeNull();
  });
});

describe('inventoryCodexRootSessionRolloutFiles provider-session identity', () => {
  beforeEach(async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    fsBoundary.open.mockReset();
    fsBoundary.open.mockImplementation(actual.open);
    fsBoundary.readdir.mockReset();
    fsBoundary.readdir.mockImplementation(actual.readdir);
  });

  it('matches a rollout whose recorded session id carries exact provider bytes', async () => {
    // Codex writes the id into session_meta verbatim and callers now request it
    // verbatim, so the inventory must compare the recorded bytes rather than a
    // trimmed rewrite of them.
    const exactRemoteSessionId = '  provider\nses/AB+cd==  ';
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-rollout-exact-id-'));
    const dayDir = join(codexHome, 'sessions', '2026', '02', '14');
    await mkdir(dayDir, { recursive: true });
    const rolloutFile = join(dayDir, 'rollout-2026-02-14T08-28-05-exact.jsonl');
    await writeFile(
      rolloutFile,
      JSON.stringify({ type: 'session_meta', payload: { id: exactRemoteSessionId } }),
      'utf8',
    );

    const inventory = await inventoryCodexRootSessionRolloutFiles({
      codexHome,
      remoteSessionIds: [exactRemoteSessionId],
      signal: new AbortController().signal,
    });

    expect(inventory.requested[0]).toMatchObject({
      remoteSessionId: exactRemoteSessionId,
      files: [expect.objectContaining({
        filePath: rolloutFile,
        sessionId: exactRemoteSessionId,
      })],
    });
  });
});
