import { afterEach, describe, expect, it, vi } from 'vitest';

import { createExecutableShim } from '@/testkit/fs/executableShim';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { dirname } from 'node:path';

import { validatePiDaemonSpawn } from './spawnHooks';

const tempDirs = new Set<string>();

afterEach(async () => {
  for (const dir of tempDirs) await removeTempDir(dir);
  tempDirs.clear();
});

async function createPiEnv(overrides: NodeJS.ProcessEnv = {}): Promise<NodeJS.ProcessEnv> {
  const piPath = await createExecutableShim({
    dirPrefix: 'happier-pi-spawnhooks-',
    fileName: process.platform === 'win32' ? 'pi.cmd' : 'pi',
    contents: process.platform === 'win32' ? '@echo off\r\necho ok\r\n' : '#!/bin/sh\necho ok\n',
  });
  tempDirs.add(dirname(piPath));
  return { PATH: dirname(piPath), ...overrides };
}

describe('validatePiDaemonSpawn', () => {
  it('refuses admission before probing the shell bridge when the Pi CLI is not resolvable', async () => {
    const home = await createTempDir('happier-pi-spawnhooks-home-');
    tempDirs.add(home);
    const resolveAvailability = vi.fn(() => ({ available: true as const, shellPath: null, source: 'non_windows' as const }));

    const result = await validatePiDaemonSpawn({
      environmentVariables: { PATH: home, HOME: home, USERPROFILE: home, HAPPIER_HOME_DIR: home },
    }, resolveAvailability);

    expect(result.ok).toBe(false);
    expect(resolveAvailability).not.toHaveBeenCalled();
  });

  it('fails admission with the shell-bridge remediation when Pi cannot resolve Bash', async () => {
    const resolveAvailability = vi.fn(() => ({
      available: false as const,
      reason: 'bash_not_found' as const,
      errorMessage: 'Install Git for Windows or set shellPath in Pi settings.json.',
      searchedPaths: ['C:\\Program Files\\Git\\bin\\bash.exe'],
    }));

    const environmentVariables = await createPiEnv({ PI_CODING_AGENT_DIR: 'C:\\happier\\pi-agent' });
    const result = await validatePiDaemonSpawn({
      directory: 'C:\\workspace',
      environmentVariables,
    }, resolveAvailability);

    expect(resolveAvailability).toHaveBeenCalledWith({
      directory: 'C:\\workspace',
      environmentVariables,
    });
    expect(result).toEqual({
      ok: false,
      reasonCode: 'pi_shell_bridge_unavailable',
      errorMessage: 'Install Git for Windows or set shellPath in Pi settings.json.',
    });
  });

  it('admits Pi when its shell bridge is available', async () => {
    const result = await validatePiDaemonSpawn({ environmentVariables: await createPiEnv() }, () => ({
      available: true,
      shellPath: null,
      source: 'non_windows',
    }));

    expect(result).toEqual({ ok: true });
  });
});
