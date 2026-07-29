import { beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeRecipientContractV1 } from '@happier-dev/protocol';

import { createAccountVoiceOperationService } from './accountVoiceOperationService';

const mocks = vi.hoisted(() => ({
  state: {
    settingsScope: Object.freeze({ serverId: 'server-1', accountId: 'account-1' }),
    settings: {
      voice: {
        credentialBindings: [{
          providerId: 'realtime_openai',
          credentialBindings: { account: { api_key: 'secret-1' } },
        }],
      },
      secrets: [{
        id: 'secret-1',
        name: 'OpenAI',
        kind: 'apiKey' as const,
        encryptedValue: { _isSecretValue: true as const, value: 'account-secret' },
        createdAt: 1,
        updatedAt: 1,
      }],
    },
      profile: {
      connectedServicesV2: [] as Array<{
        serviceId: string;
        profiles: Array<{ profileId: string; status: string; kind: string }>;
        groups: Array<{
          groupId: string;
          activeProfileId: string;
          generation: number;
          memberProfileIds: string[];
        }>;
      }>,
      connectedServiceCredentialRevisionsV1: [] as Array<{
        serviceId: string;
        profileId: string;
        credentialRevision: string;
      }>,
    },
  },
}));

vi.mock('@/sync/domains/state/storage', () => ({
  storage: { getState: () => mocks.state },
}));

vi.mock('@/sync/sync', () => ({
  sync: { decryptSecretValue: () => 'account-secret' },
}));

function createSettings(secretId: string, updatedAt: number) {
  return {
    voice: {
      credentialBindings: [{
        providerId: 'realtime_openai',
        credentialBindings: { account: { api_key: secretId } },
      }],
    },
    secrets: [{
      id: secretId,
      name: 'OpenAI',
      kind: 'apiKey' as const,
      encryptedValue: { _isSecretValue: true as const, value: `account-secret-${updatedAt}` },
      createdAt: 1,
      updatedAt,
    }],
  };
}

const recipientContract = normalizeRecipientContractV1({
  version: 1 as const,
  package: Object.freeze({
    pluginId: 'happier.voice.openai',
    source: Object.freeze({ kind: 'bundled' as const, locator: '@happier-dev/plugins-openai' }),
  }),
  publisher: Object.freeze({ trust: 'bundled' as const, identity: 'happier:first-party' }),
  contribution: Object.freeze({ pluginId: 'happier.voice.openai', localId: 'realtime-openai' }),
  credentialSlot: Object.freeze({ id: 'api_key', scope: 'account' as const }),
  operations: Object.freeze([Object.freeze({
    id: 'client-auth',
    purpose: 'voice.client-auth',
    credentialSlotId: 'api_key',
    effect: 'read' as const,
    request: Object.freeze({
      origin: 'https://api.openai.com',
      pathTemplate: '/v1/realtime/client_secrets',
      queryTemplate: Object.freeze([]),
      headerTemplate: Object.freeze([
        Object.freeze({ name: 'accept', value: 'application/json' }),
        Object.freeze({ name: 'content-type', value: 'application/json' }),
      ]),
      bodyTemplate: Object.freeze({ kind: 'json' as const, value: Object.freeze({}) }),
      method: 'POST' as const,
      credential: Object.freeze({
        kind: 'httpHeader' as const,
        name: 'authorization',
        format: 'bearer' as const,
      }),
      redirect: 'error' as const,
      maxBodyBytes: 64 * 1024,
      contentTypes: Object.freeze(['application/json']),
    }),
    parameters: Object.freeze({
      schema: Object.freeze({
        type: 'object' as const,
        properties: Object.freeze({
          body: Object.freeze({ type: 'object' as const, additionalProperties: true }),
        }),
        required: Object.freeze(['body']),
        additionalProperties: false,
      }),
      mapping: Object.freeze([Object.freeze({
        parameter: 'body',
        target: Object.freeze({ kind: 'body' as const, pointer: '' }),
      })]),
    }),
    response: Object.freeze({
      maxBytes: 64 * 1024,
      contentTypes: Object.freeze(['application/json']),
    }),
  })]),
});

function requestClientAuth(service: ReturnType<typeof createAccountVoiceOperationService>) {
  return service.request({
    operationId: 'client-auth',
    parameters: {
      body: {
        session: {
          type: 'realtime',
          model: 'gpt-realtime',
          audio: { output: { voice: 'marin' } },
        },
      },
    },
    signal: new AbortController().signal,
  });
}

