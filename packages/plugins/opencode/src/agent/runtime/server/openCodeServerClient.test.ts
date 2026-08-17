import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ManagedServiceHandle,
  ManagedServiceRequest,
  ManagedServiceResponse,
  ManagedServiceSnapshot,
} from '@happier-dev/plugin-sdk/managed-services';

import {
  createOpenCodeServerClient as createOpenCodeServerClientUnderTest,
  OpenCodeServerHttpError,
} from './openCodeServerClient.js';
import { createOpenCodeServerTransport } from './transport.js';

const HEALTHY_MANAGED_SERVICE_SNAPSHOT = Object.freeze({
  id: 'opencode-server',
  state: 'healthy',
  mode: 'spawn',
  baseUrl: null,
  startedAtMs: 1,
  lastHealthyAtMs: 2,
  diagnostics: Object.freeze([]),
  diagnosticsTruncated: false,
}) satisfies ManagedServiceSnapshot;

function healthyManagedService(
  request: ManagedServiceHandle['request'],
): ManagedServiceHandle {
  return Object.freeze({
    snapshot: () => HEALTHY_MANAGED_SERVICE_SNAPSHOT,
    observe: (listener) => {
      listener(HEALTHY_MANAGED_SERVICE_SNAPSHOT);
      return { dispose() {} };
    },
    waitUntilHealthy: async () => HEALTHY_MANAGED_SERVICE_SNAPSHOT,
    stop: async () => ({ status: 'stopped' }),
    dispose: async () => undefined,
    request,
  });
}

function createClient(params: Readonly<{
  request: ManagedServiceHandle['request'];
  directory?: string | null;
}>) {
  return createOpenCodeServerClientUnderTest({
    transport: createOpenCodeServerTransport({
      managedService: healthyManagedService(params.request),
    }),
    directory: params.directory,
  });
}

function createJsonResponse(body: unknown): ManagedServiceResponse {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'application/json' },
    body: new Response(JSON.stringify(body)).body,
  };
}

function createErrorResponse(
  status: number,
  statusText: string,
  body = '',
): ManagedServiceResponse {
  return {
    ok: false,
    status,
    statusText,
    headers: {},
    body: new Response(body).body,
  };
}

function createNoContentResponse(): ManagedServiceResponse {
  return {
    ok: true,
    status: 204,
    statusText: 'No Content',
    headers: {},
    body: null,
  };
}

function createSseResponse(
  chunks: readonly Uint8Array[],
  options: Readonly<{
    keepOpen?: boolean;
    onCancel?: () => void;
  }> = {},
): ManagedServiceResponse {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'text/event-stream' },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        if (options.keepOpen !== true) controller.close();
      },
      cancel() {
        options.onCancel?.();
      },
    }),
  };
}

function readJsonRequestBody(request: ManagedServiceRequest | undefined): unknown {
  if (!request?.body) return undefined;
  return JSON.parse(new TextDecoder().decode(request.body));
}

