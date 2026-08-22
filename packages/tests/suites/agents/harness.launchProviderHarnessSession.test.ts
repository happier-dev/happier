import { describe, expect, it, vi } from 'vitest';

import type { StartedDaemon } from '../../src/testkit/daemon/daemon';
import { launchProviderHarnessSession } from '../../src/testkit/providers/harness/launchProviderHarnessSession';

describe('providers harness: daemon-runner continuity launch', () => {
  it('routes an opted-in Claude scenario through the daemon-owned runner', async () => {
    const daemon = {
      state: {
        pid: 42,
        httpPort: 4231,
        controlToken: 'daemon-token',
      },
    } as StartedDaemon;
    const spawnFromDaemon = vi.fn(async () => 'session-123');
    const spawnDirect = vi.fn(() => {
      throw new Error('direct provider CLI launch must not run for daemon-runner continuity');
    });

    await expect(launchProviderHarnessSession({
      providerId: 'claude',
      agentId: 'claude',
      providerProtocol: 'claude',
      launchViaDaemon: true,
      daemon,
      directory: '/tmp/workspace',
      existingSessionId: 'session-123',
      environmentVariables: {
        HAPPIER_HOME_DIR: '/tmp/happier',
        HAPPIER_SESSION_ATTACH_FILE: '/tmp/direct-process-only-attach.json',
      },
      spawnFromDaemon,
      spawnDirect,
    })).resolves.toEqual({ process: null });

    expect(spawnDirect).not.toHaveBeenCalled();
    expect(spawnFromDaemon).toHaveBeenCalledExactlyOnceWith({
      daemon,
      directory: '/tmp/workspace',
      agent: 'claude',
      request: {
        existingSessionId: 'session-123',
        terminal: { mode: 'plain' },
        environmentVariables: {},
      },
    });
  });
});
