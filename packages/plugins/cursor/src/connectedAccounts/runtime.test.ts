import { describe, expect, it } from 'vitest';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { ConnectedAccountPortableAuthenticationContext, ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { invokeConnectedAccountAuthenticationRuntime } from '../../../../cli-common/src/connectedAccounts/authenticationRuntimeDispatcher.js';
import { derivePluginAccountContributionRegistrationRights } from '../../../../protocol/src/plugins/contributions/catalog.js';
import { createPluginRegistrationScope } from '../../../../plugin-sdk/src/registration/scope.js';

import { activate } from '../activate.js';
import { PLUGIN_MANIFEST } from '../manifest.js';

function credentialStore() {
  const values = new Map<string, string>();
  return { values, store: {
    async get(key: string) { return values.get(key) ?? null; },
    async set(key: string, value: string) { values.set(key, value); },
    async delete(key: string) { values.delete(key); },
  } };
}

describe('Cursor portable account', () => {
  it('saves a manual key without vendor requests and materializes only the requested child environment', async () => {
    const kit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      const runtime = kit.registration('connectedAccountDescriptors', 'cursor-account');
      expect(runtime).toBeDefined();
      if (!runtime) throw new Error('Cursor account runtime is not registered');
      const descriptor = PLUGIN_MANIFEST.contributes.connectedAccountDescriptors?.[0];
      expect(descriptor?.authentication.modes.map(mode => mode.id)).toEqual(['api-key']);
      const target = descriptor?.authentication.account;
      if (!target) throw new Error('Cursor Account artifact is missing');
      const scope = createPluginRegistrationScope({ pluginId: PLUGIN_MANIFEST.id, target: { realm: 'account', ...target },
        rights: derivePluginAccountContributionRegistrationRights(PLUGIN_MANIFEST.contributes, target) });
      (await import('./runtime.js')).activate(scope.api);
      const [portable] = scope.commit();
      if (portable?.family !== 'connectedAccountDescriptors') throw new Error('Cursor portable runtime is not registered');
      const mode = portable.value.authentication.modes['api-key'];
      if (mode?.kind !== 'manual') throw new Error('Cursor manual mode is not registered');
      const modeDescriptor = descriptor?.authentication.modes[0];
      if (!modeDescriptor) throw new Error('Cursor manual declaration is missing');
      const staged = credentialStore();
      const service = { pluginId: PLUGIN_MANIFEST.id, localId: 'cursor-account' };
      const context = {
        plugin: { id: PLUGIN_MANIFEST.id, version: '0.0.0' },
        contribution: { id: service.localId, qualifiedId: `${service.pluginId}/${service.localId}` },
        surface: 'ui', invokedAtMs: 1, service,
        attempt: { kind: 'connect', attemptId: 'cursor-attempt' },
        configuration: { target: { kind: 'attempt', service, attemptId: 'cursor-attempt', modeId: 'api-key' }, revision: '1', values: {}, async getSecret() { return null; } },
        signal: new AbortController().signal, attemptCredentials: staged.store,
        services: { http: createPluginHttpFixture({ async request() { throw new Error('Cursor manual save must not use HTTP'); } }) },
      } satisfies ConnectedAccountPortableAuthenticationContext;
      const redactions: string[] = [];
      const submit = (token: string) => invokeConnectedAccountAuthenticationRuntime({
        mode, descriptor: modeDescriptor, operation: { kind: 'submitManual', fields: { token } }, context,
        registerRawForRedaction(value) { redactions.push(value); }, async invokeCallback(work) { return work(); },
      });
      expect(await submit('  ')).toMatchObject({ status: 'rejected' });
      expect(staged.values.size).toBe(0);
      const connected = await submit(' fake-cursor-key-B ');
      expect(connected).toMatchObject({ status: 'connected', credentialKind: 'token' });
      expect(connected).not.toHaveProperty('providerIdentity');
      expect(JSON.stringify(connected)).not.toContain('fake-cursor-key-B');
      expect(staged.values).toEqual(new Map([['apiKey', 'fake-cursor-key-B']]));
      expect(redactions).toContain(' fake-cursor-key-B ');
      const account = { service, accountId: 'saved-cursor-account' };
      expect(await mode.complete({ fields: { token: 'replacement-key' } }, {
        ...context, attempt: { kind: 'reconnect', attemptId: 'replacement-attempt', account },
      })).toMatchObject({ status: 'connected', credentialKind: 'token', accountId: account.accountId });
      await staged.store.set('apiKey', 'fake-cursor-key-B');
      const readContext = {
        ...context, account, credentials: staged.store,
        configuration: { ...context.configuration, target: { kind: 'account', account, modeId: 'api-key' } },
      // The daemon's unused services stay absent at this credential/HTTP fixture boundary.
      } as Parameters<ConnectedAccountRuntime['status']>[0];
      expect(await runtime.materialize({ kind: 'environment', keys: ['CURSOR_API_KEY', 'HOME'] }, readContext)).toEqual({
        kind: 'environment', env: { CURSOR_API_KEY: 'fake-cursor-key-B' },
      });
      expect(await runtime.materialize({ kind: 'environment', keys: ['HOME'] }, readContext)).toEqual({ kind: 'environment', env: {} });
      await expect(runtime.materialize({ kind: 'httpHeaders', origin: 'https://example.test', headerNames: ['Authorization'] }, readContext)).rejects.toThrow();
      expect(await runtime.status(readContext)).toMatchObject({ status: 'connected', credentialKind: 'token' });
      expect(await runtime.revoke(readContext)).toEqual({ status: 'remoteUnsupported' });
      await staged.store.delete('apiKey');
      expect(await runtime.status(readContext)).toMatchObject({ status: 'unavailable' });
      await expect(runtime.materialize({ kind: 'environment', keys: ['CURSOR_API_KEY'] }, readContext)).rejects.toThrow();
    } finally { await kit.dispose(); }
  });
});
