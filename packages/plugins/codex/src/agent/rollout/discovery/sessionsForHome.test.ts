import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
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
