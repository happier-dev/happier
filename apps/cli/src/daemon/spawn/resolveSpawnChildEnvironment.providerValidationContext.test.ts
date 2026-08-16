import { describe, expect, it, vi } from 'vitest';

import { resolveSpawnChildEnvironment } from './resolveSpawnChildEnvironment';

describe('resolveSpawnChildEnvironment provider validation context', () => {
  it('validates against the effective session directory and child environment', async () => {
    const validateSpawn = vi.fn(async () => ({ ok: true as const }));

    const result = await resolveSpawnChildEnvironment({
      options: {
        directory: 'C:\\workspace',
        backendTarget: { kind: 'builtInAgent', agentId: 'pi' },
      },
      profileEnvironmentVariables: { ProgramFiles: 'C:\\Program Files' },
      daemonSpawnHooks: { validateSpawn },
      processEnv: { PATH: 'C:\\Windows\\System32', USERPROFILE: 'C:\\Users\\alice' },
      connectedServiceAuth: {
        env: { PI_CODING_AGENT_DIR: 'C:\\happier\\pi-agent' },
        cleanupOnFailure: null,
        cleanupOnExit: null,
      },
      logDebug: () => {},
      logInfo: () => {},
      logWarn: () => {},
    });

    expect(result.ok).toBe(true);
    expect(validateSpawn).toHaveBeenCalledWith(expect.objectContaining({
      directory: 'C:\\workspace',
      environmentVariables: expect.objectContaining({
        PATH: 'C:\\Windows\\System32',
        USERPROFILE: 'C:\\Users\\alice',
        ProgramFiles: 'C:\\Program Files',
        PI_CODING_AGENT_DIR: 'C:\\happier\\pi-agent',
      }),
    }));
  });
});
