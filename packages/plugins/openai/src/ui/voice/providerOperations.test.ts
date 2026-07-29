import { describe, expect, it, vi } from 'vitest';

import { createOpenAiRealtimeCredentialOperations } from './providerOperations.js';

describe('OpenAI Realtime provider operations', () => {
  it('uses the bounded account operation without receiving the account secret', async () => {
    const request = vi.fn(async (operation: Readonly<{
      operationId: string;
      parameters: unknown;
      signal: AbortSignal;
    }>) => {
      expect(operation.operationId).toBe('client-auth');
      expect(operation.parameters).toMatchObject({
        body: {
        session: {
          type: 'realtime',
          model: 'gpt-realtime-2.1',
          audio: {
            input: {
              turn_detection: { type: 'server_vad', create_response: false, interrupt_response: false },
            },
            output: { voice: 'marin' },
          },
        },
        },
      });
      return Object.freeze({
        status: 200,
        finalUrl: 'https://api.openai.com/v1/realtime/client_secrets',
        headers: Object.freeze({ 'content-type': 'application/json' }),
        body: new TextEncoder().encode(JSON.stringify({
          value: 'ek_ephemeral',
          expires_at: 1_800_000_300,
        })),
      });
    });
    const operations = createOpenAiRealtimeCredentialOperations({ now: () => 1_800_000_000_000 });

    await expect(operations.mintClientAuthWithAccountOperations({
      accountOperations: Object.freeze({ request }),
      audience: JSON.stringify({ model: 'gpt-realtime-2.1', voice: 'marin' }),
      signal: new AbortController().signal,
    })).resolves.toEqual({
      kind: 'bearer_token',
      placement: 'authorization_header',
      value: 'ek_ephemeral',
      expiresAtMs: 1_800_000_300_000,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('fails closed on redirects and malformed provider responses', async () => {
    const operations = createOpenAiRealtimeCredentialOperations();
    await expect(operations.mintClientAuthWithAccountOperations({
      accountOperations: Object.freeze({
        request: async () => Object.freeze({
          status: 200,
          finalUrl: 'https://redirected.example/v1/realtime/client_secrets',
          headers: Object.freeze({}),
          body: new TextEncoder().encode(JSON.stringify({ value: 'ephemeral', expires_at: 1_800_000_300 })),
        }),
      }),
      audience: JSON.stringify({ model: 'gpt-realtime-2.1', voice: 'marin' }),
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'provider_response_invalid' });

    await expect(operations.mintClientAuthWithAccountOperations({
      accountOperations: Object.freeze({
        request: async () => Object.freeze({
          status: 200,
          finalUrl: 'https://api.openai.com/v1/realtime/client_secrets',
          headers: Object.freeze({}),
          body: new TextEncoder().encode('{}'),
        }),
      }),
      audience: JSON.stringify({ model: 'gpt-realtime-2.1', voice: 'marin' }),
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'provider_response_invalid' });
  });

  it.each([401, 403])(
    'classifies account-operation HTTP %s as unavailable credentials',
    async (status) => {
      const operations = createOpenAiRealtimeCredentialOperations();
      await expect(operations.mintClientAuthWithAccountOperations({
        accountOperations: Object.freeze({
          request: async () => Object.freeze({
            status,
            finalUrl: 'https://api.openai.com/v1/realtime/client_secrets',
            headers: Object.freeze({}),
            body: new TextEncoder().encode('private provider response'),
          }),
        }),
        audience: JSON.stringify({ model: 'gpt-realtime-2.1', voice: 'marin' }),
        signal: new AbortController().signal,
      })).rejects.toMatchObject({
        code: 'credential_unavailable',
        message: 'credential_unavailable',
      });
    },
  );

  it('accepts only the canonical client-secret artifact shape', async () => {
    const operations = createOpenAiRealtimeCredentialOperations({
      now: () => 1_800_000_000_000,
    });
    const mint = (artifact: unknown) => operations.mintClientAuthWithAccountOperations({
      accountOperations: Object.freeze({
        request: async () => Object.freeze({
          status: 200,
          finalUrl: 'https://api.openai.com/v1/realtime/client_secrets',
          headers: Object.freeze({}),
          body: new TextEncoder().encode(JSON.stringify(artifact)),
        }),
      }),
      audience: JSON.stringify({ model: 'gpt-realtime-2.1', voice: 'marin' }),
      signal: new AbortController().signal,
    });

    await expect(mint({
      value: 'ephemeral',
      expiresAt: 1_800_000_300,
    })).rejects.toMatchObject({ code: 'provider_response_invalid' });
    await expect(mint({
      value: 'ephemeral',
      expires_at: 1_800_000_300,
      unexpected: true,
    })).rejects.toMatchObject({ code: 'provider_response_invalid' });
  });

  it('rejects an oversized account-operation response', async () => {
    const operations = createOpenAiRealtimeCredentialOperations();
    await expect(operations.mintClientAuthWithAccountOperations({
      accountOperations: Object.freeze({
        request: async () => Object.freeze({
          status: 200,
          finalUrl: 'https://api.openai.com/v1/realtime/client_secrets',
          headers: Object.freeze({}),
          body: new Uint8Array(64 * 1024 + 1),
        }),
      }),
      audience: JSON.stringify({ model: 'gpt-realtime-2.1', voice: 'marin' }),
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'provider_response_invalid' });
  });
});
