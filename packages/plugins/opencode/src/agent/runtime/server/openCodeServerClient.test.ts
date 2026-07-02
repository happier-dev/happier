import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FetchRuntimeRequestV1, FetchRuntimeServiceV1 } from '@happier-dev/plugin-sdk';

import { createOpenCodeServerClient } from './openCodeServerClient.js';

function createJsonResponse(body: unknown): Awaited<ReturnType<FetchRuntimeServiceV1>> {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: {},
    text: async () => JSON.stringify(body),
    json: async () => body,
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

describe('createOpenCodeServerClient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('filters providers to the connected provider ids when the OpenCode server reports them', async () => {
    const fetch = vi.fn<FetchRuntimeServiceV1>(async () => createJsonResponse({
      all: [
        { id: 'anthropic', models: { sonnet: {} } },
        { id: 'openai', models: { 'gpt-5': {} } },
        { id: 'unused', models: { local: {} } },
      ],
      connected: [' openai ', 'anthropic'],
    }));
    const client = createOpenCodeServerClient({ fetch, baseUrl: 'http://127.0.0.1:4096' });

    const providers = await client.providersList();

    expect(providers.map((provider) => provider.id)).toEqual(['anthropic', 'openai']);
    expect(fetch).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET',
      url: 'http://127.0.0.1:4096/provider',
    }));
  });

  it('filters providers when connected entries are provider specs', async () => {
    const fetch = vi.fn<FetchRuntimeServiceV1>(async () => createJsonResponse({
      all: [
        { id: 'anthropic', models: { sonnet: {} } },
        { id: 'openai', models: { 'gpt-5': {} } },
        { id: 'unused', models: { local: {} } },
      ],
      connected: [
        { id: ' openai ' },
        { id: 'anthropic' },
      ],
    }));
    const client = createOpenCodeServerClient({ fetch, baseUrl: 'http://127.0.0.1:4096' });

    const providers = await client.providersList();

    expect(providers.map((provider) => provider.id)).toEqual(['anthropic', 'openai']);
  });

  it('keeps all valid providers when the connected provider list normalizes to empty', async () => {
    const fetch = vi.fn<FetchRuntimeServiceV1>(async () => createJsonResponse({
      all: [
        { id: 'anthropic', models: { sonnet: {} } },
        { id: 'openai', models: { 'gpt-5': {} } },
      ],
      connected: [null, ' ', 42],
    }));
    const client = createOpenCodeServerClient({ fetch, baseUrl: 'http://127.0.0.1:4096' });

    const providers = await client.providersList();

    expect(providers.map((provider) => provider.id)).toEqual(['anthropic', 'openai']);
  });

  it('fetches native session todos from the OpenCode server', async () => {
    const requests: FetchRuntimeRequestV1[] = [];
    const fetch = vi.fn<FetchRuntimeServiceV1>(async (request) => {
      requests.push(request);
      return createJsonResponse([
        { id: 'todo-1', content: 'Ship runtime', status: 'in_progress' },
      ]);
    });
    const client = createOpenCodeServerClient({ fetch, baseUrl: 'http://127.0.0.1:4096' });

    await expect(client.sessionTodo({ sessionId: 'ses-1' })).resolves.toEqual([
      { id: 'todo-1', content: 'Ship runtime', status: 'in_progress' },
    ]);
    expect(requests.at(0)).toMatchObject({
      method: 'GET',
      url: 'http://127.0.0.1:4096/session/ses-1/todo',
    });
  });

  it('sends prompt variant as a top-level field instead of nesting it in config', async () => {
    const requests: FetchRuntimeRequestV1[] = [];
    const fetch = vi.fn<FetchRuntimeServiceV1>(async (request) => {
      requests.push(request);
      return createJsonResponse({});
    });
    const client = createOpenCodeServerClient({ fetch, baseUrl: 'http://127.0.0.1:4096/' });

    await client.sessionPromptAsync({
      sessionId: 'session-1',
      messageId: 'message-1',
      text: 'hello',
      variant: ' high ',
      config: {
        variant: 'low',
        temperature: 0.2,
      },
    });

    const body = JSON.parse(String(requests.at(0)?.body ?? '{}')) as Record<string, unknown>;

    expect(body).toMatchObject({
      messageID: 'message-1',
      variant: 'high',
      config: { temperature: 0.2 },
      parts: [{ type: 'text', text: 'hello' }],
    });
    expect((body.config as Record<string, unknown>).variant).toBeUndefined();
    expect(requests.at(0)?.url).toBe('http://127.0.0.1:4096/session/session-1/prompt_async');
  });

  it('lifts config variant to top-level prompt field when explicit variant is absent', async () => {
    const requests: FetchRuntimeRequestV1[] = [];
    const fetch = vi.fn<FetchRuntimeServiceV1>(async (request) => {
      requests.push(request);
      return createJsonResponse({});
    });
    const client = createOpenCodeServerClient({ fetch, baseUrl: 'http://127.0.0.1:4096/' });

    await client.sessionPromptAsync({
      sessionId: 'session-1',
      text: 'hello',
      config: {
        variant: 'medium',
        temperature: 0.2,
      },
    });

    const body = JSON.parse(String(requests.at(0)?.body ?? '{}')) as Record<string, unknown>;

    expect(body).toMatchObject({
      variant: 'medium',
      config: { temperature: 0.2 },
      parts: [{ type: 'text', text: 'hello' }],
    });
    expect((body.config as Record<string, unknown>).variant).toBeUndefined();
  });

  it('posts local MCP server registrations to the OpenCode server for the session directory', async () => {
    const requests: FetchRuntimeRequestV1[] = [];
    const fetch = vi.fn<FetchRuntimeServiceV1>(async (request) => {
      requests.push(request);
      return createJsonResponse({});
    });
    const client = createOpenCodeServerClient({ fetch, baseUrl: 'http://127.0.0.1:4096/' });

    expect(typeof (client as { mcpAdd?: unknown }).mcpAdd).toBe('function');
    await (client as {
      mcpAdd(input: Readonly<{ directory: string; name: string; config: unknown }>): Promise<void>;
    }).mcpAdd({
      directory: '/tmp/opencode-project',
      name: 'happier',
      config: {
        type: 'local',
        enabled: true,
        command: ['node', 'server.js'],
        environment: { HAPPIER_TEST_MCP: '1' },
      },
    });

    expect(requests).toHaveLength(1);
    expect(requests.at(0)?.method).toBe('POST');
    expect(requests.at(0)?.url).toBe('http://127.0.0.1:4096/mcp?directory=%2Ftmp%2Fopencode-project');
    expect(JSON.parse(String(requests.at(0)?.body ?? '{}'))).toEqual({
      name: 'happier',
      config: {
        type: 'local',
        enabled: true,
        command: ['node', 'server.js'],
        environment: { HAPPIER_TEST_MCP: '1' },
      },
    });
  });

  it('reconnects the global event stream after a read-idle timeout', async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    const firstChunks = [
      encoder.encode('id: evt-1\ndata: {"payload":{"type":"session.updated","properties":{"sessionID":"ses-1"}}}\n\n'),
    ];
    const firstReader = {
      read: () => {
        const chunk = firstChunks.shift();
        return chunk
          ? Promise.resolve({ done: false as const, value: chunk })
          : new Promise<Readonly<{ done: false; value: Uint8Array }>>(() => undefined);
      },
      cancel: vi.fn(async () => undefined),
    };
    const secondChunks = [
      encoder.encode('id: evt-2\ndata: {"payload":{"type":"session.idle","properties":{"sessionID":"ses-1"}}}\n\n'),
    ];
    const fetch = vi.fn(async () => {
      if (fetch.mock.calls.length === 1) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          body: { getReader: () => firstReader },
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        body: {
          getReader: () => ({
            read: async () => {
              const chunk = secondChunks.shift();
              return chunk ? { done: false, value: chunk } : { done: true };
            },
            cancel: vi.fn(async () => undefined),
          }),
        },
      } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetch);
    const client = createOpenCodeServerClient({
      fetch: vi.fn<FetchRuntimeServiceV1>(),
      baseUrl: 'http://127.0.0.1:4096',
    });
    const events: unknown[] = [];

    const done = client.subscribeGlobalEvents({
      signal: new AbortController().signal,
      onEvent: (event) => {
        events.push(event);
      },
    });
    await vi.advanceTimersByTimeAsync(30_001);
    await done;

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]?.[1]?.headers).not.toMatchObject({ 'Last-Event-ID': expect.any(String) });
    expect(fetch.mock.calls[1]?.[1]?.headers).toMatchObject({ 'Last-Event-ID': 'evt-1' });
    expect(firstReader.cancel).toHaveBeenCalled();
    expect(events).toEqual([
      {
        payload: {
          type: 'session.updated',
          properties: { sessionID: 'ses-1' },
        },
      },
      {
        payload: {
          type: 'session.idle',
          properties: { sessionID: 'ses-1' },
        },
      },
    ]);
  });
});
