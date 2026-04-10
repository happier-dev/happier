import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDirSync } from '@/testkit/fs/tempDir';
import { captureConsoleText } from '@/testkit/logger/captureOutput';

describe('resolveDaemonServiceCliRuntimeFromEnv entrypoint resolution', () => {
  const envKeys = [
    'HAPPIER_HOME_DIR',
    'HAPPIER_DAEMON_SERVICE_NODE_PATH',
    'HAPPIER_DAEMON_SERVICE_ENTRY_PATH',
    'HAPPIER_PUBLIC_RELEASE_CHANNEL',
    'HAPPIER_RELEASE_RING',
    'HAPPIER_RELEASE_CHANNEL',
    'HAPPIER_DAEMON_SERVICE_CHANNEL',
  ] as const;
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

  it('infers the preview release channel from a managed preview entry path when re-execed through node', async () => {
    withTempDirSync('happier-cli-daemon-service-preview-ring-', (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_PUBLIC_RELEASE_CHANNEL: '',
        HAPPIER_RELEASE_RING: '',
        HAPPIER_RELEASE_CHANNEL: '',
        HAPPIER_DAEMON_SERVICE_CHANNEL: '',
      });

      const originalArgv = [...process.argv];
      process.argv = [
        '/Users/test/.happier/tools/js-runtime/current/runtime/bin/node',
        '/Users/test/.happier/cli-preview/versions/0.2.3/package-dist/index.mjs',
        'service',
        'install',
      ];

      const output = captureConsoleText();
      return import('./cli.js')
        .then(({ resolveDaemonServiceCliRuntimeFromEnv }) => {
          const runtime = resolveDaemonServiceCliRuntimeFromEnv();
          expect(runtime.channel).toBe('preview');
        })
        .finally(() => {
          process.argv = originalArgv;
          output.restore();
        });
    });
  });

  it('infers the public dev release channel from an explicit managed dev entry path when argv no longer carries the lane', async () => {
    withTempDirSync('happier-cli-daemon-service-dev-ring-', (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_NODE_PATH: '/Users/test/.happier/tools/js-runtime/current/bin/happier-js-runtime',
        HAPPIER_DAEMON_SERVICE_ENTRY_PATH: '/Users/test/.happier/cli-dev/versions/0.2.3/package-dist/index.mjs',
        HAPPIER_PUBLIC_RELEASE_CHANNEL: '',
        HAPPIER_RELEASE_RING: '',
        HAPPIER_RELEASE_CHANNEL: '',
        HAPPIER_DAEMON_SERVICE_CHANNEL: '',
      });

      const originalArgv = [...process.argv];
      process.argv = [
        '/Users/test/.happier/tools/js-runtime/current/bin/happier-js-runtime',
        'service',
        'install',
      ];

      const output = captureConsoleText();
      return import('./cli.js')
        .then(({ resolveDaemonServiceCliRuntimeFromEnv }) => {
          const runtime = resolveDaemonServiceCliRuntimeFromEnv();
          expect(runtime.channel).toBe('publicdev');
        })
        .finally(() => {
          process.argv = originalArgv;
          output.restore();
        });
    });
  });
});
