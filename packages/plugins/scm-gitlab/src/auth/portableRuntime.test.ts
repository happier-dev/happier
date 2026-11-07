import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { ConnectedAccountAuthenticationContext, ConnectedAccountPortableReadContext, ConnectedAccountPortableRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { describe, expect, it } from 'vitest';
import { GITLAB_PLUGIN } from '../manifest.js';
import { activate as activateAccount } from '../accountRuntime.js';

describe('portable Connected Account runtime', () => {
  it('registers the actual Account artifact and completes and materializes the selected credential without a Machine', async () => {
    const runtimes: ConnectedAccountPortableRuntime[] = [];
    const requests: string[] = [];
    const kit = await createPluginTestkit({ manifest: GITLAB_PLUGIN.manifest,
      module: { activate: GITLAB_PLUGIN.activate, activateAccount(api) {
        activateAccount({ ...api, connectedAccounts: { register(id, runtime) {
          // Observe the public host registration boundary while forwarding its real admission.
          runtimes.push(runtime);
          api.connectedAccounts.register(id, runtime);
        } } });
      } },
    });
    try {
      expect(runtimes).toHaveLength(1);
      const runtime = runtimes[0];
      if (runtime === undefined) throw new Error('Missing portable credential runtime');
      expect(GITLAB_PLUGIN.manifest.contributes.connectedAccountDescriptors.find(d => d.id === 'gitlab-account')?.authentication.account)
        .toEqual({ artifactId: 'gitlab-account-runtime', exportName: 'activate' });
      const store = new Map<string, string>();
      const service = { pluginId: GITLAB_PLUGIN.manifest.id, localId: 'gitlab-account' };
      const account = { service, accountId: 'selected-account' };
      const context = {
        plugin: { id: service.pluginId, version: '0.0.0' },
        contribution: { id: service.localId, qualifiedId: service.pluginId + '/' + service.localId },
        surface: 'ui', invokedAtMs: 1, signal: new AbortController().signal, service,
        attempt: { kind: 'connect', attemptId: 'portable-attempt' },
        configuration: { target: { kind: 'account', account, modeId: 'personal-access-token' }, revision: '1',
          values: {"baseUrl":"https://gitlab.com"}, async getSecret() { return null; } },
        attemptCredentials: {
          async get(key: string) { return store.get(key) ?? null; },
          async set(key: string, value: string) { store.set(key, value); },
          async delete(key: string) { store.delete(key); },
        },
        services: { http: createPluginHttpFixture({ async request(input) {
          requests.push(input.url);
          expect(input.headers?.Authorization).toBe('Bearer fixture-token');
          expect(input.redirect).toBe('error');
          return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({"id":42,"username":"fixture-user"})) };
        } }) },
      } satisfies ConnectedAccountAuthenticationContext;
      const mode = runtime.authentication.modes['personal-access-token'];
      if (mode?.kind !== 'manual') throw new Error('Missing portable manual mode');
      expect(await mode.complete({ fields: {"token":"fixture-token"} }, context)).toMatchObject({ status: 'connected' });
      const readContext = { plugin: context.plugin, contribution: context.contribution, surface: 'ui',
        invokedAtMs: 1, signal: context.signal, account, services: context.services,
        configuration: context.configuration, credentials: context.attemptCredentials,
      } satisfies ConnectedAccountPortableReadContext;
      if (runtime.materialize === undefined) throw new Error('Missing portable materialization');
      expect(await runtime.materialize({ kind: 'httpHeaders', origin: 'https://gitlab.com', headerNames: ['authorization'] }, readContext))
        .toEqual({ kind: 'httpHeaders', headers: { Authorization: 'Bearer fixture-token' } });
      // Completion reads provider identity once; local materialization performs no provider reads.
      expect(requests).toHaveLength(1);
    } finally { await kit.dispose(); }
  });
});
