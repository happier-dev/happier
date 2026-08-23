import { describe, expect, it, vi } from 'vitest';

import { createXaiRealtimeCredentialOperations } from './operations.js';

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
          body: new TextEncoder().encode(JSON.stringify({ value: 'short', expires_at: 1_800_000_300 })),
        }),
      }),
      audience: '{"platform":"web"}',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'provider_response_invalid' });
  });

  it('requires the documented integer unix-seconds expires_at and rejects every off-contract expiry', async () => {
    const now = 1_800_000_000_000;
    const operations = createXaiRealtimeCredentialOperations({ now: () => now });
    const mint = async (body: Readonly<Record<string, unknown>>) =>
      await operations.mintClientAuthWithAccountOperations({
        accountOperations: Object.freeze({
          request: async () => Object.freeze({
            status: 200,
            finalUrl: 'https://api.x.ai/v1/realtime/client_secrets',
            headers: Object.freeze({ 'content-type': 'application/json' }),
            body: new TextEncoder().encode(JSON.stringify({ value: 'xai_ephemeral', ...body })),
          }),
        }),
        audience: '{"platform":"web"}',
        signal: new AbortController().signal,
      });

    // `expires_at` is required by the xAI contract; an omitted expiry is an
    // off-contract response, not a licence to invent a five-minute lifetime.
    await expect(mint({})).rejects.toMatchObject({ code: 'provider_response_invalid' });

    // Already expired, about to expire, and implausibly far out are provider
    // statements the broker cannot honour.
    await expect(mint({ expires_at: 1_799_999_000 })).rejects
      .toMatchObject({ code: 'provider_response_invalid' });
    await expect(mint({ expires_at: 1_800_000_000 })).rejects
      .toMatchObject({ code: 'provider_response_invalid' });
    await expect(mint({ expires_at: 1_800_003_600 })).rejects
      .toMatchObject({ code: 'provider_response_invalid' });
    await expect(mint({ expires_at: 0 })).rejects
      .toMatchObject({ code: 'provider_response_invalid' });
    await expect(mint({ expires_at: -1 })).rejects
      .toMatchObject({ code: 'provider_response_invalid' });

    // The contract says integer unix SECONDS. A millisecond epoch that would
    // otherwise land two minutes out is a different unit, not a fresh artifact.
    await expect(mint({ expires_at: now + 120_000 })).rejects
      .toMatchObject({ code: 'provider_response_invalid' });
    // A fractional second, a non-finite number, and a numeric or ISO string are
    // all off-contract shapes rather than timestamps to coerce.
    await expect(mint({ expires_at: 1_800_000_300.5 })).rejects
      .toMatchObject({ code: 'provider_response_invalid' });
    await expect(mint({ expires_at: Number.MAX_SAFE_INTEGER + 2 })).rejects
      .toMatchObject({ code: 'provider_response_invalid' });
    await expect(mint({ expires_at: '1800000300' })).rejects
      .toMatchObject({ code: 'provider_response_invalid' });
    await expect(mint({ expires_at: new Date(now + 120_000).toISOString() })).rejects
      .toMatchObject({ code: 'provider_response_invalid' });

    // `expiresAt` is not a documented xAI field; it cannot satisfy the requirement.
    await expect(mint({ expiresAt: 1_800_000_300 })).rejects
      .toMatchObject({ code: 'provider_response_invalid' });
    await expect(mint({ expiresAt: 'not-a-timestamp' })).rejects
      .toMatchObject({ code: 'provider_response_invalid' });

    // The documented shape is accepted, and unrelated extra response fields do
    // not make an otherwise-valid response invalid.
    await expect(mint({ expires_at: 1_800_000_300, request_id: 'req_1', usage: { tokens: 3 } }))
      .resolves.toMatchObject({ expiresAtMs: 1_800_000_300_000 });
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
