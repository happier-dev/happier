import { describe, expect, it } from 'vitest';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { ConnectedAccountPortableAuthenticationContext, ConnectedAccountPortableRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { activateAccount } from './accountRuntime.js';
import { DOCKER_ACCOUNT_SERVICE } from './machine/dockerAccount.js';
import { DOCKER_SANDBOXES_PLUGIN } from './manifest.js';

describe('Docker portable Connected Account authentication', () => {
  it('declares the Account artifact used to connect Docker without a Machine', () => {
    const descriptor = DOCKER_SANDBOXES_PLUGIN.manifest.contributes.connectedAccountDescriptors
      ?.find(descriptor => descriptor.id === 'docker');
    expect(descriptor?.authentication?.account).toEqual({ artifactId: 'account-runtime', exportName: 'activateAccount' });
  });

  it('connects through the declared portable artifact and stages the existing PAT credential', async () => {
    const portableRuntimes = new Map<string, ConnectedAccountPortableRuntime>();
    const kit = await createPluginTestkit({ manifest: DOCKER_SANDBOXES_PLUGIN.manifest,
      module: { activate: DOCKER_SANDBOXES_PLUGIN.activate, activateAccount(api) {
        activateAccount({ ...api, connectedAccounts: { register(localId, value) {
          portableRuntimes.set(localId, value);
          return api.connectedAccounts.register(localId, value);
        } } });
      } },
    });
    try {
      const mode = portableRuntimes.get(DOCKER_ACCOUNT_SERVICE.localId)?.authentication.modes.pat;
      expect(mode?.kind).toBe('manual');
      if (mode?.kind !== 'manual') throw new Error('Missing portable Docker PAT authentication');
      const staged = new Map<string, string>();
      // HTTP and the host-owned credential store are external boundaries.
      const http = createPluginHttpFixture({ async request() { throw new Error('Unexpected provider request'); } });
      const context = {
        plugin: { id: DOCKER_SANDBOXES_PLUGIN.manifest.id, version: DOCKER_SANDBOXES_PLUGIN.manifest.version },
        contribution: { id: DOCKER_ACCOUNT_SERVICE.localId,
          qualifiedId: `${DOCKER_ACCOUNT_SERVICE.pluginId}/${DOCKER_ACCOUNT_SERVICE.localId}` },
        surface: 'ui', invokedAtMs: 1, service: DOCKER_ACCOUNT_SERVICE, signal: new AbortController().signal,
        services: { http }, attempt: { kind: 'connect', attemptId: 'docker-connect' },
        configuration: { target: { kind: 'attempt', service: DOCKER_ACCOUNT_SERVICE, modeId: 'pat', attemptId: 'docker-connect' },
          revision: 'config-1', values: { username: 'docker-user' }, async getSecret() { return null; } },
        attemptCredentials: {
          async get(key) { return staged.get(key) ?? null; },
          async set(key, value) { staged.set(key, value); },
          async delete(key) { staged.delete(key); },
        },
      } satisfies ConnectedAccountPortableAuthenticationContext;
      expect(await mode.complete({ fields: { token: 'private-docker-pat' } }, context))
        .toEqual({ status: 'connected', displayName: 'docker-user', scopes: [] });
      expect(staged.get('token')).toBe('private-docker-pat');
    } finally { await kit.dispose(); }
  });
});
