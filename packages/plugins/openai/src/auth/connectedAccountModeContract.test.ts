import { describe, expect, it, vi } from 'vitest';

import type { ConnectedAccountRuntime as PluginConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';

import { activate } from '../activate.js';
import { PLUGIN_MANIFEST } from '../manifest.js';

function credentialStore(values = new Map<string, string>()) {
  return {
    values,
    store: {
      async get(key: string) { return values.get(key) ?? null; },
      async set(key: string, value: string) { values.set(key, value); },
      async delete(key: string) { values.delete(key); },
    },
  };
}

describe('OpenAI API-key Connected Account', () => {
  it('registers only the exact declared API-key mode and no private Voice action', () => {
    const registrations: Array<Readonly<{ id: string; runtime: PluginConnectedAccountRuntime }>> = [];
    const registerAction = vi.fn();
    activate({
      connectedAccounts: {
        register(id: string, runtime: PluginConnectedAccountRuntime) {
          registrations.push({ id, runtime });
          return { dispose() {} };
        },
      },
      actions: { register: registerAction },
    } as Parameters<typeof activate>[0]);

    expect(PLUGIN_MANIFEST.contributes.connectedAccountDescriptors[0]).toMatchObject({
      id: 'openai',
      authentication: {
        defaultModeId: 'api-key',
        modes: [expect.objectContaining({ id: 'api-key', kind: 'manual' })],
      },
    });
    expect(registrations).toHaveLength(1);
    expect(registrations[0]).toMatchObject({
      id: 'openai',
      runtime: { authentication: { modes: { 'api-key': { kind: 'manual' } } } },
    });
    expect(registerAction).not.toHaveBeenCalled();
  });

  it('stages a trimmed key, preserves reconnect identity, and materializes only requested OpenAI access', async () => {
    const registrations: PluginConnectedAccountRuntime[] = [];
    activate({
      connectedAccounts: {
        register(_id: string, runtime: PluginConnectedAccountRuntime) {
          registrations.push(runtime);
          return { dispose() {} };
        },
      },
      actions: { register() {} },
    } as Parameters<typeof activate>[0]);
    const runtime = registrations[0];
    const mode = runtime?.authentication.modes['api-key'];
    if (!runtime || !mode || mode.kind !== 'manual') throw new Error('OpenAI API-key mode is unavailable');

    const attempted = credentialStore();
    const connected = await mode.complete({ fields: { token: ' sk-openai ' } }, {
      attempt: { kind: 'connect', attemptId: 'attempt-openai' },
      signal: new AbortController().signal,
      services: {},
      attemptCredentials: attempted.store,
    } as Parameters<typeof mode.complete>[1]);
    expect(connected).toMatchObject({ status: 'connected', displayName: 'OpenAI API key' });
    expect(attempted.values).toEqual(new Map([['token', 'sk-openai']]));

    const replacement = credentialStore();
    await expect(mode.complete({ fields: { token: 'sk-replacement' } }, {
      attempt: {
        kind: 'reconnect',
        attemptId: 'attempt-reconnect',
        account: {
          service: { pluginId: 'happier.voice.openai', localId: 'openai' },
          accountId: 'account-stable',
        },
      },
      signal: new AbortController().signal,
      services: {},
      attemptCredentials: replacement.store,
    } as Parameters<typeof mode.complete>[1])).resolves.toMatchObject({
      status: 'connected',
      accountId: 'account-stable',
    });

    const stored = credentialStore(new Map([['token', 'sk-openai']]));
    const readContext = {
      account: {
        service: { pluginId: 'happier.voice.openai', localId: 'openai' },
        accountId: 'account-stable',
      },
      configuration: {
        target: {
          kind: 'account',
          account: {
            service: { pluginId: 'happier.voice.openai', localId: 'openai' },
            accountId: 'account-stable',
          },
          modeId: 'api-key',
        },
        revision: 'configuration-1',
        values: {},
        async getSecret() { return null; },
      },
      signal: new AbortController().signal,
      services: {},
      credentials: stored.store,
    } as Parameters<typeof runtime.materialize>[1];
    await expect(runtime.materialize(
      { kind: 'environment', keys: ['OPENAI_API_KEY', 'UNRELATED'] },
      readContext,
    )).resolves.toEqual({
      kind: 'environment',
      env: { OPENAI_API_KEY: 'sk-openai' },
    });
    await expect(runtime.materialize(
      { kind: 'httpHeaders', origin: 'https://api.openai.com', headerNames: ['authorization'] },
      readContext,
    )).resolves.toEqual({
      kind: 'httpHeaders',
      headers: { Authorization: 'Bearer sk-openai' },
    });
    await expect(runtime.materialize(
      { kind: 'httpHeaders', origin: 'https://api.openai.com.evil.test', headerNames: ['authorization'] },
      readContext,
    )).rejects.toThrow(/origin/u);
  });
});