describe('account Voice operation service', () => {
  beforeEach(() => {
    mocks.state = {
      settingsScope: Object.freeze({ serverId: 'server-1', accountId: 'account-1' }),
      settings: createSettings('secret-1', 1),
      profile: {
        connectedServicesV2: [],
        connectedServiceCredentialRevisionsV1: [],
      },
    };
  });

  it('rejects a recipient path that can escape its displayed origin before secret materialization or fetch', () => {
    const materializeSecret = vi.fn(async () => 'account-secret');
    const fetch = vi.fn();
    expect(() => createAccountVoiceOperationService({
      providerId: 'realtime_openai',
      recipientContract: {
        version: 1,
        package: {
          pluginId: 'happier.voice.openai',
          source: { kind: 'package', locator: '@malicious/copied-provider' },
        },
        publisher: { trust: 'verified', identity: 'registry:malicious' },
        contribution: { pluginId: 'happier.voice.openai', localId: 'realtime-openai' },
        credentialSlot: { id: 'api_key', scope: 'account' },
        operations: [{
          id: 'client-auth',
          purpose: 'voice.client-auth',
          credentialSlotId: 'api_key',
          effect: 'read',
          request: {
            origin: 'https://api.openai.com',
            pathTemplate: '//attacker.example/collect',
            queryTemplate: [],
            headerTemplate: [{ name: 'content-type', value: 'application/json' }],
            bodyTemplate: { kind: 'json', value: {} },
            method: 'POST',
            credential: { kind: 'httpHeader', name: 'authorization', format: 'bearer' },
            redirect: 'error',
            maxBodyBytes: 1_024,
            contentTypes: ['application/json'],
          },
          parameters: {
            schema: { type: 'object', properties: {}, additionalProperties: false },
            mapping: [],
          },
          response: { maxBytes: 32_768, contentTypes: ['application/json'] },
        }],
      },
      signal: new AbortController().signal,
      isCurrent: () => true,
      fetch,
      materializeSecret,
    })).toThrow();
    expect(materializeSecret).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('materializes the account secret only inside the exact declared client-auth request', async () => {
    const materializeSecret = vi.fn(async () => 'account-secret');
    const fetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ authorization: 'Bearer account-secret' });
      return new Response(JSON.stringify({
        value: 'short-lived-client-auth',
        expires_at: Math.floor(Date.now() / 1_000) + 60,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const service = createAccountVoiceOperationService({
      providerId: 'realtime_openai',
      recipientContract,
      signal: new AbortController().signal,
      isCurrent: () => true,
      fetch,
      materializeSecret,
    });

    expect(materializeSecret).not.toHaveBeenCalled();
    const response = await requestClientAuth(service);

    expect(materializeSecret).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(new TextDecoder().decode(response.body)).toContain('short-lived-client-auth');
    expect(new TextDecoder().decode(response.body)).not.toContain('account-secret');
  });

  it('inspects SavedSecret availability without materializing the secret or calling the provider', async () => {
    const materializeSecret = vi.fn(async () => 'account-secret');
    const fetch = vi.fn();
    const service = createAccountVoiceOperationService({
      providerId: 'realtime_openai',
      recipientContract,
      signal: new AbortController().signal,
      isCurrent: () => true,
      fetch,
      materializeSecret,
    });

    await expect(service.inspectAvailability()).resolves.toBeUndefined();

    expect(materializeSecret).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects request drift before materializing the account secret', async () => {
    const materializeSecret = vi.fn(async () => 'account-secret');
    const fetch = vi.fn();
    const service = createAccountVoiceOperationService({
      providerId: 'realtime_openai',
      recipientContract,
      signal: new AbortController().signal,
      isCurrent: () => true,
      fetch,
      materializeSecret,
    });

    await expect(service.request({
      operationId: 'unknown-operation',
      parameters: {},
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'voice_account_operation_unauthorized' });
    expect(materializeSecret).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([401, 403])(
    'classifies provider HTTP %s as unavailable credentials and cancels the unread body',
    async (status) => {
      let cancelled = false;
      const fetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new TextEncoder().encode('private provider response'));
        },
        cancel() {
          cancelled = true;
        },
      }), { status }));
      const service = createAccountVoiceOperationService({
        providerId: 'realtime_openai',
        recipientContract,
        signal: new AbortController().signal,
        isCurrent: () => true,
        fetch,
        materializeSecret: async () => 'account-secret',
      });

      await expect(requestClientAuth(service)).rejects.toMatchObject({
        code: 'credential_unavailable',
        message: 'credential_unavailable',
      });
      expect(cancelled).toBe(true);
    },
  );

  it('retains the selected secret but blocks use until recipient access is reviewed', async () => {
    const materializeSecret = vi.fn(async () => 'account-secret');
    const fetch = vi.fn();
    const service = createAccountVoiceOperationService({
      providerId: 'realtime_openai',
      recipientContract,
      signal: new AbortController().signal,
      isCurrent: () => true,
      fetch,
      materializeSecret,
      requireRecipientApproval: true,
    });

    await expect(requestClientAuth(service)).rejects.toMatchObject({
      code: 'credential_access_review_required',
      message: 'credential_access_review_required',
    });
    expect(materializeSecret).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.state.settings.voice.credentialBindings[0]?.credentialBindings.account.api_key)
      .toBe('secret-1');
  });

  it('rejects a source credential reflected directly or through JSON escaping', async () => {
    for (const responseBody of [
      '{"nested":{"token":"account-secret"}}',
      String.raw`{"nested":{"token":"account-\u0073ecret"}}`,
    ]) {
      const fetch = vi.fn(async () => new Response(
        responseBody,
        { status: 200, headers: { 'content-type': 'application/json' } },
      ));
      const service = createAccountVoiceOperationService({
        providerId: 'realtime_openai',
        recipientContract,
        signal: new AbortController().signal,
        isCurrent: () => true,
        fetch,
        materializeSecret: async () => 'account-secret',
      });

      await expect(requestClientAuth(service)).rejects.toMatchObject({ code: 'provider_response_invalid' });
    }
  });

  it('withdraws authority when the bundled runtime generation retires during materialization', async () => {
    let current = true;
    const fetch = vi.fn();
    const service = createAccountVoiceOperationService({
      providerId: 'realtime_openai',
      recipientContract,
      signal: new AbortController().signal,
      isCurrent: () => current,
      fetch,
      materializeSecret: async () => {
        current = false;
        return 'account-secret';
      },
    });

    await expect(requestClientAuth(service)).rejects.toMatchObject({ code: 'voice_account_operation_cancelled' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('aborts the exact fetch signal when host authority retires despite a distinct live request signal', async () => {
    const authority = new AbortController();
    const request = new AbortController();
    const fetchSignals: AbortSignal[] = [];
    const fetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      const fetchSignal = init?.signal;
      if (!fetchSignal) throw new Error('missing_fetch_signal');
      fetchSignals.push(fetchSignal);
      return await new Promise<Response>((_resolve, reject) => {
        fetchSignal.addEventListener('abort', () => reject(
          Object.assign(new Error('fetch_aborted'), { name: 'AbortError' }),
        ), { once: true });
      });
    });
    const service = createAccountVoiceOperationService({
      providerId: 'realtime_openai',
      recipientContract,
      signal: authority.signal,
      isCurrent: () => !authority.signal.aborted,
      fetch,
      materializeSecret: async () => 'account-secret',
    });
    const pending = service.request({
      operationId: 'client-auth',
      parameters: {
        body: {
          session: {
            type: 'realtime',
            model: 'gpt-realtime',
            audio: { output: { voice: 'marin' } },
          },
        },
      },
      signal: request.signal,
    });
    await vi.waitFor(() => expect(fetchSignals).toHaveLength(1));
    expect(fetchSignals[0]).not.toBe(authority.signal);
    expect(fetchSignals[0]).not.toBe(request.signal);
    authority.abort();
    expect(fetchSignals[0]?.aborted).toBe(true);
    expect(request.signal.aborted).toBe(false);
    await expect(pending).rejects.toMatchObject({ code: 'voice_account_operation_cancelled' });
  });

  it('withdraws authority when the account credential binding rotates during materialization', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      value: 'short-lived-client-auth',
      expires_at: Math.floor(Date.now() / 1_000) + 60,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const service = createAccountVoiceOperationService({
      providerId: 'realtime_openai',
      recipientContract,
      signal: new AbortController().signal,
      isCurrent: () => true,
      fetch,
      materializeSecret: async () => {
        mocks.state = { ...mocks.state, settings: createSettings('secret-2', 2) };
        return 'account-secret';
      },
    });

    await expect(requestClientAuth(service)).rejects.toMatchObject({ code: 'voice_account_operation_cancelled' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('withdraws authority when the account credential binding rotates while reading the response', async () => {
    const fetch = vi.fn(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(JSON.stringify({
            value: 'short-lived-client-auth',
            expires_at: Math.floor(Date.now() / 1_000) + 60,
          })));
          mocks.state = { ...mocks.state, settings: createSettings('secret-2', 2) };
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const service = createAccountVoiceOperationService({
      providerId: 'realtime_openai',
      recipientContract,
      signal: new AbortController().signal,
      isCurrent: () => true,
      fetch,
      materializeSecret: async () => 'account-secret',
    });

    await expect(requestClientAuth(service)).rejects.toMatchObject({ code: 'voice_account_operation_cancelled' });
  });

});
