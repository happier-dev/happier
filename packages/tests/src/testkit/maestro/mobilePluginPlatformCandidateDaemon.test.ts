import { describe, expect, it } from 'vitest';

import {
  assertMobilePluginCandidateDaemonPreflight,
  buildMobilePluginCandidateDaemonEnv,
} from './mobilePluginPlatformCandidateDaemon';

describe('mobile Plugin Platform candidate daemon isolation', () => {
  it('removes inherited stack relay authority while preserving the isolated runtime contract', () => {
    const env = buildMobilePluginCandidateDaemonEnv({
      baseEnv: {
        HAPPIER_STACK_STACK: 'inherited-stack',
        HAPPY_STACK_REPO_DIR: '/tmp/inherited-stack',
        HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'stack_inherited',
        HAPPIER_ACTIVE_SERVER_ID: 'inherited-server',
        HAPPIER_E2E_PASSTHROUGH: 'preserved',
      },
      happyHomeDir: '/tmp/isolated-home',
      serverUrl: 'http://127.0.0.1:41001',
      webappUrl: 'http://127.0.0.1:41001',
    });
    expect(env).toMatchObject({
      HAPPIER_HOME_DIR: '/tmp/isolated-home',
      HAPPIER_SERVER_URL: 'http://127.0.0.1:41001',
      HAPPIER_WEBAPP_URL: 'http://127.0.0.1:41001',
      HAPPIER_VARIANT: 'dev',
      HAPPIER_DISABLE_CAFFEINATE: '1',
      HAPPIER_E2E_PASSTHROUGH: 'preserved',
    });
    expect(env).not.toHaveProperty('HAPPIER_STACK_STACK');
    expect(env).not.toHaveProperty('HAPPY_STACK_REPO_DIR');
    expect(env).not.toHaveProperty('HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID');
    expect(env).not.toHaveProperty('HAPPIER_ACTIVE_SERVER_ID');
  });

  it('accepts only a stopped daemon bound to the expected isolated server', () => {
    expect(assertMobilePluginCandidateDaemonPreflight({
      expectedServerUrl: 'http://127.0.0.1:41001',
      status: {
        server: {
          activeServerId: 'env_1234',
          serverUrl: 'http://127.0.0.1:41001',
          comparableKey: 'http://localhost:41001',
        },
        daemon: { running: false },
        service: { running: false },
      },
    })).toEqual({
      activeServerId: 'env_1234',
      serverUrl: 'http://127.0.0.1:41001',
      comparableKey: 'http://localhost:41001',
    });

    expect(() => assertMobilePluginCandidateDaemonPreflight({
      expectedServerUrl: 'http://127.0.0.1:41001',
      status: {
        server: {
          activeServerId: 'inherited-server',
          serverUrl: 'http://127.0.0.1:52753',
          comparableKey: 'http://localhost:52753',
        },
        daemon: { running: false },
        service: { running: false },
      },
    })).toThrow(/isolated server identity/i);

    expect(() => assertMobilePluginCandidateDaemonPreflight({
      expectedServerUrl: 'http://127.0.0.1:41001',
      status: {
        server: {
          activeServerId: 'env_1234',
          serverUrl: 'http://127.0.0.1:41001',
          comparableKey: 'http://localhost:41001',
        },
        daemon: { running: true },
        service: { running: false },
      },
    })).toThrow(/already-running daemon/i);
  });
});
