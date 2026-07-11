import { describe, expect, it, vi } from 'vitest';

import { createElevenLabsCredentialProviderOperations } from './provider';

describe('ElevenLabs daemon voice provider', () => {
  it('cancels an oversized streamed response before buffering the remaining body', async () => {
    let pulls = 0;
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls <= 10) {
          controller.enqueue(new Uint8Array(512 * 1024));
          return;
        }
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    const provider = createElevenLabsCredentialProviderOperations({
      fetch: vi.fn(async () => response),
    });

    await expect(provider.fetchCatalog!({
      secret: 'xi-secret',
      catalog: 'voices',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'provider_response_invalid' });
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(10);
  });

  it('cancels an unread provider error body before returning a safe failure', async () => {
    let cancelled = false;
    const provider = createElevenLabsCredentialProviderOperations({
      fetch: vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
        pull(controller) { controller.enqueue(new Uint8Array([1])); },
        cancel() { cancelled = true; },
      }), { status: 401 })),
    });

    await expect(provider.fetchCatalog!({
      secret: 'invalid-secret', catalog: 'voices', signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'provider_response_invalid' });
    expect(cancelled).toBe(true);
  });

  it('mints bounded conversation auth without returning the source key', async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('xi-api-key')).toBe('xi-secret');
      return new Response(JSON.stringify({ token: 'short-lived-token' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const provider = createElevenLabsCredentialProviderOperations({ fetch });
    const artifact = await provider.mintClientAuth!({
      secret: 'xi-secret',
      audience: 'conversation_token:agent_123',
      signal: new AbortController().signal,
    });

    expect(artifact).toMatchObject({
      kind: 'sdk_token',
      value: 'short-lived-token',
      placement: 'provider_sdk_parameter',
    });
    expect(JSON.stringify(artifact)).not.toContain('xi-secret');
  });

  it('rejects unsupported audiences before touching the provider', async () => {
    const fetch = vi.fn();
    const provider = createElevenLabsCredentialProviderOperations({ fetch });
    await expect(provider.mintClientAuth!({
      secret: 'xi-secret',
      audience: 'arbitrary:https://attacker.invalid',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'invalid_parameters' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sanitizes and bounds the voice catalog', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      voices: [
        { voice_id: 'v2', name: 'Beta', category: 'premade', preview_url: 'https://cdn.example/b.mp3' },
        { voice_id: 'v1', name: 'Alpha', labels: { accent: 'neutral' } },
        { voice_id: 'local-file', name: 'Unsafe local file', preview_url: 'file:///etc/passwd' },
        { voice_id: '', name: 'invalid' },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const provider = createElevenLabsCredentialProviderOperations({ fetch });
    await expect(provider.fetchCatalog!({
      secret: 'xi-secret',
      catalog: 'voices',
      signal: new AbortController().signal,
    })).resolves.toEqual([
      { id: 'v1', name: 'Alpha', metadata: { accent: 'neutral' } },
      { id: 'v2', name: 'Beta', metadata: { category: 'premade', previewUrl: 'https://cdn.example/b.mp3' } },
      { id: 'local-file', name: 'Unsafe local file', metadata: {} },
    ]);
  });

  it('rejects a signed-url artifact that is not a credential-free secure websocket URL', async () => {
    const provider = createElevenLabsCredentialProviderOperations({
      fetch: vi.fn(async () => new Response(JSON.stringify({ signed_url: 'file:///tmp/provider-controlled' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })),
    });

    await expect(provider.mintClientAuth!({
      secret: 'xi-secret',
      audience: 'signed_url:agent_123',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'provider_response_invalid' });
  });
});
