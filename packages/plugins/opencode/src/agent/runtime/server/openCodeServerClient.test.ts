import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import type {
  ManagedServiceHandle,
  ManagedServiceRequest,
  ManagedServiceResponse,
  ManagedServiceSnapshot,
} from '@happier-dev/plugin-sdk/managed-services';

import {
  createOpenCodeServerClient as createOpenCodeServerClientUnderTest,
  isOpenCodeServerUnsupportedOperation,
  OpenCodeServerHttpError,
} from './openCodeServerClient.js';
import type { OpenCodeServerDialect } from './dialect.js';
import { createOpenCodeServerTransport } from './transport.js';
import { createOpenCodeServerRuntime } from './runtime.js';
import { createOpenCodeSessionRuntime } from './sessionRuntime.js';
import { createContextFixture } from './assembly.managedServices.testkit.js';

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

describe('native V2 terminal transcript through the server runtime', () => {
  it('projects settled native turns once and diagnoses failed history reads without stopping the listener', async () => {
    const directory = '/repo';
    const nativeSessionId = 'ses_native_transcript';
    let eventResponse: ServerResponse | null = null;
    let messages: unknown[] = [];
    let historyUnavailable = false;
    let holdNextHistory = false;
    let releaseHistory: (() => void) | null = null;
    let uiBusy = false;
    let messageReads = 0;
    let promptCount = 0;
    let connections = 0;
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/api/event') {
        eventResponse = response;
        connections += 1;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(`data: ${JSON.stringify({ type: 'server.connected', data: {} })}\n\n`);
        return;
      }
      response.writeHead(historyUnavailable && url.pathname.endsWith('/message') ? 503 : 200, { 'content-type': 'application/json' });
      if (url.pathname === '/api/session' && request.method === 'POST') {
        response.end(JSON.stringify({ data: { id: nativeSessionId, location: { directory } } }));
      } else if (url.pathname === `/api/session/${nativeSessionId}/message`) {
        messageReads += 1;
        if (holdNextHistory) {
          holdNextHistory = false;
          const snapshot = [...messages];
          releaseHistory = () => response.end(JSON.stringify({ data: snapshot, cursor: {} }));
          return;
        }
        response.end(JSON.stringify(historyUnavailable
          ? { error: 'private upstream response must not reach the diagnostic' }
          : { data: messages, cursor: {} }));
      } else if (url.pathname.endsWith('/prompt')) {
        promptCount += 1;
        uiBusy = true;
        const created = Date.now();
        messages.push(
          { id: 'msg_ui_user', type: 'user', sessionID: nativeSessionId, text: 'Happier prompt', time: { created } },
          { id: 'msg_ui_assistant', type: 'assistant', sessionID: nativeSessionId, parentID: 'msg_ui_user',
            content: [{ id: 'part_ui', type: 'text', text: 'Happier answer' }],
            time: { created: created + 1, completed: created + 2 }, finish: 'stop' },
        );
        response.end(JSON.stringify({ data: { id: 'msg_ui_user' } }));
      } else if (url.pathname === '/api/session/active') {
        response.end(JSON.stringify({ data: uiBusy ? { [nativeSessionId]: { type: 'running' } } : {} }));
      } else {
        response.end(JSON.stringify({ data: [] }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // Managed handle's HTTP transport is the external boundary; all wire adapters, controller,
    // completion classification, dedupe and public Session event mapping below are production code.
    const client = createClient({
      directory, dialect: 'v2',
      request: async (request) => {
        const response = await fetch(`${baseUrl}${request.pathAndQuery}`, {
          method: request.method, headers: request.headers,
          ...(request.body ? { body: Buffer.from(request.body) } : {}), signal: request.signal,
        });
        return { ok: response.ok, status: response.status, statusText: response.statusText,
          headers: Object.fromEntries(response.headers), body: response.body };
      },
    });
    const ctx = createContextFixture({ managedServerBaseUrl: baseUrl });
    const operations = createOpenCodeServerRuntime({
      ctx, directory, happierSessionId: 'happy_native_transcript', client, dialect: 'v2',
      mcpRegistration: Promise.resolve({ requiredHappier: { status: 'ready' }, registeredServers: [] }),
      mcpProjection: { registrations: [], requiredHappierServerName: null, requiredHappierConfigurationPresent: false },
    });
    const runtime = createOpenCodeSessionRuntime({
      operations, request: { kind: 'create', sessionId: 'happy_native_transcript', cwd: directory },
      disposeOperations: async () => { await operations.resetOrDisposeRuntime(); },
      runtimeCapabilities: { sessionCapabilities: {}, tools: { delivery: 'native_mcp', support: 'supported' } },
    });
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(event));
    const transcript = () => events.filter((event) => event.kind === 'transcript-message-committed');
    const emit = (type: string, sessionID = nativeSessionId): void => {
      eventResponse?.write(`data: ${JSON.stringify({ type, location: { directory }, data: { sessionID } })}\n\n`);
    };
    const disconnectEvents = (): void => { eventResponse?.end(); };
    try {
      await operations.openSession({ kind: 'create' });
      await expect.poll(() => connections).toBe(1);
      // Exclude initial connection catch-up as the cause of the following native-turn projection.
      await expect.poll(() => messageReads).toBe(1);
      messages = [
        { id: 'msg_native_user', type: 'user', sessionID: nativeSessionId,
          text: 'native prompt', time: { created: 1790952429917 } },
        { id: 'msg_native_assistant', type: 'assistant', sessionID: nativeSessionId,
          parentID: 'msg_native_user', content: [{ id: 'part_native', type: 'text', text: 'native answer', state: { phase: 'final_answer' } }],
          time: { created: 1790952429940, streamed: 1790952431559, completed: 1790952431560 }, finish: 'stop' },
      ];
      const initialReads = messageReads;
      emit('session.execution.succeeded', 'ses_other');
      emit('session.execution.started');
      emit('session.execution.succeeded');
      await expect.poll(transcript).toEqual([
        expect.objectContaining({ messageId: `opencode:${nativeSessionId}:msg_native_user`, role: 'user', text: 'native prompt' }),
        expect.objectContaining({ messageId: `opencode:${nativeSessionId}:msg_native_assistant`, role: 'assistant', text: 'native answer' }),
      ]);
      expect(messageReads).toBe(initialReads + 1);
      emit('session.execution.succeeded');
      await expect.poll(() => messageReads).toBe(initialReads + 2);
      disconnectEvents();
      await expect.poll(() => connections).toBe(2);
      await expect.poll(() => messageReads).toBe(initialReads + 3);
      expect(transcript()).toHaveLength(2);

      historyUnavailable = true;
      emit('session.execution.succeeded');
      await expect.poll(() => vi.mocked(ctx.logger.warn).mock.calls).toContainEqual([
        'opencode_passive_transcript_projection_failed', { phase: 'history_read' },
      ]);
      expect(JSON.stringify(vi.mocked(ctx.logger.warn).mock.calls)).not.toContain('private upstream response');
      historyUnavailable = false;
      messages.push({ id: 'msg_native_user_2', type: 'user', sessionID: nativeSessionId,
        text: 'next native prompt', time: { created: 1790952431600 } });
      emit('session.execution.succeeded');
      await expect.poll(transcript).toHaveLength(3);
      expect(promptCount).toBe(0);

      messages.push({ id: 'msg_native_late', type: 'user', sessionID: nativeSessionId,
        text: 'native history returned during the app turn', time: { created: 1790952431700 } });
      holdNextHistory = true;
      emit('session.execution.succeeded');
      await expect.poll(() => releaseHistory !== null).toBe(true);
      await expect(runtime.send({
        inputIds: ['ui_input'], input: { text: 'Happier prompt' },
        delivery: { kind: 'newTurn', turnId: 'ui_turn' },
      })).resolves.toMatchObject({ status: 'admitted' });
      const releaseHeldHistory = (): void => { releaseHistory?.(); };
      releaseHeldHistory();
      uiBusy = false;
      emit('session.execution.succeeded');
      await runtime.waitForTurnCompletion();
      expect(transcript()).toHaveLength(4);
      expect(transcript()).toContainEqual(expect.objectContaining({ role: 'assistant', text: 'Happier answer' }));
      emit('session.execution.succeeded');
      await expect.poll(transcript).toHaveLength(5);
      expect(transcript().filter((event) => event.messageId === `opencode:${nativeSessionId}:msg_ui_assistant`)).toHaveLength(1);
      expect(promptCount).toBe(1);
    } finally {
      await runtime.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

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
  dialect?: OpenCodeServerDialect;
  signal?: AbortSignal;
  httpTimeoutMs?: number;
}>) {
  return createOpenCodeServerClientUnderTest({
    transport: createOpenCodeServerTransport({
      managedService: healthyManagedService(params.request),
    }),
    directory: params.directory,
    dialect: params.dialect ?? 'v1',
    signal: params.signal,
    httpTimeoutMs: params.httpTimeoutMs,
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
      dialect: 'v1',
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

  it.each(['v1', 'v2'] as const)('rejects malformed %s provider/model inventories but accepts empty', async (dialect) => {
    let payload: unknown = {};
    const request: ManagedServiceHandle['request'] = async () => createJsonResponse(payload);
    const client = createClient({ request, dialect });
    await expect(client.providersList()).rejects.toThrow(/provider inventory/i);
    payload = dialect === 'v1' ? { all: [{}] } : { data: [{}] };
    await expect(client.providersList()).rejects.toThrow(/provider inventory/i);
    payload = dialect === 'v1' ? { all: [] } : { data: [] };
    await expect(client.providersList()).resolves.toEqual([]);
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

    await client.mcpRemove({ directory: '/tmp/opencode-project', name: 'happier-session-a--happier' });
    expect(requests.at(1)).toMatchObject({
      method: 'POST',
      pathAndQuery: '/mcp/happier-session-a--happier/disconnect?directory=%2Ftmp%2Fopencode-project',
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

  it.each(['v1', 'v2'] as const)('executes native commands through the %s command route and preserves its declared attachments', async (dialect) => {
    const requests: ManagedServiceRequest[] = [];
    const request = vi.fn<ManagedServiceHandle['request']>(async (input) => {
      requests.push(input);
      return dialect === 'v2' ? createNoContentResponse() : createJsonResponse({ info: { id: 'msg_native' }, parts: [] });
    });
    const client = createClient({ request, directory: '/repo', dialect });
    const file = { type: 'file' as const, url: 'file:///repo/a.png', mime: 'image/png', filename: 'a.png' };

    await client.sessionCommand({ sessionId: 'ses-1', command: 'review', arguments: 'main', messageId: 'msg_local',
      model: { providerID: 'openai', modelID: 'gpt-5' }, agent: 'build', variant: 'high',
      parts: dialect === 'v2' ? [file, { type: 'agent', name: 'reviewer' }, { type: 'skill', id: 'native-skill-id', name: 'Reviewer', text: 'Instructions' }] : [file],
      ...(dialect === 'v2' ? { delivery: 'steer' } : {}),
    });

    expect(requests.at(-1)?.pathAndQuery).toBe(dialect === 'v2' ? '/api/session/ses-1/command' : '/session/ses-1/command?directory=%2Frepo');
    expect(readJsonRequestBody(requests.at(-1))).toEqual(dialect === 'v2'
      ? { name: 'review', text: 'main', files: [{ uri: 'file:///repo/a.png', name: 'a.png' }], agents: [{ name: 'reviewer' }], skills: [{ id: 'native-skill-id' }], delivery: 'steer' }
      : { command: 'review', arguments: 'main', messageID: 'msg_local', model: 'openai/gpt-5', agent: 'build', variant: 'high', parts: [file] });
    expect(requests.map((input) => input.pathAndQuery)).toEqual(dialect === 'v2'
      ? ['/api/session/ses-1/agent', '/api/session/ses-1/model', '/api/session/ses-1/command']
      : ['/session/ses-1/command?directory=%2Frepo']);
  });

  it('rejects unsupported V1 native command delivery and agent attachments before any server write', async () => {
    const request = vi.fn<ManagedServiceHandle['request']>(async () => createNoContentResponse());
    const client = createClient({ request });

    await expect(client.sessionCommand({ sessionId: 'ses-1', command: 'review', arguments: '', delivery: 'steer' }))
      .rejects.toMatchObject({ code: 'opencode_server_operation_unsupported', operation: 'session_command_delivery' });
    await expect(client.sessionCommand({ sessionId: 'ses-1', command: 'review', arguments: '', parts: [{ type: 'agent', name: 'reviewer' }] }))
      .rejects.toMatchObject({ code: 'opencode_server_operation_unsupported', operation: 'session_command_attachments' });
    expect(request).not.toHaveBeenCalled();
  });

  it.each(['v1', 'v2'] as const)('projects selected skills through the %s native prompt contract', async (dialect) => {
    const requests: ManagedServiceRequest[] = [];
    const client = createClient({ directory: '/repo', dialect, request: async (input) => {
      requests.push(input);
      return createJsonResponse({ data: { id: 'msg-native' } });
    } });
    await client.sessionPromptAsync({ sessionId: 'ses-1', text: 'Review this', parts: [
      { type: 'skill', id: 'opaque-native-id', name: 'Reviewer', text: 'Use reviewer instructions' },
      { type: 'text', text: 'Review this' },
    ] });
    expect(readJsonRequestBody(requests.at(-1))).toEqual(dialect === 'v2'
      ? { text: 'Review this', skills: [{ id: 'opaque-native-id' }] }
      : { parts: [{ type: 'text', text: 'Use reviewer instructions', synthetic: true }, { type: 'text', text: 'Review this' }] });
    expect(requests).toHaveLength(1);
  });

  it.each(['prompt', 'command'] as const)('resolves legacy V2 skills with native name/path before %s admission', async (operation) => {
    const requests: ManagedServiceRequest[] = [];
    const skillPath = '/repo/folder/SKILL.md';
    const client = createClient({ directory: '/repo', dialect: 'v2', request: async (input) => {
      requests.push(input);
      return input.method === 'GET' ? createJsonResponse({ data: [
        { id: 'exact-id', name: 'Reviewer', path: skillPath },
        { id: 'other-id', name: 'Reviewer', path: '/other/SKILL.md' },
      ] }) : createNoContentResponse();
    } });
    const skill = { type: 'skill' as const, name: 'Reviewer', path: skillPath, text: 'Legacy instructions' };
    if (operation === 'prompt') await client.sessionPromptAsync({ sessionId: 'ses-1', text: 'Review this',
      parts: [{ type: 'text', text: 'Review this' }, skill] });
    else await client.sessionCommand({ sessionId: 'ses-1', command: 'review', arguments: 'Review this', parts: [skill] });
    expect(requests.find((request) => request.pathAndQuery.startsWith('/api/skill?'))?.pathAndQuery).toBe('/api/skill?location%5Bdirectory%5D=%2Frepo');
    expect(readJsonRequestBody(requests.at(-1))).toEqual({
      ...(operation === 'command' ? { name: 'review' } : {}), text: 'Review this', skills: [{ id: 'exact-id' }],
    });
  });

  it.each(['prompt', 'command'] as const)('rejects ambiguous legacy V2 skills before %s native effects', async (operation) => {
    const requests: ManagedServiceRequest[] = [];
    const client = createClient({ directory: '/repo', dialect: 'v2', request: async (input) => {
      requests.push(input);
      return createJsonResponse({ data: [{ id: 'one', name: 'Reviewer' }, { id: 'two', name: 'Reviewer' }] });
    } });
    const parts = [{ type: 'skill' as const, name: 'Reviewer', text: 'Legacy instructions' }];
    const input = { sessionId: 'ses-1', agent: 'build', model: { providerID: 'openai', modelID: 'gpt-5' }, parts };
    const outcome = operation === 'prompt' ? client.sessionPromptAsync({ ...input, text: '' })
      : client.sessionCommand({ ...input, command: 'review', arguments: '' });
    await expect(outcome).rejects.toMatchObject({ code: 'opencode_skill_identity_missing' });
    expect(requests.filter((request) => request.method === 'POST')).toEqual([]);
  });

  it.each(['v1', 'v2'] as const)('discovers directory-scoped native commands after %s activation', async (dialect) => {
    const requests: ManagedServiceRequest[] = [];
    const commands = [{ name: 'review', description: 'Review the current change' }];
    let ready = false;
    const request = vi.fn<ManagedServiceHandle['request']>(async (input) => {
      requests.push(input);
      if (input.pathAndQuery.startsWith('/api/integration?')) {
        expect(input.pathAndQuery).toBe('/api/integration?location%5Bdirectory%5D=%2Fother');
        ready = true;
        return createJsonResponse({ data: [] });
      }
      return createJsonResponse(dialect === 'v2' ? { data: ready ? commands : [] } : commands);
    });
    const client = createClient({ request, directory: '/repo', dialect });

    await expect(client.appCommands({ directory: '  /other  ' })).resolves.toEqual(commands);
    expect(requests.find((request) => request.pathAndQuery.startsWith(dialect === 'v2' ? '/api/command?' : '/command?'))).toMatchObject({
      method: 'GET',
      pathAndQuery: dialect === 'v2' ? '/api/command?location%5Bdirectory%5D=%2Fother' : '/command?directory=%2Fother',
    });
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

  it('resolves every route directory through the one client owner, never the serializer', async () => {
    // The query serializer encodes the bytes it is given, so a Happier-owned
    // path is canonicalized by `resolveDirectory` before it gets there — and
    // that owner is also what supplies the session directory when a call names
    // none, exactly as the `/session/*` routes already behave.
    const requests: ManagedServiceRequest[] = [];
    const request = vi.fn<ManagedServiceHandle['request']>(async (input) => {
      requests.push(input);
      return createJsonResponse([]);
    });
    const client = createClient({ request, directory: '/repo' });

    await client.appSkills({ directory: '  /other  ' });
    await client.appSkills({});

    expect(requests.map((entry) => entry.pathAndQuery)).toEqual([
      '/skill?directory=%2Fother',
      '/skill?directory=%2Frepo',
    ]);
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

  it('preserves the current upstream FilePartInput fields on the V1 prompt wire', async () => {
    const requests: ManagedServiceRequest[] = [];
    const request = vi.fn<ManagedServiceHandle['request']>(async (input) => {
      requests.push(input);
      return createJsonResponse({});
    });
    const client = createClient({ request });
    const filePart = {
      type: 'file' as const,
      mime: 'image/png',
      filename: 'screen.png',
      url: 'data:image/png;base64,iVBORw0KGgo=',
    };

    await client.sessionPromptAsync({
      sessionId: 'session-1',
      text: 'Inspect this',
      parts: [{ type: 'text', text: 'Inspect this' }, filePart],
    });

    expect(readJsonRequestBody(requests.at(0))).toMatchObject({
      parts: [{ type: 'text', text: 'Inspect this' }, filePart],
    });
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

  it('keeps a healthy directory-scoped event stream across a quiet interval', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const encoder = new TextEncoder();
    const request = vi.fn<ManagedServiceHandle['request']>(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'text/event-stream' },
      body: new ReadableStream<Uint8Array>({
        start(streamController) {
          streamController.enqueue(encoder.encode(
            'id: evt-boundary-1\ndata: {"type":"server.connected","properties":{}}\n\n',
          ));
          streamController.enqueue(encoder.encode(
            'id: evt-1\ndata: {"type":"session.updated","properties":{"sessionID":"ses-1"}}\n\n',
          ));
          setTimeout(() => {
            streamController.enqueue(encoder.encode(
              'id: evt-2\ndata: {"type":"session.idle","properties":{"sessionID":"ses-1"}}\n\n',
            ));
            streamController.close();
          }, 31_000);
        },
      }),
    }));
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
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(950);
    await done;

    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0].pathAndQuery).toBe('/event?directory=%2Frepo');
    expect(request.mock.calls[0]?.[0].headers).not.toHaveProperty('Last-Event-ID');
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

describe('createOpenCodeServerClient (OpenCode V2 beta dialect)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  // Route/body/envelope expectations below are the pinned standalone-V2
  // contract at `70a24697ea0028e19f22712fd63059538cb4bee7`:
  // `comparators/opencode/packages/protocol/src/api.ts` composes only `/api/*`
  // groups, `.../groups/location.ts` declares the deepObject `location` query
  // that `packages/server/src/location.ts` reads as `location[directory]`, and
  // `.../middleware/session-location.ts` resolves session-scoped routes from the
  // stored session row instead of a query parameter.
  it('creates a session through the V2 route, location body and data envelope', async () => {
    const requests: ManagedServiceRequest[] = [];
    const request = vi.fn<ManagedServiceHandle['request']>(async (input) => {
      requests.push(input);
      return createJsonResponse({ data: { id: 'ses-created', title: 'new' } });
    });
    const client = createClient({
      request,
      directory: '/tmp/opencode-project',
      dialect: 'v2',
    });

    await expect(client.sessionCreate({
      directory: '/tmp/opencode-project',
      permissions: [{ permission: 'bash', pattern: '*', action: 'ask' }],
    }))
      .resolves.toEqual({ id: 'ses-created' });

    expect(requests.at(0)?.pathAndQuery).toBe('/api/session');
    expect(requests.at(0)?.method).toBe('POST');
    expect(readJsonRequestBody(requests.at(0))).toEqual({
      location: { directory: '/tmp/opencode-project' },
      permissions: [{ action: 'bash', resource: '*', effect: 'ask' }],
    });
  });

  it('updates released V2 session permissions with the strict rule shape', async () => {
    const requests: ManagedServiceRequest[] = [];
    const request = vi.fn<ManagedServiceHandle['request']>(async (input) => {
      requests.push(input);
      return createNoContentResponse();
    });
    const client = createClient({ request, directory: '/repo', dialect: 'v2' });

    await client.sessionUpdatePermissions({
      sessionId: 'ses-1',
      permissions: [{ permission: 'read', pattern: '*.env', action: 'deny' }],
    });

    expect(requests.at(0)?.pathAndQuery).toBe('/api/session/ses-1');
    expect(requests.at(0)?.method).toBe('PATCH');
    expect(readJsonRequestBody(requests.at(0))).toEqual({
      permissions: [{ action: 'read', resource: '*.env', effect: 'deny' }],
    });
  });

  it('selects the model on its own V2 route before admitting the prompt', async () => {
    const requests: ManagedServiceRequest[] = [];
    const request = vi.fn<ManagedServiceHandle['request']>(async (input) => {
      requests.push(input);
      if (input.pathAndQuery.endsWith('/model')) return createNoContentResponse();
      return createJsonResponse({ data: { id: 'msg_1', admittedSeq: 4 } });
    });
    const client = createClient({ request, directory: '/repo', dialect: 'v2' });

    // Released V2 `session.prompt` takes the flat PromptInput fields and carries
    // no model, so a per-prompt model is a `session.switchModel` call first.
    await expect(client.sessionPromptAsync({
      sessionId: 'ses-1',
      messageId: 'msg_1',
      text: 'hello',
      parts: [{ type: 'text', text: 'hello' }, { type: 'agent', name: 'reviewer' }],
      model: { providerID: 'anthropic', modelID: 'claude-opus-5' },
      variant: 'thinking',
    })).resolves.toEqual({ id: 'msg_1', admittedSeq: 4 });

    expect(requests.map((entry) => entry.pathAndQuery)).toEqual([
      '/api/session/ses-1/model',
      '/api/session/ses-1/prompt',
    ]);
    expect(readJsonRequestBody(requests.at(0))).toEqual({
      model: { id: 'claude-opus-5', providerID: 'anthropic', variant: 'thinking' },
    });
    expect(readJsonRequestBody(requests.at(1))).toEqual({
      id: 'msg_1',
      text: 'hello',
      agents: [{ name: 'reviewer' }],
    });
  });

  it('interrupts and admits manual compaction through released V2 routes', async () => {
    const requests: ManagedServiceRequest[] = [];
    const request = vi.fn<ManagedServiceHandle['request']>(async (input) => {
      requests.push(input);
      return createNoContentResponse();
    });
    const client = createClient({ request, directory: '/repo', dialect: 'v2' });

    await client.sessionAbort({ sessionId: 'ses-1' });
    await client.sessionSummarize({
      sessionId: 'ses-1',
      model: { providerID: 'anthropic', modelID: 'claude-opus-5' },
      auto: false,
    });

    expect(requests.map((entry) => entry.pathAndQuery)).toEqual([
      '/api/session/ses-1/interrupt',
      '/api/session/ses-1/compact',
    ]);
    expect(readJsonRequestBody(requests.at(1))).toEqual({});
  });

  it('derives session busy/idle status from the V2 active-session drain list', async () => {
    const request = vi.fn<ManagedServiceHandle['request']>(async () => createJsonResponse({
      data: { 'ses-busy': { type: 'running' } },
    }));
    const client = createClient({ request, directory: '/repo', dialect: 'v2' });

    await expect(client.sessionStatus({ sessionId: 'ses-busy' })).resolves.toEqual({ type: 'busy' });
    await expect(client.sessionStatus({ sessionId: 'ses-other' })).resolves.toEqual({ type: 'idle' });
    expect(request.mock.calls[0]?.[0].pathAndQuery).toBe('/api/session/active');
  });

  it('reconciles exact-parent V2 child sessions against the active-session inventory', async () => {
    const requests: ManagedServiceRequest[] = [];
    const request = vi.fn<ManagedServiceHandle['request']>(async (input) => {
      requests.push(input);
      if (input.pathAndQuery === '/api/session/active') {
        return createJsonResponse({
          data: { 'child / running': { type: 'running' } },
        });
      }
      if (input.pathAndQuery.includes('cursor=')) {
        return createJsonResponse({
          data: [
            { id: 'child-completed', parentID: 'parent-1', title: 'Done' },
            { id: 'other-child', parentID: 'other-parent', title: 'Other' },
          ],
          cursor: {},
        });
      }
      return createJsonResponse({
        data: [
          { id: 'child / running', parentID: 'parent-1', title: 'Running' },
          { id: 'top-level', title: 'Top level' },
        ],
        cursor: { next: ' cursor / 2 ' },
      });
    });
    const client = createClient({ request, directory: '/repo', dialect: 'v2' });

    await expect(client.sessionChildInventory({ parentSessionId: 'parent-1' }))
      .resolves.toEqual([
        {
          info: { id: 'child / running', parentID: 'parent-1', title: 'Running' },
          status: 'running',
        },
        {
          info: { id: 'child-completed', parentID: 'parent-1', title: 'Done' },
          status: 'completed',
        },
    ]);

    expect(requests).toHaveLength(3);
    expect(requests[0]?.pathAndQuery).toBe('/api/session?directory=%2Frepo');
    expect(requests[1]?.pathAndQuery).toBe('/api/session?cursor=+cursor+%2F+2+');
    expect(requests[2]?.pathAndQuery).toBe('/api/session/active');
  });

  it('pages V2 session messages in order and normalizes them into the projection shape', async () => {
    const requests: ManagedServiceRequest[] = [];
    const request = vi.fn<ManagedServiceHandle['request']>(async (input) => {
      requests.push(input);
      if (input.pathAndQuery.includes('cursor=')) {
        return createJsonResponse({
          data: [{
            id: 'msg_2',
            type: 'assistant',
            agent: 'build',
            model: { id: 'claude-opus-5', providerID: 'anthropic' },
            finish: 'stop',
            content: [
              { type: 'text', id: 'prt_1', text: '  done\n' },
              { type: 'reasoning', id: 'prt_reasoning', text: '\tthink exactly  ' },
              // Semantic text validates its type only: a non-string is omitted,
              // never coerced into bytes the provider did not author.
              { type: 'reasoning', id: 'prt_not_text', text: ['not', 'text'] },
              {
                type: 'tool',
                id: 'call_1',
                name: 'bash',
                state: {
                  status: 'completed',
                  input: { command: 'ls' },
                  content: [{ type: 'text', text: ' README.md\n' }],
                  structured: {},
                },
                time: { created: 30, completed: 40 },
              },
            ],
            time: { created: 30, completed: 40 },
          }],
          cursor: {},
        });
      }
      return createJsonResponse({
        data: [
          // A user message whose `text` is not a string carries no text part.
          { id: 'msg_0', type: 'user', text: 7, time: { created: 5 } },
          { id: 'msg_1', type: 'user', text: '  hi\n', time: { created: 10 } },
          { id: 'msg_synthetic', type: 'synthetic', text: '<subagent-completion>private injected result</subagent-completion>', metadata: { source: 'subagent', childID: 'ses_child' }, time: { created: 20 } },
        ],
        // The server minted this cursor; the continuation must send it back
        // byte-for-byte, surrounding whitespace and newline included.
        cursor: { next: '  cur/2==\n' },
      });
    });
    const client = createClient({ request, directory: '/repo', dialect: 'v2' });

    const messages = await client.sessionMessages({ sessionId: 'ses-1' });

    expect(requests.map((entry) => entry.pathAndQuery)).toEqual([
      '/api/session/ses-1/message?order=asc',
      '/api/session/ses-1/message?cursor=++cur%2F2%3D%3D%0A',
    ]);
    expect(messages).toEqual([
      {
        info: { id: 'msg_0', role: 'user', sessionID: 'ses-1', time: { created: 5 } },
        parts: [],
      },
      {
        info: { id: 'msg_1', role: 'user', sessionID: 'ses-1', time: { created: 10 } },
        parts: [{ type: 'text', text: '  hi\n' }],
      },
      {
        info: { id: 'msg_synthetic', role: 'user', synthetic: true, metadata: { source: 'subagent', childID: 'ses_child' }, sessionID: 'ses-1', time: { created: 20 } },
        parts: [],
      },
      {
        info: {
          id: 'msg_2',
          role: 'assistant',
          sessionID: 'ses-1',
          // V2 carries no parentID; the ordered preceding user message is the
          // only evidence for the anchor the current projection requires.
          parentID: 'msg_1',
          finish: 'stop',
          time: { created: 30, completed: 40 },
        },
        parts: [
          { type: 'text', text: '  done\n' },
          { type: 'reasoning', text: '\tthink exactly  ' },
          {
            type: 'tool',
            sessionID: 'ses-1',
            messageID: 'msg_2',
            callID: 'call_1',
            tool: 'bash',
            state: { status: 'completed', input: { command: 'ls' }, output: ' README.md\n' },
          },
        ],
      },
    ]);
  });

  it.each(['v1', 'v2'] as const)('rejects malformed %s history instead of treating it as an empty native conversation', async (dialect) => {
    let malformed = true;
    const client = createClient({ dialect, request: async () => createJsonResponse(dialect === 'v2'
      ? { data: malformed ? {} : [], cursor: {} } : malformed ? {} : []) });
    await expect(client.sessionMessages({ sessionId: 'native' })).rejects.toThrow('OpenCode session message page is invalid');
    malformed = false;
    await expect(client.sessionMessages({ sessionId: 'native' })).resolves.toEqual([]);
  });

  it('reads and answers V2 permission requests through their location and session routes', async () => {
    const requests: ManagedServiceRequest[] = [];
    const request = vi.fn<ManagedServiceHandle['request']>(async (input) => {
      requests.push(input);
      if (input.method === 'POST') return createNoContentResponse();
      return createJsonResponse({
        location: { directory: '/repo' },
        data: [{
          id: 'per_1',
          sessionID: 'ses-1',
          action: 'bash',
          resources: ['ls *'],
          metadata: { reason: 'listing' },
        }],
      });
    });
    const client = createClient({ request, directory: '/repo', dialect: 'v2' });

    // V2 `action` is the permission name and `resources` replaces `patterns`;
    // without that remap the permission bridge reads the request as malformed.
    await expect(client.permissionList()).resolves.toEqual([{
      id: 'per_1',
      sessionID: 'ses-1',
      permission: 'bash',
      patterns: ['ls *'],
      metadata: { reason: 'listing' },
    }]);

    await client.permissionReply({
      sessionId: 'ses-1',
      requestId: 'per_1',
      reply: 'once',
      message: 'ok',
    });

    expect(requests.map((entry) => entry.pathAndQuery)).toEqual([
      '/api/permission/request?location%5Bdirectory%5D=%2Frepo',
      '/api/session/ses-1/permission/per_1/reply',
    ]);
    expect(readJsonRequestBody(requests.at(1))).toEqual({ decision: 'once', message: 'ok' });
  });

  it('projects and answers released V2 forms through the incumbent question owner', async () => {
    const requests: ManagedServiceRequest[] = [];
    const request = vi.fn<ManagedServiceHandle['request']>(async (input) => {
      requests.push(input);
      if (input.method === 'POST' || input.method === 'DELETE') return createNoContentResponse();
      return createJsonResponse({
        location: { directory: '/repo' },
        data: [{
          id: 'form_1',
          sessionID: 'ses-1',
          title: 'Release',
          fields: [{ key: 'ship', type: 'string', title: 'Ship', description: 'Ship it?', options: [{ label: 'Yes', value: 'opaque yes' }] }],
        }],
      });
    });
    const client = createClient({ request, directory: '/repo', dialect: 'v2' });

    await expect(client.questionList()).resolves.toEqual([{
      id: 'form_1',
      sessionID: 'ses-1',
      questions: [{ question: 'Ship it?', header: 'Ship', options: [{ label: 'Yes' }], multiple: false, formTitle: 'Release' }],
    }]);
    await client.questionReply({ sessionId: 'ses-1', requestId: 'form_1', answers: [['Yes']] });
    await client.questionReject({ sessionId: 'ses-1', requestId: 'form_1' });

    expect(requests.map((entry) => entry.pathAndQuery)).toEqual([
      '/api/form?location%5Bdirectory%5D=%2Frepo',
      '/api/session/ses-1/form/form_1/reply',
      '/api/session/ses-1/form/form_1',
    ]);
    expect(readJsonRequestBody(requests.at(1))).toEqual({ answer: { ship: 'opaque yes' } });
  });

  it('reads V2 skills after native activation, including an empty catalog after reload', async () => {
    const requests: ManagedServiceRequest[] = [];
    let ready = false;
    let skills = [{ name: 'review', location: '/repo/.opencode/skills/review', content: '' }];
    const request = vi.fn<ManagedServiceHandle['request']>(async (input) => {
      requests.push(input);
      if (input.pathAndQuery.startsWith('/api/integration?')) {
        expect(input.pathAndQuery).toBe('/api/integration?location%5Bdirectory%5D=%2Frepo');
        ready = true;
        return createJsonResponse({ data: [] });
      }
      return createJsonResponse({ location: { directory: '/repo' }, data: ready ? skills : [] });
    });
    const client = createClient({ request, directory: '/repo', dialect: 'v2' });

    await expect(client.appSkills({ directory: '/repo' })).resolves.toEqual([
      { name: 'review', location: '/repo/.opencode/skills/review', content: '' },
    ]);
    ready = false;
    skills = [];
    await expect(client.appSkills({ directory: '/repo' })).resolves.toEqual([]);
    expect(ready).toBe(true);
    expect(requests.every((request) => request.method === 'GET')).toBe(true);
  });

  it('propagates V2 readiness failure before reading a catalog', async () => {
    const requests: ManagedServiceRequest[] = [];
    const client = createClient({ directory: '/repo', dialect: 'v2', request: async (input) => {
      requests.push(input);
      return input.pathAndQuery.startsWith('/api/integration?')
        ? createErrorResponse(503, 'Service Unavailable') : createJsonResponse({ data: [] });
    } });
    await expect(client.appSkills({ directory: '/repo' })).rejects.toMatchObject({ status: 503 });
    expect(requests.some((request) => request.pathAndQuery.startsWith('/api/skill?'))).toBe(false);
  });

  it('combines the separate V2 provider and model inventories into one provider list', async () => {
    const requests: ManagedServiceRequest[] = [];
    const request = vi.fn<ManagedServiceHandle['request']>(async (input) => {
      requests.push(input);
      if (input.pathAndQuery.startsWith('/api/model')) {
        return createJsonResponse({
          location: { directory: '/repo' },
          data: [
            { id: 'claude-opus-5', providerID: 'anthropic', name: 'Opus 5', status: 'active' },
            { id: 'gpt-5', providerID: 'openai', name: 'GPT-5', status: 'active' },
          ],
        });
      }
      return createJsonResponse({
        location: { directory: '/repo' },
        data: [{ id: 'anthropic', name: 'Anthropic' }, { id: 'openai', name: 'OpenAI' }],
      });
    });
    const client = createClient({ request, directory: '/repo', dialect: 'v2' });

    // V2 `Provider.Info` carries no `models` map and no `env`; models are their
    // own location-scoped inventory keyed back by `providerID`.
    await expect(client.providersList()).resolves.toEqual([
      {
        id: 'anthropic',
        models: {
          'claude-opus-5': { id: 'claude-opus-5', providerID: 'anthropic', name: 'Opus 5', status: 'active' },
        },
      },
      {
        id: 'openai',
        models: { 'gpt-5': { id: 'gpt-5', providerID: 'openai', name: 'GPT-5', status: 'active' } },
      },
    ]);
    expect(requests.map((entry) => entry.pathAndQuery)).toEqual([
      '/api/provider?location%5Bdirectory%5D=%2Frepo',
      '/api/model?location%5Bdirectory%5D=%2Frepo',
    ]);
  });

  it('uses released V2 MCP and fork routes while keeping truly absent operations typed', async () => {
    const requests: ManagedServiceRequest[] = [];
    const request = vi.fn<ManagedServiceHandle['request']>(async (input) => {
      requests.push(input);
      if (input.method === 'PUT') return createNoContentResponse();
      if (input.pathAndQuery.startsWith('/api/mcp')) {
        return createJsonResponse({ location: { directory: '/repo' }, data: [{ name: 'happier', status: { status: 'connected' } }] });
      }
      if (input.pathAndQuery.endsWith('/fork')) return createJsonResponse({ data: { id: 'ses-child' } });
      return createJsonResponse({});
    });
    const client = createClient({ request, directory: '/repo', dialect: 'v2' });

    await expect(client.mcpAdd({ directory: '/repo', name: 'happier', config: { type: 'local', command: ['echo'], environment: {}, disabled: false } }))
      .resolves.toEqual({ status: 'connected' });
    await client.mcpRemove({ directory: '/repo', name: 'happier' });
    expect(requests).toContainEqual(expect.objectContaining({
      method: 'DELETE',
      pathAndQuery: '/api/experimental/mcp/happier?location%5Bdirectory%5D=%2Frepo',
    }));
    await expect(client.sessionFork({ sessionId: 'ses-1', messageId: 'msg-before' }))
      .resolves.toEqual({ id: 'ses-child' });
    await expect(client.sessionTodo({ sessionId: 'ses-1' }))
      .rejects.toSatisfy((error: unknown) => isOpenCodeServerUnsupportedOperation(error, 'session_todo'));
    await expect(client.globalConfigGet())
      .rejects.toSatisfy((error: unknown) => isOpenCodeServerUnsupportedOperation(error, 'global_config'));
    await expect(client.sessionPromptAsync({
      sessionId: 'ses-1',
      text: 'hi',
      config: { temperature: 0.2 },
    })).rejects.toSatisfy((error: unknown) => (
      isOpenCodeServerUnsupportedOperation(error, 'session_prompt_config')
    ));
    // An effort-only control must resolve this exact native session's model; absence fails closed.
    await expect(client.sessionPromptAsync({
      sessionId: 'ses-1',
      text: 'hi',
      variant: 'high',
    })).rejects.toThrow('OpenCode session model is unavailable for reasoning selection');

    expect(requests.slice(0, 4).map((entry) => entry.pathAndQuery)).toEqual([
      '/api/experimental/mcp/happier?location%5Bdirectory%5D=%2Frepo',
      '/api/mcp?location%5Bdirectory%5D=%2Frepo',
      '/api/experimental/mcp/happier?location%5Bdirectory%5D=%2Frepo',
      '/api/session/ses-1/fork',
    ]);
    expect(readJsonRequestBody(requests.at(0))).toEqual({
      config: { type: 'local', command: ['echo'], environment: {}, disabled: false },
    });
    expect(readJsonRequestBody(requests.at(3))).toEqual({ before: 'msg-before' });
  });

  it('settles released V2 pending MCP status before returning the terminal result', async () => {
    vi.useFakeTimers();
    const statuses = [
      { status: 'pending' },
      { status: 'connected' },
    ];
    const request = vi.fn<ManagedServiceHandle['request']>(async (input) => {
      if (input.method === 'PUT') return createNoContentResponse();
      return createJsonResponse({
        location: { directory: '/repo' },
        data: [{ name: 'happier', status: statuses.shift() }],
      });
    });
    const client = createClient({ request, directory: '/repo', dialect: 'v2' });

    const registration = client.mcpAdd({
      directory: '/repo',
      name: 'happier',
      config: { type: 'local', command: ['echo'] },
    });
    await vi.advanceTimersByTimeAsync(100);

    await expect(registration).resolves.toEqual({ status: 'connected' });
    expect(request).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it('returns a released V2 terminal MCP failure without polling again', async () => {
    const request = vi.fn<ManagedServiceHandle['request']>(async (input) => {
      if (input.method === 'PUT') return createNoContentResponse();
      return createJsonResponse({
        location: { directory: '/repo' },
        data: [{ name: 'happier', status: { status: 'failed', error: 'bridge failed' } }],
      });
    });
    const client = createClient({ request, directory: '/repo', dialect: 'v2' });

    await expect(client.mcpAdd({
      directory: '/repo',
      name: 'happier',
      config: { type: 'local', command: ['echo'] },
    })).resolves.toEqual({ status: 'failed', error: 'bridge failed' });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('returns pending when released V2 does not settle within the client HTTP budget', async () => {
    vi.useFakeTimers();
    const request = vi.fn<ManagedServiceHandle['request']>(async (input) => {
      if (input.method === 'PUT') return createNoContentResponse();
      return createJsonResponse({
        location: { directory: '/repo' },
        data: [{ name: 'happier', status: { status: 'pending' } }],
      });
    });
    const client = createClient({ request, directory: '/repo', dialect: 'v2', httpTimeoutMs: 150 });

    const registration = client.mcpAdd({
      directory: '/repo',
      name: 'happier',
      config: { type: 'local', command: ['echo'] },
    });
    await vi.advanceTimersByTimeAsync(150);

    await expect(registration).resolves.toEqual({ status: 'pending' });
    expect(request).toHaveBeenCalledTimes(4);
    vi.useRealTimers();
  });

  it('cancels released V2 pending MCP settling with the client lifecycle', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const request = vi.fn<ManagedServiceHandle['request']>(async (input) => {
      if (input.method === 'PUT') return createNoContentResponse();
      return createJsonResponse({
        location: { directory: '/repo' },
        data: [{ name: 'happier', status: { status: 'pending' } }],
      });
    });
    const client = createClient({
      request,
      directory: '/repo',
      dialect: 'v2',
      signal: controller.signal,
    });

    const registration = client.mcpAdd({
      directory: '/repo',
      name: 'happier',
      config: { type: 'local', command: ['echo'] },
    });
    await Promise.resolve();
    controller.abort(new Error('runtime disposed'));

    await expect(registration).rejects.toThrow('runtime disposed');
    vi.useRealTimers();
  });

  it('admits an ordinary V2 prompt with neither a model nor a variant', async () => {
    // The guards above must stay conditions, not a blanket V2 prompt block.
    const requests: ManagedServiceRequest[] = [];
    const request = vi.fn<ManagedServiceHandle['request']>(async (input) => {
      requests.push(input);
      return createJsonResponse({ data: { id: 'msg_1' } });
    });
    const client = createClient({ request, directory: '/repo', dialect: 'v2' });

    await expect(client.sessionPromptAsync({
      sessionId: 'ses-1',
      text: 'hi',
      parts: [
        { type: 'text', text: 'hi' },
        {
          type: 'file',
          mime: 'image/png',
          filename: 'screen.png',
          url: 'data:image/png;base64,iVBORw0KGgo=',
        },
      ],
    }))
      .resolves.toEqual({ id: 'msg_1' });
    expect(requests.map((entry) => entry.pathAndQuery)).toEqual(['/api/session/ses-1/prompt']);
    expect(readJsonRequestBody(requests.at(0))).toEqual({
      text: 'hi',
      files: [{
        uri: 'data:image/png;base64,iVBORw0KGgo=',
        name: 'screen.png',
      }],
    });
  });

  it('subscribes to the live V2 event stream and normalizes its exact upstream frame shape', async () => {
    const controller = new AbortController();
    const encoder = new TextEncoder();
    // Exact pinned upstream frame shape
    // (`comparators/opencode/packages/server/src/handlers/event.ts` at
    // `70a24697ea0028e19f22712fd63059538cb4bee7`): every event is encoded as
    // `{ _tag: 'Event', event: 'message', id: undefined, data }`, merged with a
    // 15-second `": heartbeat"` comment stream. No frame carries an SSE id — the
    // event id exists only inside the JSON payload.
    const request = vi.fn<ManagedServiceHandle['request']>(async () => createSseResponse([
      encoder.encode('event: message\ndata: {"id":"evt_0","type":"server.connected","data":{}}\n\n'),
      encoder.encode(': heartbeat\n\n'),
      encoder.encode('event: message\ndata: {"id":"evt_1","type":"session.updated","data":{"sessionID":"ses-1"},"location":{"directory":"/repo"}}\n\n'),
      encoder.encode('event: message\ndata: {"id":"evt_2","type":"session.idle","data":{"sessionID":"ses-9"},"location":{"directory":"/elsewhere"}}\n\n'),
    ]));
    const client = createClient({ request, directory: '/repo', dialect: 'v2' });
    const events: Array<Readonly<{ event: unknown; delivery: unknown }>> = [];

    const done = client.subscribeGlobalEvents({
      signal: controller.signal,
      onEvent: (event, delivery) => {
        events.push({ event, delivery });
        if (event.type === 'session.updated') controller.abort();
      },
    });
    await done;

    expect(request.mock.calls[0]?.[0].pathAndQuery).toBe('/api/event');
    expect(request.mock.calls[0]?.[0].headers).not.toHaveProperty('last-event-id');
    expect(events).toEqual([
      {
        event: { type: 'server.connected', properties: {} },
        delivery: expect.objectContaining({ provenance: 'connection-boundary' }),
      },
      {
        event: { type: 'session.updated', properties: { sessionID: 'ses-1' } },
        delivery: expect.objectContaining({ provenance: 'accepted-live' }),
      },
    ]);
  });

  it('uses the released V2 global event stream for durable and live frames', async () => {
    const controller = new AbortController();
    const encoder = new TextEncoder();
    const requests: ManagedServiceRequest[] = [];
    const request = vi.fn<ManagedServiceHandle['request']>(async (input) => {
      requests.push(input);
      if (input.pathAndQuery === '/api/event') {
        return createSseResponse([
          encoder.encode('data: {"id":"live_0","type":"server.connected","data":{}}\n\n'),
          encoder.encode('data: {"id":"live_1","type":"session.text.delta","data":{"sessionID":"ses/owned","assistantMessageID":"msg_1","ordinal":0,"delta":"live"},"location":{"directory":"/repo"}}\n\n'),
          encoder.encode('data: {"id":"live_2","type":"permission.asked","data":{"id":"per_1","sessionID":"ses/owned","action":"bash","resources":["git status"]},"location":{"directory":"/repo"}}\n\n'),
          encoder.encode('data: {"id":"evt_42","type":"session.text.ended","durable":{"aggregateID":"ses/owned","seq":42,"version":1},"data":{"sessionID":"ses/owned","assistantMessageID":"msg_1","ordinal":0,"text":"first"}}\n\n'),
        ]);
      }
      throw new Error(`Unexpected request: ${input.pathAndQuery}`);
    });
    const client = createClient({ request, directory: '/repo', dialect: 'v2' });
    const events: Array<{ event: unknown; provenance: string }> = [];

    const done = client.subscribeGlobalEvents({
      sessionId: 'ses/owned',
      signal: controller.signal,
      onEvent: (event, delivery) => {
        if (delivery.provenance !== 'connection-boundary') {
          events.push({ event, provenance: delivery.provenance });
        }
        if (event.type === 'permission.asked') controller.abort();
      },
    });
    await done;

    expect(requests.map((entry) => entry.pathAndQuery)).toEqual(['/api/event']);
    expect(events).toEqual(expect.arrayContaining([
      { event: { type: 'message.part.delta', properties: expect.objectContaining({ messageID: 'msg_1', delta: 'live' }) }, provenance: 'accepted-live' },
      { event: { type: 'permission.asked', properties: expect.objectContaining({ id: 'per_1' }) }, provenance: 'accepted-live' },
    ]));
  });

  it('reconnects the V2 stream as a fresh live subscription with no event-id resume', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const encoder = new TextEncoder();
    // Adversarial fixture: these frames *do* carry SSE ids, which the pinned
    // upstream handler never emits. Happier must still not send `Last-Event-ID`
    // and must not treat a reconnect as a replay, because the upstream route
    // reads no request header and subscribes a bounded live stream
    // (`EventV2.allBounded(events, 256)`) with no backlog.
    const request = vi.fn<ManagedServiceHandle['request']>(async () => {
      if (request.mock.calls.length === 1) {
        return createSseResponse([
          encoder.encode('id: evt_0\ndata: {"id":"evt_0","type":"server.connected","data":{}}\n\n'),
          encoder.encode('id: evt_7\ndata: {"id":"evt_7","type":"session.updated","data":{"sessionID":"ses-1"}}\n\n'),
        ]);
      }
      return createSseResponse([
        // A pre-boundary frame on the new connection is not admitted: nothing
        // proves it belongs to this subscription's accepted-live window.
        encoder.encode('id: evt_8\ndata: {"id":"evt_8","type":"session.updated","data":{"sessionID":"ses-stale"}}\n\n'),
        encoder.encode('event: message\ndata: {"id":"evt_9","type":"server.connected","data":{}}\n\n'),
        encoder.encode('event: message\ndata: {"id":"evt_10","type":"session.idle","data":{"sessionID":"ses-1"}}\n\n'),
      ]);
    });
    const client = createClient({ request, directory: '/repo', dialect: 'v2' });
    const events: unknown[] = [];

    const done = client.subscribeGlobalEvents({
      signal: controller.signal,
      onEvent: (event) => {
        events.push(event);
        if (event.type === 'session.idle') controller.abort();
      },
    });
    await vi.advanceTimersByTimeAsync(60);
    await done;

    expect(request).toHaveBeenCalledTimes(2);
    // The transport normalizes header names through `Headers`, so a resume
    // token would arrive lower-cased; neither casing may be present.
    expect(request.mock.calls[1]?.[0].headers).not.toHaveProperty('last-event-id');
    expect(request.mock.calls[1]?.[0].headers).not.toHaveProperty('Last-Event-ID');
    expect(events).toEqual([
      { type: 'server.connected', properties: {} },
      { type: 'session.updated', properties: { sessionID: 'ses-1' } },
      { type: 'server.connected', properties: {} },
      { type: 'session.idle', properties: { sessionID: 'ses-1' } },
    ]);
  });
});

describe('createOpenCodeServerClient provider-minted identity', () => {
  /**
   * Bytes OpenCode minted. Surrounding whitespace, the embedded newline and the
   * `/`, `+`, `=` punctuation are part of the identity: the transport hands the
   * value back to the same server, so the client may decide presence only.
   */
  const PROVIDER_MINTED_SESSION_ID = '  provider\nses/AB+cd==  ';
  const PROVIDER_MINTED_PARENT_SESSION_ID = '  provider\nses/parent+cd==  ';
  const PROVIDER_MINTED_REQUEST_ID = '  provider\nreq/AB+cd==  ';

  it('returns a created provider session id as the exact bytes the server minted', async () => {
    const request = vi.fn<ManagedServiceHandle['request']>(async () => createJsonResponse({
      id: PROVIDER_MINTED_SESSION_ID,
    }));
    const client = createClient({ request });

    await expect(client.sessionCreate({ directory: '/repo' }))
      .resolves.toEqual({ id: PROVIDER_MINTED_SESSION_ID });
  });

  it('refuses a whitespace-only session id rather than returning a blank identity', async () => {
    const request = vi.fn<ManagedServiceHandle['request']>(async () => createJsonResponse({
      id: '  \n ',
    }));
    const client = createClient({ request });

    await expect(client.sessionCreate({ directory: '/repo' }))
      .rejects.toThrow('OpenCode server response did not include a session id');
  });

  it('forks at the exact parent session bytes and returns the exact child bytes', async () => {
    const request = vi.fn<ManagedServiceHandle['request']>(async () => createJsonResponse({
      id: PROVIDER_MINTED_SESSION_ID,
    }));
    const client = createClient({ request, directory: '/repo' });

    await expect(client.sessionFork({ sessionId: PROVIDER_MINTED_PARENT_SESSION_ID }))
      .resolves.toEqual({ id: PROVIDER_MINTED_SESSION_ID });

    expect(request.mock.calls[0]?.[0].pathAndQuery).toBe(
      `/session/${encodeURIComponent(PROVIDER_MINTED_PARENT_SESSION_ID)}/fork?directory=%2Frepo`,
    );
  });

  it('routes a V2 permission reply to the exact owning session and request bytes', async () => {
    const request = vi.fn<ManagedServiceHandle['request']>(async () => createNoContentResponse());
    const client = createClient({ request, directory: '/repo', dialect: 'v2' });

    await client.permissionReply({
      sessionId: PROVIDER_MINTED_SESSION_ID,
      requestId: PROVIDER_MINTED_REQUEST_ID,
      reply: 'once',
    });

    expect(request.mock.calls[0]?.[0].pathAndQuery).toBe(
      `/api/session/${encodeURIComponent(PROVIDER_MINTED_SESSION_ID)}`
      + `/permission/${encodeURIComponent(PROVIDER_MINTED_REQUEST_ID)}/reply`,
    );
  });

  it('refuses a V2 permission reply whose owning session id is only whitespace', async () => {
    const request = vi.fn<ManagedServiceHandle['request']>(async () => createNoContentResponse());
    const client = createClient({ request, directory: '/repo', dialect: 'v2' });

    await expect(client.permissionReply({
      sessionId: '   ',
      requestId: PROVIDER_MINTED_REQUEST_ID,
      reply: 'once',
    })).rejects.toThrow('OpenCode V2 permission replies require the owning session id');

    expect(request).not.toHaveBeenCalled();
  });

  it('normalizes V2 messages with byte-exact provider message and tool-call ids', async () => {
    const userMessageId = '  provider\nmsg/user+cd==  ';
    const assistantMessageId = '  provider\nmsg/assistant+cd==  ';
    const callId = '  provider\ncall/AB+cd==  ';
    const request = vi.fn<ManagedServiceHandle['request']>(async () => createJsonResponse({
      data: [
        { id: userMessageId, type: 'user', text: 'hi', time: { created: 10 } },
        {
          id: assistantMessageId,
          type: 'assistant',
          finish: 'stop',
          content: [{
            type: 'tool',
            id: callId,
            name: 'bash',
            state: { status: 'completed' },
          }],
          time: { created: 30, completed: 40 },
        },
      ],
      cursor: {},
    }));
    const client = createClient({ request, directory: '/repo', dialect: 'v2' });

    const messages = await client.sessionMessages({ sessionId: PROVIDER_MINTED_SESSION_ID });

    expect(request.mock.calls[0]?.[0].pathAndQuery).toBe(
      `/api/session/${encodeURIComponent(PROVIDER_MINTED_SESSION_ID)}/message?order=asc`,
    );
    expect(messages).toEqual([
      {
        info: {
          id: userMessageId,
          role: 'user',
          sessionID: PROVIDER_MINTED_SESSION_ID,
          time: { created: 10 },
        },
        parts: [{ type: 'text', text: 'hi' }],
      },
      {
        info: {
          id: assistantMessageId,
          role: 'assistant',
          sessionID: PROVIDER_MINTED_SESSION_ID,
          parentID: userMessageId,
          finish: 'stop',
          time: { created: 30, completed: 40 },
        },
        parts: [{
          type: 'tool',
          sessionID: PROVIDER_MINTED_SESSION_ID,
          messageID: assistantMessageId,
          callID: callId,
          tool: 'bash',
          state: { status: 'completed' },
        }],
      },
    ]);
  });
});
