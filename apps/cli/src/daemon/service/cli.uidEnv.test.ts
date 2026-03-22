import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDirSync } from '@/testkit/fs/tempDir';
import { captureConsoleText } from '@/testkit/logger/captureOutput';

describe('resolveDaemonServiceCliRuntimeFromEnv', () => {
  const envKeys = ['HAPPIER_HOME_DIR', 'HAPPIER_DAEMON_SERVICE_UID'] as const;
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
});
