import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FetchRuntimeRequestV1, FetchRuntimeServiceV1 } from '@happier-dev/plugin-sdk';

import { createOpenCodeServerClient, OpenCodeServerHttpError } from './openCodeServerClient.js';

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

function createErrorResponse(
  status: number,
  statusText: string,
  body = '',
): Awaited<ReturnType<FetchRuntimeServiceV1>> {
  return {
    ok: false,
    status,
    statusText,
    headers: {},
    text: async () => body,
    json: async () => ({}),
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

function createNoContentResponse(): Awaited<ReturnType<FetchRuntimeServiceV1>> {
  return {
    ok: true,
    status: 204,
    statusText: 'No Content',
    headers: {},
    text: async () => '',
    json: async () => {
      throw new SyntaxError('Unexpected end of JSON input');
    },
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
    const client = createOpenCodeServerClient({ fetch, baseUrl: 'http://127.0.0.1:49196' });

    const providers = await client.providersList();

    expect(providers.map((provider) => provider.id)).toEqual(['anthropic', 'openai']);
    expect(fetch).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET',
      url: 'http://127.0.0.1:49196/provider',
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
    const client = createOpenCodeServerClient({ fetch, baseUrl: 'http://127.0.0.1:49196' });

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
    const client = createOpenCodeServerClient({ fetch, baseUrl: 'http://127.0.0.1:49196' });

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
    const client = createOpenCodeServerClient({ fetch, baseUrl: 'http://127.0.0.1:49196' });

    await expect(client.sessionTodo({ sessionId: 'ses-1' })).resolves.toEqual([
      { id: 'todo-1', content: 'Ship runtime', status: 'in_progress' },
    ]);
    expect(requests.at(0)).toMatchObject({
      method: 'GET',
      url: 'http://127.0.0.1:49196/session/ses-1/todo',
    });
  });

  it('fetches the OpenCode global config for default-provider resolution', async () => {
    const requests: FetchRuntimeRequestV1[] = [];
    const fetch = vi.fn<FetchRuntimeServiceV1>(async (request) => {
      requests.push(request);
      return createJsonResponse({ model: 'active-provider/default-large' });
    });
    const client = createOpenCodeServerClient({ fetch, baseUrl: 'http://127.0.0.1:49196' });

    await expect(client.globalConfigGet()).resolves.toEqual({ model: 'active-provider/default-large' });
    expect(requests.at(0)).toMatchObject({
      method: 'GET',
      url: 'http://127.0.0.1:49196/global/config',
    });
  });

  it('adds the session directory query to directory-scoped session endpoints', async () => {
    const requests: FetchRuntimeRequestV1[] = [];
    const fetch = vi.fn<FetchRuntimeServiceV1>(async (request) => {
      requests.push(request);
      return createJsonResponse([]);
    });
    const client = createOpenCodeServerClient({
      fetch,
      baseUrl: 'http://127.0.0.1:49196/',
      directory: '/tmp/opencode-project',
    });

    await client.sessionPromptAsync({
      sessionId: 'session-1',
      text: 'hello',
    });
    await client.sessionStatus({ sessionId: 'session-1' });
    await client.sessionMessages({ sessionId: 'session-1' });
    await client.sessionTodo({ sessionId: 'session-1' });
    await client.sessionAbort({ sessionId: 'session-1' });

    expect(requests.map((request) => request.url)).toEqual([
      'http://127.0.0.1:49196/session/session-1/message?directory=%2Ftmp%2Fopencode-project',
      'http://127.0.0.1:49196/session/status?directory=%2Ftmp%2Fopencode-project',
      'http://127.0.0.1:49196/session/session-1/message?directory=%2Ftmp%2Fopencode-project',
      'http://127.0.0.1:49196/session/session-1/todo?directory=%2Ftmp%2Fopencode-project',
      'http://127.0.0.1:49196/session/session-1/abort?directory=%2Ftmp%2Fopencode-project',
    ]);
  });

  it('creates sessions with the directory query expected by the OpenCode server', async () => {
    const requests: FetchRuntimeRequestV1[] = [];
    const fetch = vi.fn<FetchRuntimeServiceV1>(async (request) => {
      requests.push(request);
      return createJsonResponse({ id: 'ses-1' });
    });
    const client = createOpenCodeServerClient({
      fetch,
      baseUrl: 'http://127.0.0.1:49196/',
    });

    await expect(client.sessionCreate({ directory: '/tmp/opencode-project' })).resolves.toEqual({ id: 'ses-1' });

    expect(requests).toHaveLength(1);
    expect(requests.at(0)).toMatchObject({
      method: 'POST',
      url: 'http://127.0.0.1:49196/session?directory=%2Ftmp%2Fopencode-project',
    });
    expect(JSON.parse(String(requests.at(0)?.body ?? '{}'))).not.toHaveProperty('directory');
  });

  it('reads a single session status from the directory-scoped OpenCode status list', async () => {
    const requests: FetchRuntimeRequestV1[] = [];
    const fetch = vi.fn<FetchRuntimeServiceV1>(async (request) => {
      requests.push(request);
      return createJsonResponse({
        'session-1': { type: 'busy' },
        'session-2': { type: 'idle' },
      });
    });
    const client = createOpenCodeServerClient({
      fetch,
      baseUrl: 'http://127.0.0.1:49196/',
      directory: '/tmp/opencode-project',
    });

    await expect(client.sessionStatus({ sessionId: 'session-1' })).resolves.toEqual({ type: 'busy' });
    expect(requests.at(0)?.url).toBe(
      'http://127.0.0.1:49196/session/status?directory=%2Ftmp%2Fopencode-project',
    );
  });

  it('fetches native app skills for a directory through the authenticated fetch service', async () => {
    const requests: FetchRuntimeRequestV1[] = [];
    const fetch = vi.fn<FetchRuntimeServiceV1>(async (request) => {
      requests.push(request);
      return createJsonResponse([
        { name: 'reviewer', description: 'Review code', location: '/repo/.agents/skills/reviewer/SKILL.md' },
      ]);
    });
    const client = createOpenCodeServerClient({
      fetch,
      baseUrl: 'http://127.0.0.1:49196/',
      headers: { authorization: 'Bearer managed-secret' },
    });

    await expect((client as {
      appSkills?(input: Readonly<{ directory: string }>): Promise<unknown>;
    }).appSkills?.({ directory: '/repo' })).resolves.toEqual([
      { name: 'reviewer', description: 'Review code', location: '/repo/.agents/skills/reviewer/SKILL.md' },
    ]);

    expect(requests.at(0)).toMatchObject({
      method: 'GET',
      url: 'http://127.0.0.1:49196/skill?directory=%2Frepo',
      headers: expect.objectContaining({
        authorization: 'Bearer managed-secret',
      }),
    });
  });

  it('throws a typed auth failure for unauthorized server responses', async () => {
    const fetch = vi.fn<FetchRuntimeServiceV1>(async () => createErrorResponse(401, 'Unauthorized'));
    const client = createOpenCodeServerClient({
      fetch,
      baseUrl: 'http://127.0.0.1:49196/',
      headers: { authorization: 'Bearer stale-managed-secret' },
    });

    const request = client.appSkills({ directory: '/repo' });
    await expect(request).rejects.toMatchObject({
      name: 'OpenCodeServerHttpError',
      code: 'opencode_server_auth_failed',
      status: 401,
      operation: 'skill_catalog',
    });

    await expect(request).rejects.toBeInstanceOf(OpenCodeServerHttpError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('includes a sanitized response body preview in server HTTP errors', async () => {
    const fetch = vi.fn<FetchRuntimeServiceV1>(async () => createErrorResponse(
      400,
      'Bad Request',
      'invalid prompt with authorization: Basic c2VjcmV0 and api_key=sk-live-secret',
    ));
    const client = createOpenCodeServerClient({
      fetch,
      baseUrl: 'http://127.0.0.1:49196/',
    });

    await expect(client.sessionPromptAsync({
      sessionId: 'session-1',
      text: 'hello',
    })).rejects.toMatchObject({
      name: 'OpenCodeServerHttpError',
      code: 'opencode_server_request_failed',
      status: 400,
      responseBodyPreview: expect.stringContaining('invalid prompt'),
      message: expect.stringContaining('invalid prompt'),
    });
    await expect(client.sessionPromptAsync({
      sessionId: 'session-1',
      text: 'hello',
    })).rejects.not.toMatchObject({
      message: expect.stringContaining('sk-live-secret'),
    });
  });

  it('accepts empty success responses for command-style session endpoints', async () => {
    const requests: FetchRuntimeRequestV1[] = [];
    const fetch = vi.fn<FetchRuntimeServiceV1>(async (request) => {
      requests.push(request);
      return createNoContentResponse();
    });
    const client = createOpenCodeServerClient({
      fetch,
      baseUrl: 'http://127.0.0.1:49196/',
      directory: '/tmp/opencode-project',
    });

    await expect(client.sessionPromptAsync({
      sessionId: 'session-1',
      text: 'hello',
    })).resolves.toBeUndefined();
    await expect(client.sessionAbort({ sessionId: 'session-1' })).resolves.toBeUndefined();

    expect(requests.map((request) => request.url)).toEqual([
      'http://127.0.0.1:49196/session/session-1/message?directory=%2Ftmp%2Fopencode-project',
      'http://127.0.0.1:49196/session/session-1/abort?directory=%2Ftmp%2Fopencode-project',
    ]);
  });

  it('returns successful prompt response bodies as provider evidence', async () => {
    const immediateAssistantError = {
      info: {
        id: 'msg-immediate-error',
        role: 'assistant',
        sessionID: 'session-1',
        error: {
          name: 'ProviderAuthError',
          data: {
            message: 'Token refresh failed: 401',
          },
        },
      },
      parts: [],
    };
    const fetch = vi.fn<FetchRuntimeServiceV1>(async () => createJsonResponse(immediateAssistantError));
    const client = createOpenCodeServerClient({ fetch, baseUrl: 'http://127.0.0.1:49196/' });

    await expect(client.sessionPromptAsync({
      sessionId: 'session-1',
      text: 'hello',
    })).resolves.toEqual(immediateAssistantError);
  });

  it('replies to OpenCode permission requests through the managed server', async () => {
    const requests: FetchRuntimeRequestV1[] = [];
    const fetch = vi.fn<FetchRuntimeServiceV1>(async (request) => {
      requests.push(request);
      return createNoContentResponse();
    });
    const client = createOpenCodeServerClient({
      fetch,
      baseUrl: 'http://127.0.0.1:49196/',
      headers: { authorization: 'Bearer managed-secret' },
    });

    await client.permissionReply({
      requestId: 'per_123',
      reply: 'reject',
      message: 'Denied by Happier permission policy.',
    });

    expect(requests).toHaveLength(1);
    expect(requests.at(0)).toMatchObject({
      method: 'POST',
      url: 'http://127.0.0.1:49196/permission/per_123/reply',
      headers: expect.objectContaining({
        authorization: 'Bearer managed-secret',
      }),
    });
    expect(JSON.parse(String(requests.at(0)?.body ?? '{}'))).toEqual({
      reply: 'reject',
      message: 'Denied by Happier permission policy.',
    });
  });

  it('sends prompt variant as a top-level field instead of nesting it in config', async () => {
    const requests: FetchRuntimeRequestV1[] = [];
    const fetch = vi.fn<FetchRuntimeServiceV1>(async (request) => {
      requests.push(request);
      return createJsonResponse({});
    });
    const client = createOpenCodeServerClient({ fetch, baseUrl: 'http://127.0.0.1:49196/' });

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
    expect(requests.at(0)?.url).toBe('http://127.0.0.1:49196/session/session-1/message');
  });

  it('serializes the selected model as the OpenCode server model object', async () => {
    const requests: FetchRuntimeRequestV1[] = [];
    const fetch = vi.fn<FetchRuntimeServiceV1>(async (request) => {
      requests.push(request);
      return createJsonResponse({});
    });
    const client = createOpenCodeServerClient({ fetch, baseUrl: 'http://127.0.0.1:49196/' });
    const input = {
      sessionId: 'session-1',
      text: 'hello',
      model: {
        providerID: 'opencode',
        modelID: 'big-pickle',
      },
    };

    await client.sessionPromptAsync(input);

    const body = JSON.parse(String(requests.at(0)?.body ?? '{}')) as Record<string, unknown>;

    expect(body).toMatchObject({
      model: {
        providerID: 'opencode',
        modelID: 'big-pickle',
      },
      parts: [{ type: 'text', text: 'hello' }],
    });
  });

  it('lifts config variant to top-level prompt field when explicit variant is absent', async () => {
    const requests: FetchRuntimeRequestV1[] = [];
    const fetch = vi.fn<FetchRuntimeServiceV1>(async (request) => {
      requests.push(request);
      return createJsonResponse({});
    });
    const client = createOpenCodeServerClient({ fetch, baseUrl: 'http://127.0.0.1:49196/' });

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
    const client = createOpenCodeServerClient({ fetch, baseUrl: 'http://127.0.0.1:49196/' });

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
    expect(requests.at(0)?.url).toBe('http://127.0.0.1:49196/mcp?directory=%2Ftmp%2Fopencode-project');
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
      baseUrl: 'http://127.0.0.1:49196',
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
