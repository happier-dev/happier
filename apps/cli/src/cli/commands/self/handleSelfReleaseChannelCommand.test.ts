import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderSystemdServiceUnit } from '@happier-dev/cli-common/service';

import { withTempDir } from '@/testkit/fs/tempDir';
import { createEnvKeyScope } from '@/testkit/env/envScope';

const {
  writeDefaultManagedReleaseChannelMock,
  syncInstalledFirstPartyShimsMock,
  resolveInstalledFirstPartyComponentPathsMock,
  runDefaultFollowingBackgroundServiceRestartFollowUpMock,
} = vi.hoisted(() => ({
  writeDefaultManagedReleaseChannelMock: vi.fn(async () => undefined),
  syncInstalledFirstPartyShimsMock: vi.fn(async () => undefined),
  resolveInstalledFirstPartyComponentPathsMock: vi.fn(),
  runDefaultFollowingBackgroundServiceRestartFollowUpMock: vi.fn(async () => false),
}));

vi.mock('@happier-dev/cli-common/firstPartyRuntime', async () => {
  const actual = await vi.importActual<typeof import('@happier-dev/cli-common/firstPartyRuntime')>('@happier-dev/cli-common/firstPartyRuntime');
  return {
    ...actual,
    writeDefaultManagedReleaseChannel: writeDefaultManagedReleaseChannelMock,
    syncInstalledFirstPartyShims: syncInstalledFirstPartyShimsMock,
    resolveInstalledFirstPartyComponentPaths: resolveInstalledFirstPartyComponentPathsMock,
  };
});

vi.mock('../backgroundServiceFollowUp.js', async () => {
  const actual = await vi.importActual<typeof import('../backgroundServiceFollowUp.js')>('../backgroundServiceFollowUp.js');
  return {
    ...actual,
    runDefaultFollowingBackgroundServiceRestartFollowUp: runDefaultFollowingBackgroundServiceRestartFollowUpMock,
  };
});

describe('handleSelfReleaseChannelCommand use', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('does not prompt to restart for invalid default-following service files', async () => {
    await withTempDir('happier-self-release-channel-invalid-service-', async (homeDir) => {
      const envScope = createEnvKeyScope([
        'HAPPIER_HOME_DIR',
        'HAPPIER_DAEMON_SERVICE_PLATFORM',
        'HAPPIER_DAEMON_SERVICE_USER_HOME_DIR',
        'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR',
        'HAPPIER_DAEMON_SERVICE_TARGET_MODE',
        'HAPPIER_DAEMON_SERVICE_CHANNEL',
        'HAPPIER_DAEMON_SERVICE_INSTANCE_ID',
      ]);
      envScope.patch({
        HAPPIER_HOME_DIR: join(homeDir, '.happier'),
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: join(homeDir, '.happier'),
        HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
        HAPPIER_DAEMON_SERVICE_CHANNEL: 'stable',
        HAPPIER_DAEMON_SERVICE_INSTANCE_ID: 'default',
      });

      try {
        mkdirSync(join(homeDir, '.happier'), { recursive: true });
        const binaryPath = join(homeDir, '.happier', 'managed-happier');
        writeFileSync(binaryPath, '#!/bin/sh\n', 'utf-8');
        resolveInstalledFirstPartyComponentPathsMock.mockReturnValue({
          binaryPath,
          shimPaths: [join(homeDir, '.happier', 'shim')],
        });

        const servicesDir = join(homeDir, '.config', 'systemd', 'user');
        mkdirSync(servicesDir, { recursive: true });
        writeFileSync(
          join(servicesDir, 'happier-daemon.default.service'),
          renderSystemdServiceUnit({
            description: 'Happier Daemon',
            execStart: ['/usr/bin/env', 'bash', '-lc', 'echo not-happier'],
            env: {
              HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
              HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
            },
            wantedBy: 'default.target',
          }),
          'utf-8',
        );

        const { handleSelfReleaseChannelCommand } = await import('./handleSelfReleaseChannelCommand.js');
        await handleSelfReleaseChannelCommand(['use', 'stable']);

        expect(writeDefaultManagedReleaseChannelMock).toHaveBeenCalledTimes(1);
        expect(syncInstalledFirstPartyShimsMock).toHaveBeenCalledTimes(1);
        expect(runDefaultFollowingBackgroundServiceRestartFollowUpMock).not.toHaveBeenCalled();
      } finally {
        envScope.restore();
      }
    });
  });
});
