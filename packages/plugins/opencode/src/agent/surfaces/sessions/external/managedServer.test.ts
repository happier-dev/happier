import { describe, expect, it } from 'vitest';

import {
  OPENCODE_DATA_ROOT_OVERRIDE_ENV_KEYS,
} from '../../../runtime/server/spawnSpec.js';
import {
  OPENCODE_EXTERNAL_SESSIONS_SERVICE_ID,
  resolveOpenCodeExternalSessionsManagedService,
} from './managedServer.js';

const signal = new AbortController().signal;

describe('OpenCode External Sessions managed server declaration', () => {
  it('declares an authenticated owned server for the default managed-endpoint source', () => {
    const spec = resolveOpenCodeExternalSessionsManagedService({
      source: { kind: 'opencodeServer', managedEndpoint: true },
      signal,
    });

    expect(spec).toMatchObject({
      id: OPENCODE_EXTERNAL_SESSIONS_SERVICE_ID,
      mode: { kind: 'spawn' },
      clientAccess: {
        kind: 'hostBasic',
        username: 'opencode',
        injectPasswordEnvironmentKey: 'OPENCODE_SERVER_PASSWORD',
      },
    });
    expect(spec?.mode.kind === 'spawn' ? spec.mode.launch.args : null)
      .toEqual(['serve', '--hostname', '127.0.0.1']);
  });

  it('never repoints the owned server away from the user OpenCode data root', () => {
    const spec = resolveOpenCodeExternalSessionsManagedService({
      source: { kind: 'opencodeServer', managedEndpoint: true },
      signal,
    });
    const launchEnv = spec?.mode.kind === 'spawn' ? spec.mode.launch.env ?? {} : {};

    // The host replaces rather than merges the child environment, and OpenCode
    // resolves its database under `XDG_DATA_HOME ?? os.homedir()`. Any of these
    // keys in the launch environment silently yields an empty corpus instead of
    // the user's sessions.
    for (const key of OPENCODE_DATA_ROOT_OVERRIDE_ENV_KEYS) {
      expect(launchEnv).not.toHaveProperty(key);
    }
    expect(launchEnv).toMatchObject({ OPENCODE_DISABLE_PRUNE: '1' });
  });

  it('attaches to a user existing server through the same managed-service owner', () => {
    // A server the user runs must not be duplicated by a competing owned one,
    // but it is still reached the one way every OpenCode server is reached: a
    // managed service whose credential the host resolves and applies.
    const spec = resolveOpenCodeExternalSessionsManagedService({
      source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4096' },
      signal,
    });

    expect(spec).toMatchObject({
      mode: { kind: 'attach', baseUrl: 'http://127.0.0.1:4096' },
      healthCheck: { kind: 'http', target: { kind: 'servicePath', path: '/global/health' } },
      clientAccess: {
        kind: 'declaredSecretBasic',
        username: 'opencode',
        passwordSecretId: 'opencodeServerPassword',
      },
    });
    expect(spec?.id).not.toBe(OPENCODE_EXTERNAL_SESSIONS_SERVICE_ID);
  });

  it('keeps two attached servers on distinct managed-service entries', () => {
    const first = resolveOpenCodeExternalSessionsManagedService({
      source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4096' },
      signal,
    });
    const second = resolveOpenCodeExternalSessionsManagedService({
      source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4097' },
      signal,
    });

    expect(first?.id).not.toEqual(second?.id);
    expect(resolveOpenCodeExternalSessionsManagedService({
      source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4096' },
      signal,
    })?.id).toEqual(first?.id);
  });

  it('normalizes an attached endpoint before deriving its managed-service identity', () => {
    const first = resolveOpenCodeExternalSessionsManagedService({
      source: {
        kind: 'opencodeServer',
        baseUrl: 'https://OpenCode.Example.test:443/first?ignored=1#ignored',
      },
      signal,
    });
    const sameOrigin = resolveOpenCodeExternalSessionsManagedService({
      source: { kind: 'opencodeServer', baseUrl: 'https://opencode.example.test/first' },
      signal,
    });
    const differentPort = resolveOpenCodeExternalSessionsManagedService({
      source: { kind: 'opencodeServer', baseUrl: 'https://opencode.example.test:444/' },
      signal,
    });
    const differentScheme = resolveOpenCodeExternalSessionsManagedService({
      source: { kind: 'opencodeServer', baseUrl: 'http://localhost:4096/' },
      signal,
    });

    expect(first?.mode).toEqual({ kind: 'attach', baseUrl: 'https://opencode.example.test/first' });
    expect(first?.id).toEqual(sameOrigin?.id);
    expect(first?.id).not.toEqual(differentPort?.id);
    expect(first?.id).not.toEqual(differentScheme?.id);
  });

  it('declares no service for a source another Agent owns', () => {
    expect(resolveOpenCodeExternalSessionsManagedService({
      source: { kind: 'claudeCode' },
      signal,
    })).toBeNull();
  });
});
