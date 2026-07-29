import { describe, expect, it, vi } from 'vitest';

import type {
  ActionHandler,
  PluginConnectedAccountRuntime,
} from '@happier-dev/plugin-sdk/runtime';

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

function immediateConnectedAccountWatch() {
  return vi.fn((
    _purpose: string,
    listener: (event: Readonly<{ kind: 'resync' }>) => void,
  ) => {
    listener({ kind: 'resync' });
    return { dispose() {} };
  });
}

const officialRealtimeSessionResponse = Object.freeze({
  type: 'realtime',
  object: 'realtime.session',
  id: 'sess_C9CiUVUzUzYIssh3ELY1d',
  model: 'gpt-realtime-2025-08-25',
  output_modalities: ['audio'],
  instructions: 'You are a friendly assistant.',
  tools: [],
  tool_choice: 'auto',
  max_output_tokens: 'inf',
  tracing: null,
  truncation: 'auto',
  prompt: null,
  expires_at: 0,
  audio: {
    input: {
      format: { type: 'audio/pcm', rate: 24_000 },
      transcription: null,
      noise_reduction: null,
      turn_detection: null,
    },
    output: {
      format: { type: 'audio/pcm', rate: 24_000 },
      voice: 'alloy',
      speed: 1,
    },
  },
  include: null,
});

