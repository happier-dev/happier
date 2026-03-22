import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDirSync } from '@/testkit/fs/tempDir';
import { captureConsoleText } from '@/testkit/logger/captureOutput';

describe('resolveDaemonServiceCliRuntimeFromEnv entrypoint resolution', () => {
  const envKeys = ['HAPPIER_HOME_DIR', 'HAPPIER_DAEMON_SERVICE_NODE_PATH'] as const;
  let envScope = createEnvKeyScope(envKeys);

  afterEach(() => {
    envScope.restore();
    envScope = createEnvKeyScope(envKeys);
    vi.resetModules();
  });

  it('derives the bundled entrypoint for an explicit managed js runtime wrapper path', async () => {
    withTempDirSync('happier-cli-daemon-service-entry-', (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_NODE_PATH: '/Users/test/.happier/tools/js-runtime/current/bin/happier-js-runtime',
      });

      const output = captureConsoleText();
      return import('./cli.js')
        .then(({ resolveDaemonServiceCliRuntimeFromEnv }) => {
          const runtime = resolveDaemonServiceCliRuntimeFromEnv();
          expect(runtime.nodePath).toBe('/Users/test/.happier/tools/js-runtime/current/bin/happier-js-runtime');
          expect(runtime.entryPath).toContain('/apps/cli/package-dist/index.mjs');
        })
        .finally(() => {
          output.restore();
        });
    });
  });
});
