import { dirname } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createExecutableShim } from '@/testkit/fs/executableShim';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

const mocks = vi.hoisted(() => ({ ensureAgyAcpServerForLaunch: vi.fn() }));
vi.mock('@/backends/agy/acp/ensureAgyAcpServerForLaunch', () => mocks);

import { agyDaemonSpawnHooks } from './spawnHooks';

const tempDirs = new Set<string>();

beforeEach(() => mocks.ensureAgyAcpServerForLaunch.mockReset());
afterEach(async () => {
  for (const dir of tempDirs) await removeTempDir(dir);
  tempDirs.clear();
});

async function validateSpawn(environmentVariables: NodeJS.ProcessEnv, readinessOnly?: boolean) {
  return await agyDaemonSpawnHooks.validateSpawn!({ environmentVariables, ...(readinessOnly ? { readinessOnly } : {}) });
}

describe('agyDaemonSpawnHooks', () => {
  it('admits native-login sessions only when the agy CLI resolves, without the pinned server', async () => {
    const home = await createTempDir('happier-agy-spawnhooks-home-');
    tempDirs.add(home);
    const isolated = { PATH: home, HOME: home, USERPROFILE: home, HAPPIER_HOME_DIR: home };
    await expect(validateSpawn(isolated)).resolves.toMatchObject({ ok: false, errorMessage: expect.stringContaining('Agy CLI (agy)') });

    const agyPath = await createExecutableShim({
      dirPrefix: 'happier-agy-spawnhooks-',
      fileName: process.platform === 'win32' ? 'agy.cmd' : 'agy',
      contents: process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n',
    });
    tempDirs.add(dirname(agyPath));
    await expect(validateSpawn({ ...isolated, PATH: dirname(agyPath) })).resolves.toEqual({ ok: true });
    expect(mocks.ensureAgyAcpServerForLaunch).not.toHaveBeenCalled();
  });

  it('admits connected accounts through the pinned server readiness', async () => {
    const connected = {
      HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([{ kind: 'profile', serviceId: 'antigravity', profileId: 'work' }]),
    };
    mocks.ensureAgyAcpServerForLaunch.mockRejectedValueOnce(new Error('Agy ACP server is unavailable: not installed'));

    await expect(validateSpawn(connected, true)).resolves.toEqual({
      ok: false,
      reasonCode: 'agy_acp_server_unavailable',
      errorMessage: 'Agy ACP server is unavailable: not installed',
    });
    expect(mocks.ensureAgyAcpServerForLaunch).toHaveBeenCalledWith({ env: connected, readinessOnly: true });
  });
});