describe('OpenAI API-key Connected Account', () => {
  it('registers the exact declared API-key mode', () => {
    const registrations: Array<Readonly<{ id: string; runtime: PluginConnectedAccountRuntime }>> = [];
    activate({
      connectedAccounts: {
        register(id: string, runtime: PluginConnectedAccountRuntime) {
          registrations.push({ id, runtime });
          return { dispose() {} };
        },
      },
      actions: { register() {} },
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
      runtime: {
        authentication: {
          modes: { 'api-key': { kind: 'manual' } },
        },
      },
    });
  });

  it('mints realtime client auth only through the qualified purpose and bounded plugin fetch', async () => {
    const actions: Array<Readonly<{ id: string; handler: ActionHandler }>> = [];
    const getBinding = vi.fn(async () => null);
    const requestSelection = vi.fn(async () => ({
      purpose: 'realtime-openai-account',
      service: { pluginId: 'happier.voice.openai', localId: 'openai' },
      target: { kind: 'account' as const, displayName: 'Work' },
    }));
    const materialize = vi.fn(async () => ({
      kind: 'httpHeaders' as const,
      headers: { Authorization: 'Bearer sk-openai' },
    }));
    const watch = immediateConnectedAccountWatch();
    const fetchRequest = vi.fn(async () => ({
      status: 200,
      finalUrl: 'https://api.openai.com/v1/realtime/client_secrets',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({
        value: 'ephemeral-client-secret',
        expires_at: 2_000_000_000,
        session: officialRealtimeSessionResponse,
      })),
    }));
    activate({
      connectedAccounts: {
        register() {},
      },
      actions: {
        register(id: string, handler: ActionHandler) {
          actions.push({ id, handler });
        },
      },
    } as Parameters<typeof activate>[0]);

    const action = actions.find(({ id }) => id === 'mint-realtime-client-auth');
    if (!action) throw new Error('OpenAI realtime client-auth action was not registered');
    const signal = new AbortController().signal;
    await expect(action.handler({
      operationId: 'client-auth',
      parameters: {
        body: {
          session: {
            type: 'realtime',
            model: 'gpt-realtime-2.1',
            audio: {
              input: {
                turn_detection: {
                  type: 'server_vad',
                  create_response: false,
                  interrupt_response: false,
                },
              },
              output: { voice: 'marin' },
            },
          },
        },
      },
    }, {
      signal,
      services: {
        connectedAccounts: {
          getBinding,
          requestSelection,
          materialize,
          watch,
        },
        fetch: { request: fetchRequest },
      },
    } as Parameters<typeof action.handler>[1])).resolves.toEqual({
      status: 200,
      finalUrl: 'https://api.openai.com/v1/realtime/client_secrets',
      headers: {},
      body: {
        value: 'ephemeral-client-secret',
        expires_at: 2_000_000_000,
      },
    });

    expect(getBinding).toHaveBeenCalledWith('realtime-openai-account', { signal });
    expect(requestSelection).toHaveBeenCalledWith({
      purpose: 'realtime-openai-account',
      reason: 'Choose the OpenAI account used for Realtime voice.',
    }, { signal });
    expect(materialize).toHaveBeenCalledWith('realtime-openai-account', {
      kind: 'httpHeaders',
      origin: 'https://api.openai.com',
      headerNames: ['authorization'],
    }, { signal: expect.any(AbortSignal) });
    expect(fetchRequest).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://api.openai.com/v1/realtime/client_secrets',
      method: 'POST',
      headers: expect.objectContaining({
        Authorization: 'Bearer sk-openai',
        'Content-Type': 'application/json',
      }),
      redirect: 'error',
    }), { signal: expect.any(AbortSignal) });
  });

  it('mints experimental Codex OAuth realtime auth through only the exact Codex purpose', async () => {
    const actions: Array<Readonly<{ id: string; handler: ActionHandler }>> = [];
    const getBinding = vi.fn(async () => null);
    const requestSelection = vi.fn(async () => ({
      purpose: 'realtime-openai-codex-account',
      service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
      target: { kind: 'account' as const, displayName: 'Codex work' },
    }));
    const materialize = vi.fn(async () => ({
      kind: 'httpHeaders' as const,
      headers: {
        Authorization: 'Bearer codex-access-secret',
        'ChatGPT-Account-Id': 'acct-codex-work',
      },
    }));
    const watch = immediateConnectedAccountWatch();
    const fetchRequest = vi.fn(async () => ({
      status: 200,
      finalUrl: 'https://api.openai.com/v1/realtime/client_secrets',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({
        value: 'ephemeral-client-secret',
        expires_at: 2_000_000_000,
        session: officialRealtimeSessionResponse,
      })),
    }));
    activate({
      connectedAccounts: { register() {} },
      actions: {
        register(id: string, handler: ActionHandler) {
          actions.push({ id, handler });
        },
      },
    } as Parameters<typeof activate>[0]);

    const action = actions.find(
      ({ id }) => id === 'mint-realtime-client-auth-with-codex-oauth',
    );
    if (!action) throw new Error('Codex OAuth realtime client-auth action was not registered');
    const signal = new AbortController().signal;
    await expect(action.handler({
      operationId: 'client-auth',
      parameters: {
        body: {
          session: {
            type: 'realtime',
            model: 'gpt-realtime-2.1',
            audio: {
              input: { turn_detection: null },
              output: { voice: 'marin' },
            },
          },
        },
      },
    }, {
      signal,
      services: {
        connectedAccounts: { getBinding, requestSelection, materialize, watch },
        fetch: { request: fetchRequest },
      },
    } as Parameters<typeof action.handler>[1])).resolves.toEqual({
      status: 200,
      finalUrl: 'https://api.openai.com/v1/realtime/client_secrets',
      headers: {},
      body: {
        value: 'ephemeral-client-secret',
        expires_at: 2_000_000_000,
      },
    });

    expect(getBinding).toHaveBeenCalledWith('realtime-openai-codex-account', { signal });
    expect(requestSelection).toHaveBeenCalledWith({
      purpose: 'realtime-openai-codex-account',
      reason: 'Choose the experimental OpenAI Codex OAuth account used for Realtime voice.',
    }, { signal });
    expect(materialize).toHaveBeenCalledWith('realtime-openai-codex-account', {
      kind: 'httpHeaders',
      origin: 'https://api.openai.com',
      headerNames: ['authorization', 'chatgpt-account-id'],
    }, { signal: expect.any(AbortSignal) });
    expect(fetchRequest).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://api.openai.com/v1/realtime/client_secrets',
      method: 'POST',
      headers: expect.objectContaining({
        Authorization: 'Bearer codex-access-secret',
        'ChatGPT-Account-Id': 'acct-codex-work',
        'Content-Type': 'application/json',
      }),
      redirect: 'error',
    }), { signal: expect.any(AbortSignal) });
    expect(getBinding).not.toHaveBeenCalledWith('realtime-openai-account', expect.anything());
    expect(requestSelection).not.toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'realtime-openai-account' }),
      expect.anything(),
    );
    expect(materialize).not.toHaveBeenCalledWith(
      'realtime-openai-account',
      expect.anything(),
      expect.anything(),
    );

    fetchRequest.mockResolvedValueOnce({
      status: 200,
      finalUrl: 'https://api.openai.com/v1/realtime/client_secrets',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({
        value: 'codex-access-secret',
        expires_at: 2_000_000_000,
        session: officialRealtimeSessionResponse,
      })),
    });
    await expect(action.handler({
      operationId: 'client-auth',
      parameters: {
        body: {
          session: {
            type: 'realtime',
            model: 'gpt-realtime-2.1',
            audio: {
              input: { turn_detection: null },
              output: { voice: 'marin' },
            },
          },
        },
      },
    }, {
      signal,
      services: {
        connectedAccounts: { getBinding, requestSelection, materialize, watch },
        fetch: { request: fetchRequest },
      },
    } as Parameters<typeof action.handler>[1])).rejects.toMatchObject({
      code: 'provider_response_invalid',
    });

    fetchRequest.mockResolvedValueOnce({
      status: 200,
      finalUrl: 'https://api.openai.com/v1/realtime/client_secrets',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({
        value: 'ephemeral-client-secret',
        expires_at: 2_000_000_000,
        session: officialRealtimeSessionResponse,
        unexpected: true,
      })),
    });
    await expect(action.handler({
      operationId: 'client-auth',
      parameters: {
        body: {
          session: {
            type: 'realtime',
            model: 'gpt-realtime-2.1',
            audio: {
              input: { turn_detection: null },
              output: { voice: 'marin' },
            },
          },
        },
      },
    }, {
      signal,
      services: {
        connectedAccounts: { getBinding, requestSelection, materialize, watch },
        fetch: { request: fetchRequest },
      },
    } as Parameters<typeof action.handler>[1])).rejects.toMatchObject({
      code: 'provider_response_invalid',
    });

    fetchRequest.mockResolvedValueOnce({
      status: 401,
      finalUrl: 'https://api.openai.com/v1/realtime/client_secrets',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({
        error: { message: 'The connected credential was revoked.' },
      })),
    });
    await expect(action.handler({
      operationId: 'client-auth',
      parameters: {
        body: {
          session: {
            type: 'realtime',
            model: 'gpt-realtime-2.1',
            audio: {
              input: { turn_detection: null },
              output: { voice: 'marin' },
            },
          },
        },
      },
    }, {
      signal,
      services: {
        connectedAccounts: { getBinding, requestSelection, materialize, watch },
        fetch: { request: fetchRequest },
      },
    } as Parameters<typeof action.handler>[1])).rejects.toMatchObject({
      code: 'credential_unavailable',
    });

    fetchRequest.mockResolvedValueOnce({
      status: 403,
      finalUrl: 'https://api.openai.com/v1/realtime/client_secrets',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({
        error: { message: 'The connected account no longer grants access.' },
      })),
    });
    await expect(action.handler({
      operationId: 'client-auth',
      parameters: {
        body: {
          session: {
            type: 'realtime',
            model: 'gpt-realtime-2.1',
            audio: {
              input: { turn_detection: null },
              output: { voice: 'marin' },
            },
          },
        },
      },
    }, {
      signal,
      services: {
        connectedAccounts: { getBinding, requestSelection, materialize, watch },
        fetch: { request: fetchRequest },
      },
    } as Parameters<typeof action.handler>[1])).rejects.toMatchObject({
      code: 'credential_unavailable',
    });

    requestSelection.mockResolvedValueOnce({
      purpose: 'realtime-openai-codex-account',
      service: { pluginId: 'happier.voice.openai', localId: 'openai' },
      target: { kind: 'account' as const, displayName: 'Standard API key' },
    });
    await expect(action.handler({
      operationId: 'client-auth',
      parameters: {
        body: {
          session: {
            type: 'realtime',
            model: 'gpt-realtime-2.1',
            audio: {
              input: { turn_detection: null },
              output: { voice: 'marin' },
            },
          },
        },
      },
    }, {
      signal,
      services: {
        connectedAccounts: { getBinding, requestSelection, materialize, watch },
        fetch: { request: fetchRequest },
      },
    } as Parameters<typeof action.handler>[1])).rejects.toMatchObject({
      code: 'credential_unavailable',
    });
    expect(materialize).toHaveBeenCalledTimes(5);
  });

  it.each([
    'account switch',
    'account deletion',
    'account revocation',
  ])('fences a client-secret mint when %s invalidates the materialized authority', async () => {
    const actions: Array<Readonly<{ id: string; handler: ActionHandler }>> = [];
    const watchListener: {
      current?: (event: Readonly<{ kind: 'resync' }>) => void;
    } = {};
    const watch = vi.fn((
      _purpose: string,
      listener: (event: Readonly<{ kind: 'resync' }>) => void,
    ) => {
      watchListener.current = listener;
      listener({ kind: 'resync' });
      return { dispose() {} };
    });
    const materialize = vi.fn(async () => ({
      kind: 'httpHeaders' as const,
      headers: {
        Authorization: 'Bearer codex-access-secret',
        'ChatGPT-Account-Id': 'acct-a',
      },
    }));
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    type FetchResult = Readonly<{
      status: number;
      finalUrl: string;
      headers: Readonly<Record<string, string>>;
      body: Uint8Array;
    }>;
    let resolveFetch!: (value: FetchResult) => void;
    const deferredFetch = new Promise<FetchResult>((resolve) => {
      resolveFetch = resolve;
    });
    const fetchRequest = vi.fn(async () => {
      markFetchStarted();
      return await deferredFetch;
    });
    activate({
      connectedAccounts: { register() {} },
      actions: {
        register(id: string, handler: ActionHandler) {
          actions.push({ id, handler });
        },
      },
    } as Parameters<typeof activate>[0]);
    const action = actions.find(
      ({ id }) => id === 'mint-realtime-client-auth-with-codex-oauth',
    );
    if (!action) throw new Error('Codex OAuth realtime client-auth action was not registered');
    const getBinding = vi.fn(async () => ({
      purpose: 'realtime-openai-codex-account',
      service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
      target: { kind: 'account' as const, displayName: 'Account A' },
    }));
    const requestSelection = vi.fn();
    const operation = action.handler({
      operationId: 'client-auth',
      parameters: {
        body: {
          session: {
            type: 'realtime',
            model: 'gpt-realtime-2.1',
            audio: {
              input: { turn_detection: null },
              output: { voice: 'marin' },
            },
          },
        },
      },
    }, {
      signal: new AbortController().signal,
      services: {
        connectedAccounts: {
          getBinding,
          requestSelection,
          materialize,
          watch,
        },
        fetch: { request: fetchRequest },
      },
    } as Parameters<typeof action.handler>[1]);

    await fetchStarted;
    watchListener.current?.({ kind: 'resync' });
    resolveFetch({
      status: 200,
      finalUrl: 'https://api.openai.com/v1/realtime/client_secrets',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({
        value: 'ephemeral-from-stale-account-a',
        expires_at: 2_000_000_000,
      })),
    });

    expect(watchListener.current).toBeTypeOf('function');
    await expect(operation).rejects.toMatchObject({ code: 'credential_unavailable' });
    expect(materialize).toHaveBeenCalledTimes(1);
    expect(requestSelection).not.toHaveBeenCalled();
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
    expect(connected).toMatchObject({
      status: 'connected',
      displayName: 'OpenAI API key',
    });
    if (connected.status !== 'connected') throw new Error('OpenAI API-key connect was rejected');
    expect(connected).not.toHaveProperty('accountId');
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
