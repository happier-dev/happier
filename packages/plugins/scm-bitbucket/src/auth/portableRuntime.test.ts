import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { ConnectedAccountAuthenticationContext, ConnectedAccountPortableReadContext, ConnectedAccountPortableRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { describe, expect, it } from 'vitest';
import { BITBUCKET_PLUGIN } from '../manifest.js';
import { activate as activateAccount } from '../accountRuntime.js';

describe('portable Connected Account runtime', () => {
  it('registers the actual Account artifact and completes and materializes the selected credential without a Machine', async () => {
    const runtimes: ConnectedAccountPortableRuntime[] = [];
    const requests: string[] = [];
    const kit = await createPluginTestkit({ manifest: BITBUCKET_PLUGIN.manifest,
      module: { activate: BITBUCKET_PLUGIN.activate, activateAccount(api) {
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
      expect(BITBUCKET_PLUGIN.manifest.contributes.connectedAccountDescriptors.find(d => d.id === 'bitbucket-account')?.authentication.account)
        .toEqual({ artifactId: 'bitbucket-account-runtime', exportName: 'activate' });
      const store = new Map<string, string>();
      const service = { pluginId: BITBUCKET_PLUGIN.manifest.id, localId: 'bitbucket-account' };
      const account = { service, accountId: 'selected-account' };
      const context = {
        plugin: { id: service.pluginId, version: '0.0.0' },
        contribution: { id: service.localId, qualifiedId: service.pluginId + '/' + service.localId },
        surface: 'ui', invokedAtMs: 1, signal: new AbortController().signal, service,
        attempt: { kind: 'connect', attemptId: 'portable-attempt' },
        configuration: { target: { kind: 'account', account, modeId: 'manual' }, revision: '1',
          values: {}, async getSecret() { return null; } },
        attemptCredentials: {
          async get(key: string) { return store.get(key) ?? null; },
          async set(key: string, value: string) { store.set(key, value); },
          async delete(key: string) { store.delete(key); },
        },
        services: { http: createPluginHttpFixture({ async request(input) {
          requests.push(input.url);
          expect(input.headers?.Authorization).toBe('Basic Zml4dHVyZUBleGFtcGxlLnRlc3Q6Zml4dHVyZS10b2tlbg==');
          expect(input.redirect).toBe('error');
          return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({"uuid":"{9f1c2a44-5d0e-4c8b-8b0a-1d7e6f3a2c19}","nickname":"fixture-user"})) };
        } }) },
      } satisfies ConnectedAccountAuthenticationContext;
      const mode = runtime.authentication.modes['manual'];
      if (mode?.kind !== 'manual') throw new Error('Missing portable manual mode');
      expect(await mode.complete({ fields: {"identity":"fixture@example.test","token":"fixture-token"} }, context)).toMatchObject({ status: 'connected' });
      const readContext = { plugin: context.plugin, contribution: context.contribution, surface: 'ui',
        invokedAtMs: 1, signal: context.signal, account, services: context.services,
        configuration: context.configuration, credentials: context.attemptCredentials,
      } satisfies ConnectedAccountPortableReadContext;
      if (runtime.materialize === undefined) throw new Error('Missing portable materialization');
      expect(await runtime.materialize({ kind: 'httpHeaders', origin: 'https://api.bitbucket.org', headerNames: ['authorization'] }, readContext))
        .toEqual({ kind: 'httpHeaders', headers: { Authorization: 'Basic Zml4dHVyZUBleGFtcGxlLnRlc3Q6Zml4dHVyZS10b2tlbg==' } });
      // Completion reads provider identity once; local materialization performs no provider reads.
      expect(requests).toHaveLength(1);
    } finally { await kit.dispose(); }
  });
});
