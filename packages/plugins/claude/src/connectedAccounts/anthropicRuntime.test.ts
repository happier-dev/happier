import { describe, expect, it } from 'vitest';

import type { PluginConnectedAccountRuntime } from '@happier-dev/plugin-sdk/runtime';

import { activate } from '../activate.js';

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

describe('Anthropic API-key Connected Account', () => {
  it('registers both Claude-owned Connected Account descriptor runtimes', () => {
    const registrations: Array<Readonly<{ id: string; runtime: PluginConnectedAccountRuntime }>> = [];
    activate({
      agents: {
        register() { return { dispose() {} }; },
        registerExternalSessions() { return { dispose() {} }; },
        registerExternalSessionTakeover() { return { dispose() {} }; },
        registerExternalSessionHooks() { return { dispose() {} }; },
        registerExternalSessionObservation() { return { dispose() {} }; },
      },
      hooks: { register() { return { dispose() {} }; } },
      mcp: { registerDiscoveryProvider() { return { dispose() {} }; } },
      connectedAccounts: {
        register(id: string, runtime: PluginConnectedAccountRuntime) {
          registrations.push({ id, runtime });
          return { dispose() {} };
        },
      },
    } as Parameters<typeof activate>[0]);

    expect(registrations).toMatchObject([
      {
        id: 'anthropic',
        runtime: {
          authentication: {
            modes: { 'api-key': { kind: 'manual' } },
          },
        },
      },
      {
        id: 'claude-subscription',
        runtime: {
          authentication: {
            modes: {
              'setup-token': { kind: 'manual' },
              oauth: { kind: 'oauthAuthorizationCode' },
            },
          },
        },
      },
    ]);
  });

  it('preserves canonical reconnect identity and materializes exact Anthropic access', async () => {
    const registrations: Array<Readonly<{
      id: string;
      runtime: PluginConnectedAccountRuntime;
    }>> = [];
    activate({
      agents: {
        register() { return { dispose() {} }; },
        registerExternalSessions() { return { dispose() {} }; },
        registerExternalSessionTakeover() { return { dispose() {} }; },
        registerExternalSessionHooks() { return { dispose() {} }; },
        registerExternalSessionObservation() { return { dispose() {} }; },
      },
      hooks: { register() { return { dispose() {} }; } },
      mcp: { registerDiscoveryProvider() { return { dispose() {} }; } },
      connectedAccounts: {
        register(id: string, runtime: PluginConnectedAccountRuntime) {
          registrations.push({ id, runtime });
          return { dispose() {} };
        },
      },
    } as Parameters<typeof activate>[0]);
    const runtime = registrations.find(({ id }) => id === 'anthropic')?.runtime;
    const mode = runtime?.authentication.modes['api-key'];
    if (!runtime || !mode || mode.kind !== 'manual') throw new Error('Anthropic API-key mode is unavailable');

    const firstConnectCredentials = credentialStore();
    const firstConnect = await mode.complete({ fields: { token: ' sk-ant-first ' } }, {
      attempt: {
        kind: 'connect',
        attemptId: 'anthropic-connect',
      },
      signal: new AbortController().signal,
      services: {},
      attemptCredentials: firstConnectCredentials.store,
    } as Parameters<typeof mode.complete>[1]);
    expect(firstConnect).toMatchObject({
      status: 'connected',
      displayName: 'Anthropic API key',
    });
    if (firstConnect.status !== 'connected') throw new Error('Anthropic API-key connect was rejected');
    expect(firstConnect).not.toHaveProperty('accountId');

    const attempted = credentialStore();
    await expect(mode.complete({ fields: { token: ' sk-ant-api ' } }, {
      attempt: {
        kind: 'reconnect',
        attemptId: 'anthropic-reconnect',
        account: {
          service: { pluginId: 'happier.agent.claude', localId: 'anthropic' },
          accountId: 'anthropic-stable',
        },
      },
      signal: new AbortController().signal,
      services: {},
      attemptCredentials: attempted.store,
    } as Parameters<typeof mode.complete>[1])).resolves.toMatchObject({
      status: 'connected',
      accountId: 'anthropic-stable',
      displayName: 'Anthropic API key',
    });
    expect(attempted.values).toEqual(new Map([['token', 'sk-ant-api']]));

    const readContext = {
      account: {
        service: { pluginId: 'happier.agent.claude', localId: 'anthropic' },
        accountId: 'anthropic-stable',
      },
      configuration: {
        target: {
          kind: 'account',
          account: {
            service: { pluginId: 'happier.agent.claude', localId: 'anthropic' },
            accountId: 'anthropic-stable',
          },
          modeId: 'api-key',
        },
        revision: 'configuration-1',
        values: {},
        async getSecret() { return null; },
      },
      signal: new AbortController().signal,
      services: {},
      credentials: attempted.store,
    } as Parameters<typeof runtime.materialize>[1];
    await expect(runtime.materialize(
      { kind: 'environment', keys: ['ANTHROPIC_API_KEY'] },
      readContext,
    )).resolves.toEqual({
      kind: 'environment',
      env: { ANTHROPIC_API_KEY: 'sk-ant-api' },
    });
    await expect(runtime.materialize(
      { kind: 'httpHeaders', origin: 'https://api.anthropic.com', headerNames: ['x-api-key'] },
      readContext,
    )).resolves.toEqual({
      kind: 'httpHeaders',
      headers: { 'x-api-key': 'sk-ant-api' },
    });
  });
});
