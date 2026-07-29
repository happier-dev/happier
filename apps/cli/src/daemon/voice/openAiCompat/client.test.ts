import { describe, expect, it, vi } from 'vitest';

import { createOpenAiCompatVoiceClient } from './client';

function resolverWithKey() {
  return {
    status: () => ({ available: true as const, source: 'account' as const }),
    withSecret: async <T>({ use }: Readonly<{ use: (secret: string) => Promise<T> }>) => await use('long-lived-key'),
  };
}

function resolverWithoutKey() {
  return {
    status: () => ({ available: false as const, source: null }),
    withSecret: async () => { throw new Error('credential unavailable'); },
  };
}

const publicConnection = {
  baseUrl: 'https://gateway.example.test/v1',
  insecureLocalOriginConsent: null,
  credentialKind: 'api_key',
} as const;

describe('daemon OpenAI-compatible voice client', () => {
  it('preserves unauthenticated OpenAI-compatible endpoints when no machine credential exists', async () => {
    const fetchBoundary = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
      return new Response(JSON.stringify({ data: [{ id: 'local-model' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const client = createOpenAiCompatVoiceClient({
      credentialResolver: resolverWithoutKey(),
      fetch: fetchBoundary,
      resolveAddresses: async () => ['93.184.216.34'],
    });

    await expect(client.modelsList(publicConnection)).resolves.toEqual({
      ok: true,
      models: [{ id: 'local-model' }],
    });
    expect(fetchBoundary).toHaveBeenCalledTimes(1);
  });

  it('distinguishes a missing credential rejected by the provider from a provider failure', async () => {
    const missingCredentialClient = createOpenAiCompatVoiceClient({
      credentialResolver: resolverWithoutKey(),
      fetch: async () => new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
      resolveAddresses: async () => ['93.184.216.34'],
    });
    await expect(missingCredentialClient.modelsList(publicConnection)).resolves.toEqual({
      ok: false,
      errorCode: 'credential_unavailable',
      error: 'credential_unavailable',
      retryable: false,
    });

    const rejectedConfiguredCredentialClient = createOpenAiCompatVoiceClient({
      credentialResolver: resolverWithKey(),
      fetch: async () => new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
      resolveAddresses: async () => ['93.184.216.34'],
    });
    await expect(rejectedConfiguredCredentialClient.modelsList(publicConnection)).resolves.toEqual({
      ok: false,
      errorCode: 'provider_error',
      error: 'provider_error',
      retryable: false,
    });

    const providerFailureClient = createOpenAiCompatVoiceClient({
      credentialResolver: resolverWithKey(),
      fetch: async () => new Response(JSON.stringify({ error: 'upstream unavailable' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      }),
      resolveAddresses: async () => ['93.184.216.34'],
    });
    await expect(providerFailureClient.modelsList(publicConnection)).resolves.toEqual({
      ok: false,
      errorCode: 'provider_error',
      error: 'provider_error',
      retryable: true,
    });
  });

  it('does not downgrade to unauthenticated egress when credential status cannot be read', async () => {
    const fetchBoundary = vi.fn(async () => new Response(JSON.stringify({ data: [] }), {
      headers: { 'content-type': 'application/json' },
    }));
    const client = createOpenAiCompatVoiceClient({
      credentialResolver: {
        status: () => { throw new Error('settings unavailable'); },
        withSecret: async () => {
          throw new Error('must not read a secret after status failure');
        },
      },
      fetch: fetchBoundary,
      resolveAddresses: async () => ['93.184.216.34'],
    });

    await expect(client.modelsList(publicConnection)).resolves.toMatchObject({
      ok: false,
      errorCode: 'internal_error',
    });
    expect(fetchBoundary).not.toHaveBeenCalled();
  });

  it('sends credentials only to the assessed exact origin and returns bounded models', async () => {
    const fetchBoundary = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('https://gateway.example.test/v1/models');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer long-lived-key');
      expect(init?.redirect).toBe('manual');
      return new Response(JSON.stringify({ data: [{ id: 'model-a' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const client = createOpenAiCompatVoiceClient({
      credentialResolver: resolverWithKey(),
      fetch: fetchBoundary,
      resolveAddresses: async () => ['93.184.216.34'],
    });
    await expect(client.modelsList(publicConnection)).resolves.toEqual({
      ok: true,
      models: [{ id: 'model-a' }],
    });
    expect(fetchBoundary).toHaveBeenCalledTimes(1);
  });

  it('rejects a successful provider response that echoes the configured credential', async () => {
    const fetchBoundary = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: 'long-lived-key' }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const client = createOpenAiCompatVoiceClient({
      credentialResolver: resolverWithKey(),
      fetch: fetchBoundary,
      resolveAddresses: async () => ['93.184.216.34'],
    });

    const result = await client.modelsList(publicConnection);

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'provider_response_invalid',
      error: 'provider_response_invalid',
    });
    expect(JSON.stringify(result)).not.toContain('long-lived-key');
    expect(fetchBoundary).toHaveBeenCalledTimes(1);
  });

  it('rejects public HTTP and requires consent tied to the exact local HTTP origin', async () => {
    const fetchBoundary = vi.fn(async () => new Response(JSON.stringify({ data: [] }), {
      headers: { 'content-type': 'application/json' },
    }));
    const client = createOpenAiCompatVoiceClient({
      credentialResolver: resolverWithKey(),
      fetch: fetchBoundary,
      resolveAddresses: async (hostname) => hostname === 'localhost' ? ['127.0.0.1'] : ['93.184.216.34'],
    });
    await expect(client.modelsList({
      ...publicConnection,
      baseUrl: 'http://gateway.example.test/v1',
    })).resolves.toMatchObject({ ok: false, errorCode: 'endpoint_unsafe' });
    await expect(client.modelsList({
      ...publicConnection,
      baseUrl: 'http://localhost:11434/v1',
    })).resolves.toMatchObject({ ok: false, errorCode: 'endpoint_consent_required' });
    await expect(client.modelsList({
      ...publicConnection,
      baseUrl: 'http://localhost:11434/v1',
      insecureLocalOriginConsent: 'http://localhost:11434',
    })).resolves.toMatchObject({ ok: true });
    await expect(client.modelsList({
      ...publicConnection,
      baseUrl: 'http://localhost:11435/v1',
      insecureLocalOriginConsent: 'http://localhost:11434',
    })).resolves.toMatchObject({ ok: false, errorCode: 'endpoint_consent_required' });
    expect(fetchBoundary).toHaveBeenCalledTimes(1);
  });

  it('rejects all redirects before forwarding credentials to another request', async () => {
    const fetchBoundary = vi.fn(async () => new Response(null, {
      status: 307,
      headers: { location: 'https://attacker.example/v1/models' },
    }));
    const client = createOpenAiCompatVoiceClient({
      credentialResolver: resolverWithKey(),
      fetch: fetchBoundary,
      resolveAddresses: async () => ['93.184.216.34'],
    });
    await expect(client.modelsList(publicConnection)).resolves.toMatchObject({
      ok: false,
      errorCode: 'redirect_forbidden',
    });
    expect(fetchBoundary).toHaveBeenCalledTimes(1);
  });

  it('fails closed on userinfo, secret-bearing query, timeout, and oversized response', async () => {
    const neverFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('long-lived-key'), { name: 'AbortError' })), { once: true });
    }));
    const client = createOpenAiCompatVoiceClient({
      credentialResolver: resolverWithKey(),
      fetch: neverFetch,
      resolveAddresses: async () => ['93.184.216.34'],
      timeoutMs: 10,
    });
    await expect(client.modelsList({
      ...publicConnection,
      baseUrl: 'https://user:secret@gateway.example.test/v1',
    })).resolves.toMatchObject({ ok: false, errorCode: 'endpoint_invalid' });
    await expect(client.modelsList({
      ...publicConnection,
      baseUrl: 'https://gateway.example.test/v1?api_key=secret',
    })).resolves.toMatchObject({ ok: false, errorCode: 'endpoint_invalid' });
    const timeout = await client.modelsList(publicConnection);
    expect(timeout).toMatchObject({ ok: false, errorCode: 'request_timeout' });
    expect(JSON.stringify(timeout)).not.toContain('long-lived-key');

    const oversized = createOpenAiCompatVoiceClient({
      credentialResolver: resolverWithKey(),
      fetch: async () => new Response('small', {
        headers: { 'content-type': 'application/json', 'content-length': String(17 * 1024 * 1024) },
      }),
      resolveAddresses: async () => ['93.184.216.34'],
    });
    await expect(oversized.modelsList(publicConnection)).resolves.toMatchObject({
      ok: false,
      errorCode: 'response_too_large',
    });
  });

  it('implements fixed chat, transcription, and synthesis shapes without a generic fetch operation', async () => {
    const seenPaths: string[] = [];
    const client = createOpenAiCompatVoiceClient({
      credentialResolver: resolverWithKey(),
      resolveAddresses: async () => ['93.184.216.34'],
      fetch: async (input, init) => {
        const url = new URL(String(input));
        seenPaths.push(url.pathname);
        if (url.pathname.endsWith('/chat/completions')) {
          expect(init?.method).toBe('POST');
          return new Response(JSON.stringify({ choices: [{ message: { content: 'hello back' } }] }), {
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.pathname.endsWith('/audio/transcriptions')) {
          expect(init?.body).toBeInstanceOf(FormData);
          return new Response(JSON.stringify({ text: 'heard text' }), {
            headers: { 'content-type': 'application/json' },
          });
        }
        expect(url.pathname).toMatch(/\/audio\/speech$/u);
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { 'content-type': 'audio/wav' },
        });
      },
    });
    await expect(client.chat({
      ...publicConnection,
      requestId: 'chat-1',
      model: 'chat-model',
      messages: [{ role: 'user', content: 'hello' }],
    })).resolves.toEqual({ ok: true, text: 'hello back' });
    await expect(client.transcribe({
      ...publicConnection,
      requestId: 'stt-1',
      model: 'whisper-1',
      audio: { bytes: new Uint8Array(Buffer.from('wav')), mimeType: 'audio/wav', fileName: 'speech.wav' },
    })).resolves.toEqual({ ok: true, text: 'heard text' });
    await expect(client.synthesize({
      ...publicConnection,
      requestId: 'tts-1',
      model: 'tts-1', voice: 'alloy', text: 'hello', responseFormat: 'wav',
    })).resolves.toEqual({ ok: true, bytes: new Uint8Array([1, 2, 3]), mimeType: 'audio/wav' });
    expect(seenPaths).toEqual([
      '/v1/chat/completions',
      '/v1/audio/transcriptions',
      '/v1/audio/speech',
    ]);
    expect(Object.keys(client).sort()).toEqual(['cancel', 'chat', 'modelsList', 'synthesize', 'transcribe']);
  });

  it('rejects a synthesis MIME that does not match the requested format', async () => {
    const client = createOpenAiCompatVoiceClient({
      credentialResolver: resolverWithKey(),
      resolveAddresses: async () => ['93.184.216.34'],
      fetch: async () => new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'content-type': 'audio/mpeg' },
      }),
    });
    await expect(client.synthesize({
      ...publicConnection,
      requestId: 'tts-mime',
      model: 'tts-1', voice: 'alloy', text: 'hello', responseFormat: 'wav',
    })).resolves.toMatchObject({ ok: false, errorCode: 'unsupported_media_type' });
  });

  it('classifies an empty synthesis body as an invalid provider response', async () => {
    const client = createOpenAiCompatVoiceClient({
      credentialResolver: resolverWithKey(),
      resolveAddresses: async () => ['93.184.216.34'],
      fetch: async () => new Response(new Uint8Array(), {
        headers: { 'content-type': 'audio/wav' },
      }),
    });
    await expect(client.synthesize({
      ...publicConnection,
      requestId: 'tts-empty',
      model: 'tts-1', voice: 'alloy', text: 'hello', responseFormat: 'wav',
    })).resolves.toMatchObject({ ok: false, errorCode: 'provider_response_invalid' });
  });

  it('accepts synthesis media types case-insensitively and returns the canonical MIME', async () => {
    const client = createOpenAiCompatVoiceClient({
      credentialResolver: resolverWithKey(),
      resolveAddresses: async () => ['93.184.216.34'],
      fetch: async () => new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'content-type': 'Audio/WAV; charset=binary' },
      }),
    });
    await expect(client.synthesize({
      ...publicConnection,
      requestId: 'tts-case',
      model: 'tts-1', voice: 'alloy', text: 'hello', responseFormat: 'wav',
    })).resolves.toEqual({ ok: true, bytes: new Uint8Array([1, 2, 3]), mimeType: 'audio/wav' });
  });

  it('settles timeout while DNS resolution is still pending and never reads the secret', async () => {
    const resolver = resolverWithKey();
    let secretReadCalls = 0;
    const withSecret = async <T>(params: Readonly<{
      providerId: string;
      credentialSlotId: string;
      use: (secret: string) => Promise<T>;
    }>): Promise<T> => {
      secretReadCalls += 1;
      return await resolver.withSecret(params);
    };
    const client = createOpenAiCompatVoiceClient({
      credentialResolver: { status: resolver.status, withSecret },
      timeoutMs: 10,
      resolveAddresses: async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return ['93.184.216.34'];
      },
      fetch: async () => new Response('{}'),
    });
    await expect(client.modelsList(publicConnection)).resolves.toMatchObject({
      ok: false,
      errorCode: 'request_timeout',
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(secretReadCalls).toBe(0);
  });

  it('cancels exactly the matching in-flight provider request', async () => {
    const fetchBoundary = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }, { once: true });
      });
    });
    const client = createOpenAiCompatVoiceClient({
      credentialResolver: resolverWithKey(),
      fetch: fetchBoundary,
      resolveAddresses: async () => ['93.184.216.34'],
      timeoutMs: 5_000,
    });
    const pending = client.chat({
      ...publicConnection,
      requestId: 'chat-cancel',
      model: 'chat-model',
      messages: [{ role: 'user', content: 'hello' }],
    });
    await vi.waitFor(() => expect(fetchBoundary).toHaveBeenCalledTimes(1));
    expect(client.cancel('other-request')).toBe(false);
    expect(client.cancel('chat-cancel')).toBe(true);
    await expect(pending).resolves.toMatchObject({ ok: false, errorCode: 'cancelled' });
  });
});
