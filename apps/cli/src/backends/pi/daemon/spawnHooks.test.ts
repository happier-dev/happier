import { describe, expect, it, vi } from 'vitest';

import { validatePiDaemonSpawn } from './spawnHooks';

describe('validatePiDaemonSpawn', () => {
  it('fails admission with the shell-bridge remediation when Pi cannot resolve Bash', async () => {
    const resolveAvailability = vi.fn(() => ({
      available: false as const,
      reason: 'bash_not_found' as const,
      errorMessage: 'Install Git for Windows or set shellPath in Pi settings.json.',
      searchedPaths: ['C:\\Program Files\\Git\\bin\\bash.exe'],
    }));

    const result = await validatePiDaemonSpawn({
      directory: 'C:\\workspace',
      environmentVariables: { PI_CODING_AGENT_DIR: 'C:\\happier\\pi-agent' },
    }, resolveAvailability);

    expect(resolveAvailability).toHaveBeenCalledWith({
      directory: 'C:\\workspace',
      environmentVariables: { PI_CODING_AGENT_DIR: 'C:\\happier\\pi-agent' },
    });
    expect(result).toEqual({
      ok: false,
      reasonCode: 'pi_shell_bridge_unavailable',
      errorMessage: 'Install Git for Windows or set shellPath in Pi settings.json.',
    });
  });

  it('admits Pi when its shell bridge is available', async () => {
    const result = await validatePiDaemonSpawn({}, () => ({
      available: true,
      shellPath: null,
      source: 'non_windows',
    }));

    expect(result).toEqual({ ok: true });
  });
});
