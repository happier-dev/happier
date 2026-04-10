import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDirSync } from '@/testkit/fs/tempDir';
import { captureConsoleText } from '@/testkit/logger/captureOutput';

describe('resolveDaemonServiceCliRuntimeFromEnv', () => {
  const envKeys = [
    'HAPPIER_HOME_DIR',
    'HAPPIER_DAEMON_SERVICE_UID',
    'HAPPIER_DAEMON_SERVICE_CHANNEL',
    'HAPPIER_PUBLIC_RELEASE_CHANNEL',
  ] as const;
  let envScope = createEnvKeyScope(envKeys);

  afterEach(() => {
    envScope.restore();
    envScope = createEnvKeyScope(envKeys);
    vi.resetModules();
  });

  it('allows an explicit UID 0 from HAPPIER_DAEMON_SERVICE_UID', async () => {
    withTempDirSync('happier-cli-daemon-service-uid-', (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_UID: '0',
      });

      const output = captureConsoleText();
      return import('./cli.js')
        .then(({ resolveDaemonServiceCliRuntimeFromEnv }) => {
          const runtime = resolveDaemonServiceCliRuntimeFromEnv();
          expect(runtime.uid).toBe(0);
        })
        .finally(() => {
          output.restore();
        });
    });
  });

  it('defaults the daemon service channel to stable when env and argv do not provide one', async () => {
    withTempDirSync('happier-cli-daemon-service-channel-', (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_CHANNEL: '',
        HAPPIER_PUBLIC_RELEASE_CHANNEL: '',
      });

      const originalArgv = process.argv;
      process.argv = [originalArgv[0] ?? 'node', 'happier'];

      const output = captureConsoleText();
      return import('./cli.js')
        .then(({ resolveDaemonServiceCliRuntimeFromEnv }) => {
          const runtime = resolveDaemonServiceCliRuntimeFromEnv({
            processEnv: {
              ...process.env,
              HAPPIER_DAEMON_SERVICE_PLATFORM: 'darwin',
              HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
              HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: `${homeDir}/.happier`,
              HAPPIER_DAEMON_SERVICE_CHANNEL: '',
              HAPPIER_PUBLIC_RELEASE_CHANNEL: '',
            },
          });
          expect(runtime.channel).toBe('stable');
        })
        .finally(() => {
          process.argv = originalArgv;
          output.restore();
        });
    });
  });
});
