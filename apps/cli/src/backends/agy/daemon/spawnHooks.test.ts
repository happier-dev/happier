import { dirname } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createExecutableShim } from '@/testkit/fs/executableShim';
import { removeTempDir, withTempDir } from '@/testkit/fs/tempDir';

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
  it('admits native-login sessions only when the agy CLI resolves', async () => {
    await withTempDir('happier-agy-native-', async (home) => {
      const isolated = { PATH: home, HOME: home, USERPROFILE: home, HAPPIER_HOME_DIR: home };
      await expect(validateSpawn(isolated)).resolves.toMatchObject({ ok: false, errorMessage: expect.stringContaining('Agy CLI (agy)') });

      const agyPath = await createExecutableShim({
        dirPrefix: 'happier-agy-spawnhooks-',
        fileName: process.platform === 'win32' ? 'agy.cmd' : 'agy',
        contents: process.platform === 'win32'
          ? '@echo off\r\nif "%1 %2"=="acp --help" echo Usage: agy acp [flags]\r\n'
          : '#!/bin/sh\nif [ "$*" = "acp --help" ]; then printf "%s\\n" "Usage: agy acp [flags]"; fi\n',
      });
      tempDirs.add(dirname(agyPath));
      await expect(validateSpawn({ ...isolated, PATH: dirname(agyPath) })).resolves.toEqual({ ok: true });
    });
  });

  it('rejects an installed native CLI which does not support the ACP subcommand', async () => {
    await withTempDir('happier-agy-native-', async (home) => {
      const agyPath = await createExecutableShim({
        dirPrefix: 'happier-agy-pre-acp-',
        fileName: process.platform === 'win32' ? 'agy.cmd' : 'agy',
        contents: process.platform === 'win32' ? '@echo off\r\nexit /b 1\r\n' : '#!/bin/sh\nexit 1\n',
      });
      tempDirs.add(dirname(agyPath));
      await expect(validateSpawn({
        PATH: dirname(agyPath), HOME: home, USERPROFILE: home, HAPPIER_HOME_DIR: home,
      }, true)).resolves.toMatchObject({ ok: false, errorMessage: expect.stringContaining('agy update') });
    });
  });

  it('admits connected accounts through the same native CLI check', async () => {
    await withTempDir('happier-agy-connected-', async (home) => {
      const agyPath = await createExecutableShim({
        dirPrefix: 'happier-agy-connected-cli-',
        fileName: process.platform === 'win32' ? 'agy.cmd' : 'agy',
        contents: process.platform === 'win32'
          ? '@echo off\r\nif "%1 %2"=="acp --help" echo Usage: agy acp [flags]\r\n'
          : '#!/bin/sh\nif [ "$*" = "acp --help" ]; then printf "%s\\n" "Usage: agy acp [flags]"; fi\n',
      });
      tempDirs.add(dirname(agyPath));
      const connected = {
        PATH: home, HOME: home, USERPROFILE: home, HAPPIER_HOME_DIR: home,
        HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([{ kind: 'profile', serviceId: 'antigravity', profileId: 'work' }]),
      };
      await expect(validateSpawn(connected, true)).resolves.toMatchObject({ ok: false, errorMessage: expect.stringContaining('Agy CLI (agy)') });
      await expect(validateSpawn({ ...connected, PATH: dirname(agyPath) }, true)).resolves.toEqual({ ok: true });
    });
  });
});
