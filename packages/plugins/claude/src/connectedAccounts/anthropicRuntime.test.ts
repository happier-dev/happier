import { describe, expect, it, vi } from 'vitest';

import type { ConnectedAccountRuntime as PluginConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';

import { activate } from '../activate.js';
import { anthropicConnectedAccountRuntime } from './anthropicRuntime.js';

function manualMode() {
  const mode = anthropicConnectedAccountRuntime.authentication.modes['api-key'];
  if (!mode || mode.kind !== 'manual') throw new Error('Missing manual mode');
  return mode;
}

function authenticationContext(status = 200) {
  const credentials = credentialStore();
  const request = vi.fn(async () => ({
    status, finalUrl: 'https://api.anthropic.com/v1/models', headers: {},
    body: new TextEncoder().encode(JSON.stringify({ data: [], has_more: false })),
  }));
  const mode = manualMode();
  const context = {
    service: { pluginId: 'happier.agent.claude', localId: 'anthropic' },
    attempt: { kind: 'connect', attemptId: 'key-admission' },
    configuration: { target: { kind: 'service', service: { pluginId: 'happier.agent.claude', localId: 'anthropic' }, modeId: 'api-key' },
      revision: 'configuration-1', values: {}, async getSecret() { return null; } },
    signal: new AbortController().signal,
    services: { http: { request } },
    attemptCredentials: credentials.store,
  } as Parameters<typeof mode.complete>[1];
  return { credentials, request, context };
}

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
  it.each(['not-a-valid-key', 'sk-ant-', 'sk-ant-key with spaces'])('rejects malformed input %s before network or credential writes', async (token) => {
    const h = authenticationContext();
    await expect(manualMode().complete({ fields: { token } }, h.context)).resolves.toMatchObject({ status: 'rejected' });
    expect(h.credentials.values.size).toBe(0);
    expect(h.request).not.toHaveBeenCalled();
  });

  it.each([401, 403])('does not stage a valid-shaped key rejected by Anthropic (%s)', async (status) => {
    const h = authenticationContext(status);
    await expect(manualMode().complete({ fields: { token: 'sk-ant-qa-fake' } }, h.context)).resolves.toMatchObject({
      status: 'rejected', diagnostic: { code: 'anthropic_api_key_rejected' },
    });
    expect(h.credentials.values.size).toBe(0);
  });

  it.each([429, 503])('keeps an unverified key unstored when verification is unavailable (%s)', async (status) => {
    const h = authenticationContext(status);
    await expect(manualMode().complete({ fields: { token: 'sk-ant-qa-fake' } }, h.context)).resolves.toMatchObject({ status: 'unavailable' });
    expect(h.credentials.values.size).toBe(0);
  });

  it('verifies a valid-shaped key with a read-only provider call before storing it', async () => {
    const h = authenticationContext();
    await expect(manualMode().complete({ fields: { token: ' sk-ant-verified ' } }, h.context)).resolves.toMatchObject({ status: 'connected' });
    expect(h.request).toHaveBeenCalledWith({ url: 'https://api.anthropic.com/v1/models', method: 'GET',
      headers: { 'x-api-key': 'sk-ant-verified', 'anthropic-version': '2023-06-01' }, redirect: 'error' }, { signal: h.context.signal });
    expect(h.credentials.values).toEqual(new Map([['token', 'sk-ant-verified']]));
  });

  it('does not stage credentials after network failure or cancellation during verification', async () => {
    const unavailable = authenticationContext();
    unavailable.request.mockRejectedValueOnce(new Error('Network unavailable'));
    await expect(manualMode().complete({ fields: { token: 'sk-ant-valid' } }, unavailable.context)).resolves.toMatchObject({ status: 'unavailable' });
    expect(unavailable.credentials.values.size).toBe(0);
    const cancelled = authenticationContext();
    const controller = new AbortController();
    cancelled.request.mockImplementationOnce(async () => {
      controller.abort();
      return { status: 200, finalUrl: 'https://api.anthropic.com/v1/models', headers: {}, body: new Uint8Array() };
    });
    await expect(manualMode().complete({ fields: { token: 'sk-ant-valid' } }, { ...cancelled.context, signal: controller.signal })).rejects.toThrow();
    expect(cancelled.credentials.values.size).toBe(0);
  });

  it('keeps retained predecessor credentials readable without imposing new input admission', async () => {
    const h = authenticationContext();
    const credentials = credentialStore(new Map([['token', 'legacy-stored-key']]));
    const context = { ...h.context, account: { service: h.context.service, accountId: 'retained-account' }, credentials: credentials.store };
    await expect(anthropicConnectedAccountRuntime.status(context)).resolves.toMatchObject({ status: 'connected' });
    await expect(anthropicConnectedAccountRuntime.materialize({ kind: 'environment', keys: ['ANTHROPIC_API_KEY'] }, context)).resolves.toEqual({
      kind: 'environment', env: { ANTHROPIC_API_KEY: 'legacy-stored-key' },
    });
    expect(h.request).not.toHaveBeenCalled();
  });

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
      mcp: { registerDiscoverySource() { return { dispose() {} }; } },
      actions: { register() { return { dispose() {} }; } },
      connectedAccounts: {
        register(id: string, runtime: PluginConnectedAccountRuntime) {
          registrations.push({ id, runtime });
          return { dispose() {} };
        },
      },
    } as Parameters<typeof activate>[0]);

    // Descriptor registration order is the manifest's record order and is not a
    // public semantic, so this asserts the exact registered id set and each
    // runtime's authentication shape by id rather than by position.
    expect([...registrations].map(({ id }) => id).sort()).toEqual([
      'anthropic',
      'claude-subscription',
    ]);
    const runtimeById = new Map(registrations.map(({ id, runtime }) => [id, runtime]));
    expect(runtimeById.get('anthropic')).toMatchObject({
      authentication: {
        modes: { 'api-key': { kind: 'manual' } },
      },
    });
    expect(runtimeById.get('claude-subscription')).toMatchObject({
      authentication: {
        modes: {
          'setup-token': { kind: 'manual' },
          oauth: { kind: 'oauthAuthorizationCode' },
        },
      },
    });
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
      mcp: { registerDiscoverySource() { return { dispose() {} }; } },
      actions: { register() { return { dispose() {} }; } },
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
      services: authenticationContext().context.services,
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
      services: authenticationContext().context.services,
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
