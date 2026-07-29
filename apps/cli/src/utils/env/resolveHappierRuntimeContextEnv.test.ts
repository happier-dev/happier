import { describe, expect, it } from 'vitest';

import {
  HAPPIER_RUNTIME_CONTEXT_ENV_KEYS,
  resolveHappierRuntimeContextEnv,
} from './resolveHappierRuntimeContextEnv';

describe('resolveHappierRuntimeContextEnv', () => {
  it('returns only HAPPIER_HOME_DIR when given just a home dir', () => {
    expect(resolveHappierRuntimeContextEnv({ homeDir: '/home/.happier' })).toEqual({
      HAPPIER_HOME_DIR: '/home/.happier',
    });
  });

  it('sets a single HAPPIER_SERVER_URL for a non-split stack (api === canonical) and omits local/public', () => {
    const env = resolveHappierRuntimeContextEnv({
      homeDir: '/home/.happier',
      server: {
        activeServerId: 'cloud',
        canonicalServerUrl: 'https://api.happier.dev',
        apiServerUrl: 'https://api.happier.dev',
        webappUrl: 'https://app.happier.dev',
      },
    });

    expect(env).toEqual({
      HAPPIER_HOME_DIR: '/home/.happier',
      HAPPIER_ACTIVE_SERVER_ID: 'cloud',
      HAPPIER_SERVER_URL: 'https://api.happier.dev',
      HAPPIER_WEBAPP_URL: 'https://app.happier.dev',
    });
    expect(env).not.toHaveProperty('HAPPIER_LOCAL_SERVER_URL');
    expect(env).not.toHaveProperty('HAPPIER_PUBLIC_SERVER_URL');
  });

  it('expresses a split local/public stack: SERVER=local, LOCAL=local, PUBLIC=canonical', () => {
    const env = resolveHappierRuntimeContextEnv({
      homeDir: '/home/.happier',
      daemonLifecycleScopeId: 'stack_repo-current__id_default',
      server: {
        activeServerId: 'stack-a',
        canonicalServerUrl: 'http://127.0.0.1:13155',
        apiServerUrl: 'http://127.0.0.1:3005',
        webappUrl: 'http://127.0.0.1:13155',
      },
    });

    expect(env).toEqual({
      HAPPIER_HOME_DIR: '/home/.happier',
      HAPPIER_ACTIVE_SERVER_ID: 'stack-a',
      HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'stack_repo-current__id_default',
      HAPPIER_SERVER_URL: 'http://127.0.0.1:3005',
      HAPPIER_LOCAL_SERVER_URL: 'http://127.0.0.1:3005',
      HAPPIER_PUBLIC_SERVER_URL: 'http://127.0.0.1:13155',
      HAPPIER_WEBAPP_URL: 'http://127.0.0.1:13155',
    });
  });

  it('ignores empty/whitespace values and returns an empty map for empty input', () => {
    expect(resolveHappierRuntimeContextEnv({ homeDir: '   ' })).toEqual({});
    expect(resolveHappierRuntimeContextEnv({})).toEqual({});
    expect(
      resolveHappierRuntimeContextEnv({
        homeDir: '/home/.happier',
        server: {
          activeServerId: '',
          canonicalServerUrl: '',
          apiServerUrl: '',
          webappUrl: '',
        },
      }),
    ).toEqual({ HAPPIER_HOME_DIR: '/home/.happier' });
  });

  it('falls back to the api URL for HAPPIER_SERVER_URL when only the api URL is known', () => {
    const env = resolveHappierRuntimeContextEnv({
      server: {
        activeServerId: 'cloud',
        canonicalServerUrl: '',
        apiServerUrl: 'https://api.happier.dev',
        webappUrl: '',
      },
    });
    expect(env).toEqual({
      HAPPIER_ACTIVE_SERVER_ID: 'cloud',
      HAPPIER_SERVER_URL: 'https://api.happier.dev',
    });
  });

  it('never emits secret-bearing keys', () => {
    const env = resolveHappierRuntimeContextEnv({
      homeDir: '/home/.happier',
      server: {
        activeServerId: 'cloud',
        canonicalServerUrl: 'https://api.happier.dev',
        apiServerUrl: 'https://api.happier.dev',
        webappUrl: 'https://app.happier.dev',
      },
    });
    for (const key of Object.keys(env)) {
      expect(HAPPIER_RUNTIME_CONTEXT_ENV_KEYS).toContain(key);
    }
    expect(env).not.toHaveProperty('HAPPIER_ACCESS_TOKEN');
  });
});
