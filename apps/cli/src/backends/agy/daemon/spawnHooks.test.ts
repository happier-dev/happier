import { dirname } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { installPinnedAgyAcpServerFixture, withIsolatedHappierHome } from '@/backends/agy/acp/pinnedAgyAcpServer.testkit';
import { createExecutableShim } from '@/testkit/fs/executableShim';
import { removeTempDir } from '@/testkit/fs/tempDir';

import { agyDaemonSpawnHooks } from './spawnHooks';

const tempDirs = new Set<string>();

afterEach(async () => {
  for (const dir of tempDirs) await removeTempDir(dir);
  tempDirs.clear();
});

async function validateSpawn(environmentVariables: NodeJS.ProcessEnv, readinessOnly?: boolean) {
  return await agyDaemonSpawnHooks.validateSpawn!({ environmentVariables, ...(readinessOnly ? { readinessOnly } : {}) });
}

describe('agyDaemonSpawnHooks', () => {
  it('admits native-login sessions only when the agy CLI resolves, without the pinned server', async () => {
    await withIsolatedHappierHome(async (home, downloadRequest) => {
      const isolated = { PATH: home, HOME: home, USERPROFILE: home, HAPPIER_HOME_DIR: home };
      await expect(validateSpawn(isolated)).resolves.toMatchObject({ ok: false, errorMessage: expect.stringContaining('Agy CLI (agy)') });

      const agyPath = await createExecutableShim({
        dirPrefix: 'happier-agy-spawnhooks-',
        fileName: process.platform === 'win32' ? 'agy.cmd' : 'agy',
        contents: process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n',
      });
      tempDirs.add(dirname(agyPath));
      await expect(validateSpawn({ ...isolated, PATH: dirname(agyPath) })).resolves.toEqual({ ok: true });
      expect(downloadRequest).not.toHaveBeenCalled();
    });
  });

  it('admits connected accounts once the pinned server is installed, without installing it', async () => {
    await withIsolatedHappierHome(async (_home, downloadRequest) => {
      const connected = {
        HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([{ kind: 'profile', serviceId: 'antigravity', profileId: 'work' }]),
      };
      await expect(validateSpawn(connected, true)).resolves.toEqual({
        ok: false,
        reasonCode: 'agy_acp_server_unavailable',
        errorMessage: 'Agy ACP server is unavailable: Agy ACP server is not installed',
      });

      await installPinnedAgyAcpServerFixture(`#!${process.execPath}\n`);
      await expect(validateSpawn(connected, true)).resolves.toEqual({ ok: true });
      expect(downloadRequest).not.toHaveBeenCalled();
    });
  });
});