describe('createOpenCodeServerClient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('uses the endpoint-bound transport for both JSON and directory-scoped SSE requests', async () => {
    const controller = new AbortController();
    const encoder = new TextEncoder();
    const request = vi.fn(async (input: ManagedServiceRequest) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: {
        'content-type': input.pathAndQuery === '/provider'
          ? 'application/json'
          : 'text/event-stream',
      },
      body: input.pathAndQuery === '/provider'
        ? new Response(JSON.stringify({ all: [], connected: [] })).body
        : new ReadableStream<Uint8Array>({
        start(streamController) {
          streamController.enqueue(encoder.encode(
            'data: {"type":"server.connected","properties":{}}\n\n',
          ));
          streamController.close();
        },
      }),
    } satisfies ManagedServiceResponse));
    const globalFetch = vi.fn(async () => {
      throw new Error('primary OpenCode transport bypassed its injected fetch');
    });
    vi.stubGlobal('fetch', globalFetch);
    const transport = createOpenCodeServerTransport({
      managedService: healthyManagedService(request),
    });
    const client = createOpenCodeServerClientUnderTest({
      transport,
      directory: '/tmp/opencode-project',
    });

    await client.providersList();
    await client.subscribeGlobalEvents({
      signal: controller.signal,
      onEvent: () => controller.abort(),
    });

    expect(request.mock.calls.map(([input]) => input.pathAndQuery)).toEqual([
      '/provider',
      '/event?directory=%2Ftmp%2Fopencode-project',
    ]);
    expect(request.mock.calls[0]?.[0].headers).not.toHaveProperty('authorization');
    expect(request.mock.calls[1]?.[0].headers).not.toHaveProperty('authorization');
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it('filters providers to the connected provider ids when the OpenCode server reports them', async () => {
    const request = vi.fn<ManagedServiceHandle['request']>(async () => createJsonResponse({
      all: [
        { id: 'anthropic', models: { sonnet: {} } },
        { id: 'openai', models: { 'gpt-5': {} } },
        { id: 'unused', models: { local: {} } },
      ],
      connected: [' openai ', 'anthropic'],
    }));
    const client = createClient({ request });

    const providers = await client.providersList();

    expect(providers.map((provider) => provider.id)).toEqual(['anthropic', 'openai']);
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET',
      pathAndQuery: '/provider',
    }));
  });

  it('filters providers when connected entries are provider specs', async () => {
    const request = vi.fn<ManagedServiceHandle['request']>(async () => createJsonResponse({
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
    const client = createClient({ request });

    const providers = await client.providersList();

    expect(providers.map((provider) => provider.id)).toEqual(['anthropic', 'openai']);
  });

  it('keeps all valid providers when the connected provider list normalizes to empty', async () => {
    const request = vi.fn<ManagedServiceHandle['request']>(async () => createJsonResponse({
      all: [
        { id: 'anthropic', models: { sonnet: {} } },
        { id: 'openai', models: { 'gpt-5': {} } },
      ],
      connected: [null, ' ', 42],
    }));
    const client = createClient({ request });

    const providers = await client.providersList();

    expect(providers.map((provider) => provider.id)).toEqual(['anthropic', 'openai']);
  });

  it('fetches native session todos from the OpenCode server', async () => {
    const requests: ManagedServiceRequest[] = [];
    const request = vi.fn<ManagedServiceHandle['request']>(async (input) => {
      requests.push(input);
      return createJsonResponse([
        { id: 'todo-1', content: 'Ship runtime', status: 'in_progress' },
      ]);
    });
    const client = createClient({ request });

    await expect(client.sessionTodo({ sessionId: 'ses-1' })).resolves.toEqual([
      { id: 'todo-1', content: 'Ship runtime', status: 'in_progress' },
    ]);
    expect(requests.at(0)).toMatchObject({
      method: 'GET',
      pathAndQuery: '/session/ses-1/todo',
    });
  });

  it('fetches the OpenCode global config for default-provider resolution', async () => {
    const requests: ManagedServiceRequest[] = [];
    const request = vi.fn<ManagedServiceHandle['request']>(async (input) => {
      requests.push(input);
      return createJsonResponse({ model: 'active-provider/default-large' });
    });
    const client = createClient({ request });

    await expect(client.globalConfigGet()).resolves.toEqual({ model: 'active-provider/default-large' });
    expect(requests.at(0)).toMatchObject({
      method: 'GET',
      pathAndQuery: '/global/config',
    });
  });

  it('adds the session directory query to directory-scoped session endpoints', async () => {
    const requests: ManagedServiceRequest[] = [];
    const request = vi.fn<ManagedServiceHandle['request']>(async (input) => {
      requests.push(input);
      return createJsonResponse([]);
    });
    const client = createClient({
      request,
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

    expect(requests.map((request) => request.pathAndQuery)).toEqual([
      '/session/session-1/message?directory=%2Ftmp%2Fopencode-project',
      '/session/status?directory=%2Ftmp%2Fopencode-project',
      '/session/session-1/message?directory=%2Ftmp%2Fopencode-project',
      '/session/session-1/todo?directory=%2Ftmp%2Fopencode-project',
      '/session/session-1/abort?directory=%2Ftmp%2Fopencode-project',
    ]);
  });

  it('creates sessions with the directory query expected by the OpenCode server', async () => {
    const requests: ManagedServiceRequest[] = [];
    const request = vi.fn<ManagedServiceHandle['request']>(async (input) => {
      requests.push(input);
      return createJsonResponse({ id: 'ses-1' });
    });
    const client = createClient({ request });

    await expect(client.sessionCreate({ directory: '/tmp/opencode-project' })).resolves.toEqual({ id: 'ses-1' });

    expect(requests).toHaveLength(1);
    expect(requests.at(0)).toMatchObject({
      method: 'POST',
      pathAndQuery: '/session?directory=%2Ftmp%2Fopencode-project',
    });
    expect(readJsonRequestBody(requests.at(0))).not.toHaveProperty('directory');
  });

  it('forks an OpenCode session at an exact provider message checkpoint', async () => {
    const requests: ManagedServiceRequest[] = [];
    const request = vi.fn<ManagedServiceHandle['request']>(async (input) => {
      requests.push(input);
      return createJsonResponse({ id: 'ses-child' });
    });
    const client = createClient({
      request,
      directory: '/tmp/opencode-project',
    });

    await expect(client.sessionFork({
      sessionId: 'ses-parent',
      messageId: 'msg-checkpoint',
    })).resolves.toEqual({ id: 'ses-child' });

    expect(requests).toHaveLength(1);
    expect(requests.at(0)).toMatchObject({
      method: 'POST',
      pathAndQuery: '/session/ses-parent/fork?directory=%2Ftmp%2Fopencode-project',
    });
    expect(readJsonRequestBody(requests.at(0))).toEqual({
      messageID: 'msg-checkpoint',
    });
  });

  it('reads a single session status from the directory-scoped OpenCode status list', async () => {
    const requests: ManagedServiceRequest[] = [];
    const request = vi.fn<ManagedServiceHandle['request']>(async (input) => {
      requests.push(input);
      return createJsonResponse({
        'session-1': { type: 'busy' },
        'session-2': { type: 'idle' },
      });
    });
    const client = createClient({
      request,
      directory: '/tmp/opencode-project',
    });

    await expect(client.sessionStatus({ sessionId: 'session-1' })).resolves.toEqual({ type: 'busy' });
    expect(requests.at(0)?.pathAndQuery).toBe(
      '/session/status?directory=%2Ftmp%2Fopencode-project',
    );
  });

  it('fetches native app skills through the exact managed service request transport', async () => {
    const requests: ManagedServiceRequest[] = [];
    const request = vi.fn<ManagedServiceHandle['request']>(async (input) => {
      requests.push(input);
      return createJsonResponse([
        { name: 'reviewer', description: 'Review code', location: '/repo/.agents/skills/reviewer/SKILL.md' },
      ]);
    });
    const client = createClient({ request });

    await expect(client.appSkills({ directory: '/repo' })).resolves.toEqual([
      { name: 'reviewer', description: 'Review code', location: '/repo/.agents/skills/reviewer/SKILL.md' },
    ]);

    expect(requests.at(0)).toMatchObject({
      method: 'GET',
      pathAndQuery: '/skill?directory=%2Frepo',
      headers: { 'content-type': 'application/json' },
    });
  });

  it('throws a typed auth failure for unauthorized server responses', async () => {
    const transportRequest = vi.fn<ManagedServiceHandle['request']>(
      async () => createErrorResponse(401, 'Unauthorized'),
    );
    const client = createClient({ request: transportRequest });

    const request = client.appSkills({ directory: '/repo' });
    await expect(request).rejects.toMatchObject({
      name: 'OpenCodeServerHttpError',
      code: 'opencode_server_auth_failed',
      status: 401,
      operation: 'skill_catalog',
    });

    await expect(request).rejects.toBeInstanceOf(OpenCodeServerHttpError);
    expect(transportRequest).toHaveBeenCalledTimes(1);
  });

  it('includes a sanitized response body preview in server HTTP errors', async () => {
    const request = vi.fn<ManagedServiceHandle['request']>(async () => createErrorResponse(
      400,
      'Bad Request',
      'invalid prompt with authorization: Basic c2VjcmV0 and api_key=sk-live-secret',
    ));
    const client = createClient({ request });

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
    const requests: ManagedServiceRequest[] = [];
    const request = vi.fn<ManagedServiceHandle['request']>(async (input) => {
      requests.push(input);
      return createNoContentResponse();
    });
    const client = createClient({
      request,
      directory: '/tmp/opencode-project',
    });

    await expect(client.sessionPromptAsync({
      sessionId: 'session-1',
      text: 'hello',
    })).resolves.toBeUndefined();
    await expect(client.sessionAbort({ sessionId: 'session-1' })).resolves.toBeUndefined();

    expect(requests.map((request) => request.pathAndQuery)).toEqual([
      '/session/session-1/message?directory=%2Ftmp%2Fopencode-project',
      '/session/session-1/abort?directory=%2Ftmp%2Fopencode-project',
    ]);
  });

  it('rejects non-empty malformed prompt responses instead of confirming endpoint success', async () => {
    const request = vi.fn<ManagedServiceHandle['request']>(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: {},
      body: new Response('{not-json').body,
    }));
    const client = createClient({ request });

    await expect(client.sessionPromptAsync({
      sessionId: 'session-1',
      text: 'hello',
    })).rejects.toThrow();
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
    const request = vi.fn<ManagedServiceHandle['request']>(
      async () => createJsonResponse(immediateAssistantError),
    );
    const client = createClient({ request });

    await expect(client.sessionPromptAsync({
      sessionId: 'session-1',
      text: 'hello',
    })).resolves.toEqual(immediateAssistantError);
  });

  it('replies to OpenCode permission requests through the managed server', async () => {
    const requests: ManagedServiceRequest[] = [];
    const request = vi.fn<ManagedServiceHandle['request']>(async (input) => {
      requests.push(input);
      return createNoContentResponse();
    });
    const client = createClient({ request });

    await client.permissionReply({
      requestId: 'per_123',
      reply: 'reject',
      message: 'Denied by Happier permission policy.',
    });

    expect(requests).toHaveLength(1);
    expect(requests.at(0)).toMatchObject({
      method: 'POST',
      pathAndQuery: '/permission/per_123/reply',
      headers: { 'content-type': 'application/json' },
    });
    expect(readJsonRequestBody(requests.at(0))).toEqual({
      reply: 'reject',
      message: 'Denied by Happier permission policy.',
    });
  });

  it('reads authoritative active permission and question inventories from the managed server', async () => {
    const requests: ManagedServiceRequest[] = [];
    const request = vi.fn<ManagedServiceHandle['request']>(async (input) => {
      requests.push(input);
      if (input.pathAndQuery.includes('/permission')) {
        return createJsonResponse([{ id: 'per-current', sessionID: 'session-1' }]);
      }
      return createJsonResponse([{ id: 'question-current', sessionID: 'session-1' }]);
    });
    const client = createClient({
      request,
      directory: '/repo',
    });

    await expect(client.permissionList()).resolves.toEqual([
      { id: 'per-current', sessionID: 'session-1' },
    ]);
    await expect(client.questionList()).resolves.toEqual([
      { id: 'question-current', sessionID: 'session-1' },
    ]);
    expect(requests.map((request) => ({
      method: request.method,
      pathAndQuery: request.pathAndQuery,
    }))).toEqual([
      {
        method: 'GET',
        pathAndQuery: '/permission?directory=%2Frepo',
      },
      {
        method: 'GET',
        pathAndQuery: '/question?directory=%2Frepo',
      },
    ]);
  });

  it('sends prompt variant as a top-level field instead of nesting it in config', async () => {
    const requests: ManagedServiceRequest[] = [];
    const request = vi.fn<ManagedServiceHandle['request']>(async (input) => {
      requests.push(input);
      return createJsonResponse({});
    });
    const client = createClient({ request });

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

    const body = readJsonRequestBody(requests.at(0));

    expect(body).toMatchObject({
      messageID: 'message-1',
      variant: 'high',
      config: { temperature: 0.2 },
      parts: [{ type: 'text', text: 'hello' }],
    });
    expect(body).not.toHaveProperty('config.variant');
    expect(requests.at(0)?.pathAndQuery).toBe('/session/session-1/message');
  });

  it('serializes the selected model as the OpenCode server model object', async () => {
    const requests: ManagedServiceRequest[] = [];
    const request = vi.fn<ManagedServiceHandle['request']>(async (input) => {
      requests.push(input);
      return createJsonResponse({});
    });
    const client = createClient({ request });
    const input = {
      sessionId: 'session-1',
      text: 'hello',
      model: {
        providerID: 'opencode',
        modelID: 'big-pickle',
      },
    };

    await client.sessionPromptAsync(input);

    const body = readJsonRequestBody(requests.at(0));

    expect(body).toMatchObject({
      model: {
        providerID: 'opencode',
        modelID: 'big-pickle',
      },
      parts: [{ type: 'text', text: 'hello' }],
    });
  });

  it('lifts config variant to top-level prompt field when explicit variant is absent', async () => {
    const requests: ManagedServiceRequest[] = [];
    const request = vi.fn<ManagedServiceHandle['request']>(async (input) => {
      requests.push(input);
      return createJsonResponse({});
    });
    const client = createClient({ request });

    await client.sessionPromptAsync({
      sessionId: 'session-1',
      text: 'hello',
      config: {
        variant: 'medium',
        temperature: 0.2,
      },
    });

    const body = readJsonRequestBody(requests.at(0));

    expect(body).toMatchObject({
      variant: 'medium',
      config: { temperature: 0.2 },
      parts: [{ type: 'text', text: 'hello' }],
    });
    expect(body).not.toHaveProperty('config.variant');
  });

  it('posts local MCP server registrations to the OpenCode server for the session directory', async () => {
    const requests: ManagedServiceRequest[] = [];
    const request = vi.fn<ManagedServiceHandle['request']>(async (input) => {
      requests.push(input);
      return createJsonResponse({ happier: { status: 'connected' } });
    });
    const client = createClient({ request });

    await client.mcpAdd({
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
    expect(requests.at(0)?.pathAndQuery).toBe('/mcp?directory=%2Ftmp%2Fopencode-project');
    expect(readJsonRequestBody(requests.at(0))).toEqual({
      name: 'happier',
      config: {
        type: 'local',
        enabled: true,
        command: ['node', 'server.js'],
        environment: { HAPPIER_TEST_MCP: '1' },
      },
    });
  });

  it('returns the named MCP failure status from an HTTP 200 response', async () => {
    const request = vi.fn<ManagedServiceHandle['request']>(async () => createJsonResponse({
      happier: { status: 'failed', error: 'bridge startup failed' },
    }));
    const client = createClient({ request });

    await expect(client.mcpAdd({
      directory: '/tmp/opencode-project',
      name: 'happier',
      config: {
        type: 'local',
        enabled: true,
        command: ['node', 'server.js'],
      },
    })).resolves.toEqual({
      status: 'failed',
      error: 'bridge startup failed',
    });
  });

  it('reconnects the directory-scoped event stream after a read-idle timeout', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const encoder = new TextEncoder();
    const firstChunks = [
      encoder.encode('id: evt-pre-boundary\ndata: {"type":"message.part.updated","properties":{"time":1,"part":{"type":"tool","sessionID":"ses-1","callID":"history-1","tool":"bash","state":{"status":"running"}}}}\n\n'),
      encoder.encode('id: evt-boundary-1\ndata: {"type":"server.connected","properties":{}}\n\n'),
      encoder.encode('id: evt-1\ndata: {"type":"session.updated","properties":{"sessionID":"ses-1"}}\n\n'),
    ];
    const firstStreamCancel = vi.fn();
    const secondChunks = [
      encoder.encode('id: evt-boundary-2\ndata: {"type":"server.connected","properties":{}}\n\n'),
      encoder.encode('id: evt-2\ndata: {"type":"session.idle","properties":{"sessionID":"ses-1"}}\n\n'),
    ];
    const request = vi.fn<ManagedServiceHandle['request']>(async () => {
      if (request.mock.calls.length === 1) {
        return createSseResponse(firstChunks, {
          keepOpen: true,
          onCancel: firstStreamCancel,
        });
      }
      return createSseResponse(secondChunks);
    });
    const client = createClient({ request, directory: '/repo' });
    const events: Array<Readonly<{ event: unknown; delivery: unknown }>> = [];

    const done = client.subscribeGlobalEvents({
      signal: controller.signal,
      onEvent: (event, delivery) => {
        events.push({ event, delivery });
        if (event.type === 'session.idle') controller.abort();
      },
    });
    await vi.advanceTimersByTimeAsync(30_051);
    await done;

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.map(([input]) => input.pathAndQuery)).toEqual([
      '/event?directory=%2Frepo',
      '/event?directory=%2Frepo',
    ]);
    expect(request.mock.calls[0]?.[0].headers).not.toHaveProperty('Last-Event-ID');
    expect(request.mock.calls[1]?.[0].headers).not.toHaveProperty('Last-Event-ID');
    expect(firstStreamCancel).toHaveBeenCalled();
    expect(events).toEqual([
      {
        event: {
          type: 'server.connected',
          properties: {},
        },
        delivery: expect.objectContaining({ provenance: 'connection-boundary' }),
      },
      {
        event: {
          type: 'session.updated',
          properties: { sessionID: 'ses-1' },
        },
        delivery: expect.objectContaining({ provenance: 'accepted-live' }),
      },
      {
        event: {
          type: 'server.connected',
          properties: {},
        },
        delivery: expect.objectContaining({ provenance: 'connection-boundary' }),
      },
      {
        event: {
          type: 'session.idle',
          properties: { sessionID: 'ses-1' },
        },
        delivery: expect.objectContaining({ provenance: 'accepted-live' }),
      },
    ]);
  });

  it('reconnects with bounded backoff after a transient instance event fetch failure', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const encoder = new TextEncoder();
    const secondChunks = [
      encoder.encode('data: {"type":"server.connected","properties":{}}\n\n'),
    ];
    const request = vi.fn<ManagedServiceHandle['request']>(async () => {
      if (request.mock.calls.length === 1) {
        throw new TypeError('temporary network failure');
      }
      return createSseResponse(secondChunks);
    });
    const client = createClient({ request });
    const boundaries: unknown[] = [];
    const onUnavailable = vi.fn();
    const done = client.subscribeGlobalEvents({
      signal: controller.signal,
      onUnavailable,
      onEvent: (event, delivery) => {
        boundaries.push({ event, delivery });
        controller.abort();
      },
    });
    const doneExpectation = expect(done).resolves.toBeUndefined();

    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(49);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await doneExpectation;

    expect(request).toHaveBeenCalledTimes(2);
    expect(onUnavailable).toHaveBeenCalledOnce();
    expect(onUnavailable).toHaveBeenCalledWith(expect.objectContaining({
      message: 'temporary network failure',
    }));
    expect(boundaries).toEqual([{
      event: {
        type: 'server.connected',
        properties: {},
      },
      delivery: {
        provenance: 'connection-boundary',
        connectionGeneration: 2,
      },
    }]);
  });

  it('reconnects after clean stream completion instead of leaving a dead observer', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const encoder = new TextEncoder();
    const secondChunks = [
      encoder.encode('data: {"type":"server.connected","properties":{}}\n\n'),
    ];
    const request = vi.fn<ManagedServiceHandle['request']>(async () => (
      request.mock.calls.length === 1
        ? createSseResponse([])
        : createSseResponse(secondChunks)
    ));
    const client = createClient({
      request,
    });
    const onUnavailable = vi.fn();
    const done = client.subscribeGlobalEvents({
      signal: controller.signal,
      onUnavailable,
      onEvent: (_event, delivery) => {
        if (delivery.provenance === 'connection-boundary') controller.abort();
      },
    });
    const doneExpectation = expect(done).resolves.toBeUndefined();

    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(49);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await doneExpectation;
    expect(request).toHaveBeenCalledTimes(2);
    expect(onUnavailable).toHaveBeenCalledOnce();
    expect(onUnavailable).toHaveBeenCalledWith(expect.objectContaining({
      message: 'OpenCode instance event stream ended',
    }));
  });

  it('cancels a pending reconnect backoff when the observer aborts', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const request = vi.fn<ManagedServiceHandle['request']>(async () => {
      throw new TypeError('temporary network failure');
    });
    const client = createClient({ request });
    const done = client.subscribeGlobalEvents({
      signal: controller.signal,
      onEvent() {},
    });
    const doneExpectation = expect(done).resolves.toBeUndefined();

    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(1);
    controller.abort();
    await vi.advanceTimersByTimeAsync(5_000);
    await doneExpectation;
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('keeps the subscription alive and recovers after an HTTP authentication rejection', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const encoder = new TextEncoder();
    const request = vi.fn<ManagedServiceHandle['request']>(async () => (
      request.mock.calls.length === 1
        ? {
            ok: false,
            status: 401,
            statusText: 'Unauthorized',
            headers: {},
            body: null,
          }
        : createSseResponse([
            encoder.encode('data: {"type":"server.connected","properties":{}}\n\n'),
          ])
    ));
    const client = createClient({ request });
    const onUnavailable = vi.fn();
    const done = client.subscribeGlobalEvents({
      signal: controller.signal,
      onUnavailable,
      onEvent(_event, delivery) {
        if (delivery.provenance === 'connection-boundary') controller.abort();
      },
    });
    const doneExpectation = expect(done).resolves.toBeUndefined();

    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(50);
    await doneExpectation;
    expect(request).toHaveBeenCalledTimes(2);
    expect(onUnavailable).toHaveBeenCalledOnce();
    expect(onUnavailable).toHaveBeenCalledWith(expect.objectContaining({
      name: 'OpenCodeSseHttpError',
      status: 401,
    }));
  });
});
