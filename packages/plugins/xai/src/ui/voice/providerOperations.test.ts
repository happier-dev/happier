import { describe, expect, it, vi } from 'vitest';

import { createXaiRealtimeCredentialOperations } from './providerOperations.js';

describe('xAI Realtime credential broker', () => {
  it('mints browser auth through the account operation boundary without receiving the source credential', async () => {
    const request = vi.fn(async () => Object.freeze({
      status: 200,
      finalUrl: 'https://api.x.ai/v1/realtime/client_secrets',
      headers: Object.freeze({ 'content-type': 'application/json' }),
      body: new TextEncoder().encode(JSON.stringify({
        value: 'xai_ephemeral',
        expires_at: 1_800_000_300,
      })),
    }));
    const artifact = await createXaiRealtimeCredentialOperations({ now: () => 1_800_000_000_000 })
      .mintClientAuthWithAccountOperations({
        accountOperations: Object.freeze({ request }),
        audience: JSON.stringify({ platform: 'web' }),
        signal: new AbortController().signal,
      });

    expect(request).toHaveBeenCalledWith({
      operationId: 'client-auth',
      parameters: {
        body: {
          expires_after: { seconds: 300 },
        },
      },
      signal: expect.any(AbortSignal),
    });
    expect(artifact).toEqual({
      kind: 'subprotocol_token',
      placement: 'websocket_subprotocol',
      value: 'xai-client-secret.xai_ephemeral',
      expiresAtMs: 1_800_000_300_000,
    });
  });

  it('does not accept undocumented client_secret aliases or provider redirects', async () => {
    const operations = createXaiRealtimeCredentialOperations();
    await expect(operations.mintClientAuthWithAccountOperations({
      accountOperations: Object.freeze({
        request: async () => Object.freeze({
          status: 200,
          finalUrl: 'https://api.x.ai/v1/realtime/client_secrets',
          headers: Object.freeze({}),
          body: new TextEncoder().encode(JSON.stringify({ client_secret: 'not-official' })),
        }),
      }),
      audience: '{"platform":"web"}',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'provider_response_invalid' });

    await expect(operations.mintClientAuthWithAccountOperations({
      accountOperations: Object.freeze({
        request: async () => Object.freeze({
          status: 200,
          finalUrl: 'https://redirected.example/realtime/client_secrets',
          headers: Object.freeze({}),
          body: new TextEncoder().encode(JSON.stringify({ value: 'short' })),
        }),
      }),
      audience: '{"platform":"web"}',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'provider_response_invalid' });
  });

  it('classifies a forbidden account operation as unavailable credentials', async () => {
    const operations = createXaiRealtimeCredentialOperations();
    await expect(operations.mintClientAuthWithAccountOperations({
      accountOperations: Object.freeze({
        request: async () => Object.freeze({
          status: 403,
          finalUrl: 'https://api.x.ai/v1/realtime/client_secrets',
          headers: Object.freeze({}),
          body: new TextEncoder().encode('private provider response'),
        }),
      }),
      audience: '{"platform":"web"}',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'credential_unavailable',
      message: 'credential_unavailable',
    });
  });

  it('returns native bearer placement and validates the documented voice catalog through account mediation', async () => {
    const operations = createXaiRealtimeCredentialOperations({ now: () => 1_800_000_000_000 });
    await expect(operations.mintClientAuthWithAccountOperations({
      accountOperations: Object.freeze({
        request: async () => Object.freeze({
          status: 200,
          finalUrl: 'https://api.x.ai/v1/realtime/client_secrets',
          headers: Object.freeze({}),
          body: new TextEncoder().encode(JSON.stringify({ value: 'short', expires_at: 1_800_000_300 })),
        }),
      }),
      audience: '{"platform":"native"}',
      signal: new AbortController().signal,
    })).resolves.toEqual({
      kind: 'bearer_token', placement: 'authorization_header', value: 'short', expiresAtMs: 1_800_000_300_000,
    });
    const request = vi.fn(async () => Object.freeze({
      status: 200,
      finalUrl: 'https://api.x.ai/v1/tts/voices',
      headers: Object.freeze({ 'content-type': 'application/json' }),
      body: new TextEncoder().encode(JSON.stringify({ voices: [
        { voice_id: 'eve', name: 'Eve', language: 'en' },
        { voice_id: '', name: 'invalid' },
      ] })),
    }));
    await expect(operations.fetchCatalogWithAccountOperations({
      accountOperations: Object.freeze({ request }),
      catalog: 'voices',
      signal: new AbortController().signal,
    })).resolves.toEqual([{ id: 'eve', name: 'Eve', metadata: { language: 'en' } }]);
    expect(request).toHaveBeenCalledWith({
      operationId: 'voices',
      parameters: {},
      signal: expect.any(AbortSignal),
    });
  });
});
