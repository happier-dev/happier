import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  resolveServerLightOwnershipLeasesDir,
  sweepServerLightOwnershipLeases,
} from './serverLight';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('serverLight ownership leases', () => {
  it('reclaims a stale server-light lease when the owner is gone and the child start time still matches', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-server-light-lease-'));
    try {
      const leaseDir = resolveServerLightOwnershipLeasesDir(rootDir);
      await mkdir(leaseDir, { recursive: true });

      const markerPath = join(leaseDir, 'pid-8123.json');
      await writeFile(
        markerPath,
        JSON.stringify({
          childPid: 8123,
          childStartTime: 'Tue Mar 18 10:10:10 2026',
          ownerPid: 9001,
          ownerStartTime: 'Tue Mar 18 09:09:09 2026',
          port: 43_210,
          baseUrl: 'http://127.0.0.1:43210',
          dataDir: resolve(rootDir, 'server-light-data'),
          createdAtMs: 123,
        }),
        'utf8',
      );

      const terminateProcessTreeByPid = vi.fn(async () => {});
      const inspectProcess = vi.fn((pid: number) => {
        if (pid === 9001) {
          return { ok: false as const, reason: 'not_found' as const };
        }
        if (pid === 8123) {
          return {
            ok: true as const,
            command: 'node /tmp/repo/apps/server/dist/index.mjs start:light',
            startTime: 'Tue Mar 18 10:10:10 2026',
            looksLikeServerLight: true,
          };
        }
        return { ok: false as const, reason: 'inspect_failed' as const };
      });

      await sweepServerLightOwnershipLeases({
        rootDir,
        currentOwnerPid: 1337,
        currentOwnerStartTime: 'Tue Mar 18 11:11:11 2026',
        inspectProcess,
        terminateProcessTreeByPid,
      });

      expect(terminateProcessTreeByPid).toHaveBeenCalledTimes(1);
      expect(terminateProcessTreeByPid).toHaveBeenCalledWith(8123, expect.any(Object));
      await expect(readFile(markerPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('does not reclaim a live server-light lease owned by the current worker', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-server-light-lease-live-'));
    try {
      const leaseDir = resolveServerLightOwnershipLeasesDir(rootDir);
      await mkdir(leaseDir, { recursive: true });

      const markerPath = join(leaseDir, 'pid-8124.json');
      await writeFile(
        markerPath,
        JSON.stringify({
          childPid: 8124,
          childStartTime: 'Tue Mar 18 12:12:12 2026',
          ownerPid: 9002,
          ownerStartTime: 'Tue Mar 18 13:13:13 2026',
          port: 43_211,
          baseUrl: 'http://127.0.0.1:43211',
          dataDir: resolve(rootDir, 'server-light-data'),
          createdAtMs: 456,
        }),
        'utf8',
      );

      const terminateProcessTreeByPid = vi.fn(async () => {});
      const inspectProcess = vi.fn((pid: number) => {
        if (pid === 9002) {
          return {
            ok: true as const,
            command: 'node /tmp/repo/apps/server/dist/index.mjs start:light',
            startTime: 'Tue Mar 18 13:13:13 2026',
            looksLikeServerLight: true,
          };
        }
        if (pid === 8124) {
          return {
            ok: true as const,
            command: 'node /tmp/repo/apps/server/dist/index.mjs start:light',
            startTime: 'Tue Mar 18 12:12:12 2026',
            looksLikeServerLight: true,
          };
        }
        return { ok: false as const, reason: 'inspect_failed' as const };
      });

      await sweepServerLightOwnershipLeases({
        rootDir,
        currentOwnerPid: 9002,
        currentOwnerStartTime: 'Tue Mar 18 13:13:13 2026',
        inspectProcess,
        terminateProcessTreeByPid,
      });

      expect(terminateProcessTreeByPid).not.toHaveBeenCalled();
      expect(await readFile(markerPath, 'utf8')).toContain('"childPid":8124');
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('keeps a lease marker when the child pid no longer matches the stored start time', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-server-light-lease-mismatch-'));
    try {
      const leaseDir = resolveServerLightOwnershipLeasesDir(rootDir);
      await mkdir(leaseDir, { recursive: true });

      const markerPath = join(leaseDir, 'pid-8125.json');
      await writeFile(
        markerPath,
        JSON.stringify({
          childPid: 8125,
          childStartTime: 'Tue Mar 18 14:14:14 2026',
          ownerPid: 9003,
          ownerStartTime: 'Tue Mar 18 15:15:15 2026',
          port: 43_212,
          baseUrl: 'http://127.0.0.1:43212',
          dataDir: resolve(rootDir, 'server-light-data'),
          createdAtMs: 789,
        }),
        'utf8',
      );

      const terminateProcessTreeByPid = vi.fn(async () => {});
      const inspectProcess = vi.fn((pid: number) => {
        if (pid === 9003) {
          return { ok: false as const, reason: 'not_found' as const };
        }
        if (pid === 8125) {
          return {
            ok: true as const,
            command: 'node /tmp/reused/apps/server/dist/index.mjs start:light',
            startTime: 'Tue Mar 18 16:16:16 2026',
            looksLikeServerLight: true,
          };
        }
        return { ok: false as const, reason: 'inspect_failed' as const };
      });

      await sweepServerLightOwnershipLeases({
        rootDir,
        currentOwnerPid: 1337,
        currentOwnerStartTime: 'Tue Mar 18 17:17:17 2026',
        inspectProcess,
        terminateProcessTreeByPid,
      });

      expect(terminateProcessTreeByPid).not.toHaveBeenCalled();
      expect(await readFile(markerPath, 'utf8')).toContain('"childPid":8125');
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
