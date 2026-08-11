import { describe, expect, it, vi } from 'vitest';

import { fetchAnthropicModels, parseAnthropicModelsResponse } from './fetchAnthropicModels';

describe('parseAnthropicModelsResponse', () => {
  it('parses entries and maps snake_case fields', () => {
    const parsed = parseAnthropicModelsResponse({
      data: [
        {
          id: 'claude-opus-5',
          display_name: 'Claude Opus 5',
          max_input_tokens: 1_000_000,
          capabilities: { effort: { supported: true, high: { supported: true } } },
        },
      ],
    });
    expect(parsed).toEqual([
      {
        id: 'claude-opus-5',
        displayName: 'Claude Opus 5',
        maxInputTokens: 1_000_000,
        capabilities: { effort: { supported: true, high: { supported: true } } },
      },
    ]);
  });

  it('drops entries without a string id and returns null for non-objects / empty data', () => {
    expect(parseAnthropicModelsResponse({ data: [{ display_name: 'no id' }, { id: 'ok' }] }))
      .toEqual([{ id: 'ok' }]);
    expect(parseAnthropicModelsResponse({ data: [] })).toBeNull();
    expect(parseAnthropicModelsResponse('nope')).toBeNull();
    expect(parseAnthropicModelsResponse({})).toBeNull();
  });
});

function okResponse(): Response {
  return new Response(JSON.stringify({ data: [{ id: 'claude-opus-5' }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('fetchAnthropicModels', () => {
  it('returns null when neither api key nor access token is provided', async () => {
    const fetchImpl = vi.fn();
    const result = await fetchAnthropicModels({ timeoutMs: 1_000, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends x-api-key when an api key is provided', async () => {
    const fetchImpl = vi.fn<(input: unknown, init: { headers: Record<string, string> }) => Promise<Response>>(async () => okResponse());
    const result = await fetchAnthropicModels({
      apiKey: 'sk-ant-key',
      timeoutMs: 1_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual([{ id: 'claude-opus-5' }]);
    const headers = fetchImpl.mock.calls[0]![1].headers;
    expect(headers['x-api-key']).toBe('sk-ant-key');
    expect(headers['Authorization']).toBeUndefined();
  });

  it('sends Bearer + oauth beta header when an access token is provided', async () => {
    const fetchImpl = vi.fn<(input: unknown, init: { headers: Record<string, string> }) => Promise<Response>>(async () => okResponse());
    await fetchAnthropicModels({
      accessToken: 'sk-ant-oat01-token',
      timeoutMs: 1_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const headers = fetchImpl.mock.calls[0]![1].headers;
    expect(headers['Authorization']).toBe('Bearer sk-ant-oat01-token');
    expect(headers['anthropic-beta']).toBe('oauth-2025-04-20');
    expect(headers['x-api-key']).toBeUndefined();
  });

  it('requests the default Anthropic host when no base url is given', async () => {
    const fetchImpl = vi.fn<(input: unknown, init: { headers: Record<string, string> }) => Promise<Response>>(async () => okResponse());
    await fetchAnthropicModels({
      apiKey: 'sk-ant-key',
      timeoutMs: 1_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(String(fetchImpl.mock.calls[0]![0])).toBe('https://api.anthropic.com/v1/models?limit=1000');
  });

  it('requests the configured base url instead of the Anthropic host', async () => {
    const fetchImpl = vi.fn<(input: unknown, init: { headers: Record<string, string> }) => Promise<Response>>(async () => okResponse());
    await fetchAnthropicModels({
      apiKey: 'gateway-key',
      baseUrl: 'https://api.z.ai/api/anthropic/',
      timeoutMs: 1_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(String(fetchImpl.mock.calls[0]![0])).toBe('https://api.z.ai/api/anthropic/v1/models?limit=1000');
  });

  it('does not send credentials anywhere when an explicit base url is unusable', async () => {
    const fetchImpl = vi.fn<(input: unknown, init: { headers: Record<string, string> }) => Promise<Response>>(async () => okResponse());
    await fetchAnthropicModels({
      apiKey: 'sk-ant-key',
      baseUrl: 'not a url',
      timeoutMs: 1_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('prefers the bearer credential when both legacy inputs are present', async () => {
    const fetchImpl = vi.fn<(input: unknown, init: { headers: Record<string, string> }) => Promise<Response>>(async () => okResponse());
    await fetchAnthropicModels({
      apiKey: 'must-not-leave-process',
      accessToken: 'gateway-token',
      baseUrl: 'https://gateway.example/anthropic',
      timeoutMs: 1_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const headers = fetchImpl.mock.calls[0]![1].headers;
    expect(headers.Authorization).toBe('Bearer gateway-token');
    expect(headers['x-api-key']).toBeUndefined();
  });

  it('rejects redirects instead of forwarding credential headers', async () => {
    const fetchImpl = vi.fn<(input: unknown, init: RequestInit) => Promise<Response>>(async () => okResponse());
    await fetchAnthropicModels({
      apiKey: 'sk-ant-key',
      timeoutMs: 1_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl.mock.calls[0]![1].redirect).toBe('error');
  });

  it('returns null on a non-2xx response', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 401 }));
    const result = await fetchAnthropicModels({
      apiKey: 'sk-ant-key',
      timeoutMs: 1_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toBeNull();
  });

  it('returns null when the fetch throws', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('network'); });
    const result = await fetchAnthropicModels({
      apiKey: 'sk-ant-key',
      timeoutMs: 1_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toBeNull();
  });
});
