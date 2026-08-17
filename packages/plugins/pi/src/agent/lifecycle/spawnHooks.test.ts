import { describe, expect, it, vi } from 'vitest';

import { resolvePiDaemonSpawnPrerequisites } from './spawnHooks.js';

describe('Pi daemon spawn prerequisites', () => {
  it('fails admission with actionable remediation when the shell bridge is unavailable', async () => {
    const resolveAvailability = vi.fn(() => ({
      available: false as const,
      reason: 'bash_not_found' as const,
      errorMessage: 'Install Git for Windows or set shellPath in Pi settings.json.',
      searchedPaths: ['C:\\Program Files\\Git\\bin\\bash.exe'],
    }));

    await expect(resolvePiDaemonSpawnPrerequisites({
      payload: {
        cwd: 'C:\\workspace',
        runtimeSelection: {
          env: { PI_CODING_AGENT_DIR: 'C:\\happier\\pi-agent' },
        },
      },
    }, undefined, resolveAvailability)).resolves.toEqual({
      decision: 'deny',
      reasonCode: 'pi_shell_bridge_unavailable',
      errorMessage: 'Install Git for Windows or set shellPath in Pi settings.json.',
    });

    expect(resolveAvailability).toHaveBeenCalledWith({
      directory: 'C:\\workspace',
      env: expect.objectContaining({
        PI_CODING_AGENT_DIR: 'C:\\happier\\pi-agent',
      }),
      includeProjectSettings: true,
    });
  });

  it('allows admission when Pi can resolve its shell bridge', async () => {
    await expect(resolvePiDaemonSpawnPrerequisites({}, undefined, () => ({
      available: true,
      shellPath: null,
      source: 'non_windows',
    }))).resolves.toEqual({ decision: 'allow' });
  });
});
