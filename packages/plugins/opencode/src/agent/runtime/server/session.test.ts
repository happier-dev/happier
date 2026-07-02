import { describe, expect, it, vi } from 'vitest';

import type { PluginContextV1, TranscriptSourceDefinitionV1 } from '@happier-dev/plugin-sdk';

import { createOpenCodeServerSessionRuntime } from './session.js';

function createContextFixture(): PluginContextV1 {
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    managedServer: {
      supervise: vi.fn(async () => ({
        snapshot: () => ({
          id: 'opencode-server',
          state: 'healthy',
          pid: 123,
          startedAt: 100,
          lastHealthyAt: 101,
          lastErrorMessage: null,
        }),
        waitUntilHealthy: vi.fn(async () => ({
          id: 'opencode-server',
          state: 'healthy',
          pid: 123,
          startedAt: 100,
          lastHealthyAt: 101,
          lastErrorMessage: null,
        })),
        dispose: vi.fn(async () => undefined),
      })),
    },
    transcripts: {
      append: vi.fn(async () => undefined),
      defineSource: vi.fn(async (definition: { id: string }) => ({
        id: definition.id,
        dispose: vi.fn(async () => undefined),
      })),
    },
    mcp: {
      resolveForSession: vi.fn(async () => []),
      list: vi.fn(async () => []),
      startServer: vi.fn(),
      createClient: vi.fn(),
    },
    session: {
      permissions: {
        getMode: vi.fn(() => 'default'),
        requestDecision: vi.fn(async () => ({ decision: 'approved' })),
      },
    },
    sessions: {
      writeStateField: vi.fn(async () => undefined),
    },
    events: {
      emit: vi.fn(async () => undefined),
      subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
    },
    telemetry: {
      emit: vi.fn(),
    },
    timeout: {
      withMs: vi.fn(async (_timeoutMs: number, operation: (signal: AbortSignal) => Promise<unknown>) =>
        await operation(new AbortController().signal)),
      withBudget: vi.fn(async (_budget: unknown, operation: (signal: AbortSignal) => Promise<unknown>) =>
        await operation(new AbortController().signal)),
    },
    fetch: vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: {},
      text: async () => '',
      json: async () => ({}),
      arrayBuffer: async () => new ArrayBuffer(0),
    })),
  } as unknown as PluginContextV1;
}

describe('createOpenCodeServerSessionRuntime', () => {
  it('formats prompt errors without exposing stack frames or sensitive values', async () => {
    const ctx = createContextFixture();
    const plan = await createOpenCodeServerSessionRuntime({
      ctx,
      sessionParams: {
        cwd: '/tmp/opencode-project',
        sessionId: 'happy-session-1',
      },
    });

    const error = new Error('request failed with Authorization: Bearer sk-live-secret');
    error.stack = [
      'Error: request failed with Authorization: Bearer sk-live-secret',
      '    at sendPrompt (/Users/leeroy/Documents/Development/happier/dev/packages/plugins/opencode/src/agent/runtime/server/runtime.ts:12:34)',
    ].join('\n');

    const formatted = plan.config.formatPromptErrorMessage(error);

    expect(formatted).toContain('Error: request failed');
    expect(formatted).not.toContain('/Users/leeroy');
    expect(formatted).not.toContain('runtime.ts');
    expect(formatted).not.toContain('sk-live-secret');
  });

  it('returns a host session plan whose runtime consumes plugin context substrates', async () => {
    const ctx = createContextFixture();
    const plan = await createOpenCodeServerSessionRuntime({
      ctx,
      sessionParams: {
        cwd: '/tmp/opencode-project',
        sessionId: 'happy-session-1',
      },
    });

    expect(plan).toMatchObject({
      kind: 'hostSessionRuntimePlan',
      providerId: 'opencode',
      config: {
        backendDisplayName: 'OpenCode',
        providerName: 'opencode',
      },
    });

    const runtime = await plan.config.createSessionRuntime?.({
      directory: '/tmp/opencode-project',
      session: { sessionId: 'happy-session-1' },
      mcpServers: {
        happier: {
          command: 'node',
          args: ['server.js'],
          env: { HAPPIER_TEST_MCP: '1' },
        },
      },
      getPermissionMode: () => 'default',
      setThinking: vi.fn(),
    });

    const supervise = vi.mocked(ctx.managedServer.supervise);
    expect(supervise).toHaveBeenCalledWith(expect.objectContaining({
      id: 'opencode-server',
      launch: expect.objectContaining({
        kind: 'agent-cli',
        agentId: 'opencode',
        args: ['serve', '--hostname', '127.0.0.1'],
        cwd: '/tmp/opencode-project',
      }),
    }));
    expect(supervise.mock.calls[0]?.[0]).not.toHaveProperty('restart');
    const managedHandle = await supervise.mock.results[0]?.value;
    expect(managedHandle?.waitUntilHealthy).toHaveBeenCalledWith({ timeoutMs: 30_000 });
    expect(ctx.transcripts.defineSource).toHaveBeenCalledWith(expect.objectContaining({
      id: 'opencode:happy-session-1:http-sse',
      page: expect.any(Function),
      readAfter: expect.any(Function),
      acquireFollowLease: expect.any(Function),
    }));
    expect(ctx.mcp.resolveForSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'happy-session-1',
      directory: '/tmp/opencode-project',
    }));
    expect(ctx.fetch).toHaveBeenCalledWith(expect.objectContaining({
      method: 'POST',
      url: 'http://127.0.0.1:4096/mcp?directory=%2Ftmp%2Fopencode-project',
      body: JSON.stringify({
        name: 'happier',
        config: {
          type: 'local',
          enabled: true,
          command: ['node', 'server.js'],
          environment: { HAPPIER_TEST_MCP: '1' },
        },
      }),
    }));
    expect(ctx.session.permissions.getMode).toHaveBeenCalled();

    expect(runtime).toMatchObject({
      beginTurnLifecycle: expect.any(Function),
      startOrLoadSession: expect.any(Function),
      sendTurnPrompt: expect.any(Function),
      waitForTurnCompletion: expect.any(Function),
      cancelTurn: expect.any(Function),
      resetOrDisposeRuntime: expect.any(Function),
    });
  });

  it('registers resolved remote MCP endpoints and leaves redacted local specs unsupported', async () => {
    const ctx = createContextFixture();
    vi.mocked(ctx.mcp.resolveForSession).mockResolvedValue(Object.freeze([
      {
        id: 'docs',
        name: 'docs',
        transport: { kind: 'http', url: 'https://mcp.example.test/http' },
        scope: { sessionId: 'happy-session-1', directory: '/tmp/opencode-project' },
      },
      {
        id: 'local-http',
        name: 'local-http',
        transport: { kind: 'http', url: 'http://127.0.0.1:4133/mcp' },
        scope: { sessionId: 'happy-session-1', directory: '/tmp/opencode-project' },
      },
      {
        id: 'stream',
        name: 'stream',
        transport: { kind: 'sse', url: 'https://mcp.example.test/sse' },
        scope: { sessionId: 'happy-session-1', directory: '/tmp/opencode-project' },
      },
      {
        id: 'local-redacted',
        name: 'local-redacted',
        transport: { kind: 'stdio' },
        scope: { sessionId: 'happy-session-1', directory: '/tmp/opencode-project' },
      },
      {
        id: 'managed',
        name: 'managed',
        transport: { kind: 'managed', url: 'http://127.0.0.1:4123/mcp' },
        scope: { sessionId: 'happy-session-1', directory: '/tmp/opencode-project' },
      },
      {
        id: 'managed-without-url',
        name: 'managed-without-url',
        transport: { kind: 'managed' },
        scope: { sessionId: 'happy-session-1', directory: '/tmp/opencode-project' },
      },
      {
        id: 'hosted',
        name: 'hosted',
        transport: { kind: 'hosted' },
        scope: { sessionId: 'happy-session-1', directory: '/tmp/opencode-project' },
      },
    ]));
    const plan = await createOpenCodeServerSessionRuntime({
      ctx,
      sessionParams: {
        cwd: '/tmp/opencode-project',
        sessionId: 'happy-session-1',
      },
    });

    await plan.config.createSessionRuntime({
      directory: '/tmp/opencode-project',
      session: { sessionId: 'happy-session-1' },
      getPermissionMode: () => 'default',
    });

    const mcpBodies = vi.mocked(ctx.fetch).mock.calls
      .filter(([request]) => request.method === 'POST' && request.url.includes('/mcp?directory='))
      .map(([request]) => JSON.parse(String(request.body ?? '{}')) as unknown);

    expect(mcpBodies).toHaveLength(4);
    expect(mcpBodies).toEqual(expect.arrayContaining([
      {
        name: 'docs',
        config: {
          type: 'remote',
          enabled: true,
          url: 'https://mcp.example.test/http',
        },
      },
      {
        name: 'local-http',
        config: {
          type: 'remote',
          enabled: true,
          url: 'http://127.0.0.1:4133/mcp',
        },
      },
      {
        name: 'managed',
        config: {
          type: 'remote',
          enabled: true,
          url: 'http://127.0.0.1:4123/mcp',
        },
      },
      {
        name: 'stream',
        config: {
          type: 'remote',
          enabled: true,
          url: 'https://mcp.example.test/sse',
        },
      },
    ]));
    expect(mcpBodies).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'local-redacted' }),
      expect.objectContaining({ name: 'managed-without-url' }),
      expect.objectContaining({ name: 'hosted' }),
    ]));
  });

  it('rejects unsafe resolved remote MCP endpoints before OpenCode registration', async () => {
    const ctx = createContextFixture();
    vi.mocked(ctx.mcp.resolveForSession).mockResolvedValue(Object.freeze([
      {
        id: 'ftp',
        name: 'ftp',
        transport: { kind: 'http', url: 'ftp://mcp.example.test/http' },
        scope: { sessionId: 'happy-session-1', directory: '/tmp/opencode-project' },
      },
      {
        id: 'file',
        name: 'file',
        transport: { kind: 'sse', url: 'file:///tmp/mcp.sock' },
        scope: { sessionId: 'happy-session-1', directory: '/tmp/opencode-project' },
      },
      {
        id: 'malformed',
        name: 'malformed',
        transport: { kind: 'http', url: 'not-a-url' },
        scope: { sessionId: 'happy-session-1', directory: '/tmp/opencode-project' },
      },
      {
        id: 'credentials',
        name: 'credentials',
        transport: { kind: 'http', url: 'https://user:pass@mcp.example.test/http' },
        scope: { sessionId: 'happy-session-1', directory: '/tmp/opencode-project' },
      },
      {
        id: 'empty',
        name: 'empty',
        transport: { kind: 'http', url: '   ' },
        scope: { sessionId: 'happy-session-1', directory: '/tmp/opencode-project' },
      },
      {
        id: 'local-redacted',
        name: 'local-redacted',
        transport: { kind: 'stdio' },
        scope: { sessionId: 'happy-session-1', directory: '/tmp/opencode-project' },
      },
      {
        id: 'hosted',
        name: 'hosted',
        transport: { kind: 'hosted' },
        scope: { sessionId: 'happy-session-1', directory: '/tmp/opencode-project' },
      },
      {
        id: 'managed-without-url',
        name: 'managed-without-url',
        transport: { kind: 'managed' },
        scope: { sessionId: 'happy-session-1', directory: '/tmp/opencode-project' },
      },
      {
        id: 'managed-ftp',
        name: 'managed-ftp',
        transport: { kind: 'managed', url: 'ftp://127.0.0.1:4123/mcp' },
        scope: { sessionId: 'happy-session-1', directory: '/tmp/opencode-project' },
      },
      {
        id: 'managed-credentials',
        name: 'managed-credentials',
        transport: { kind: 'managed', url: 'http://token:secret@127.0.0.1:4123/mcp' },
        scope: { sessionId: 'happy-session-1', directory: '/tmp/opencode-project' },
      },
    ]));
    const plan = await createOpenCodeServerSessionRuntime({
      ctx,
      sessionParams: {
        cwd: '/tmp/opencode-project',
        sessionId: 'happy-session-1',
      },
    });

    await plan.config.createSessionRuntime({
      directory: '/tmp/opencode-project',
      session: { sessionId: 'happy-session-1' },
      getPermissionMode: () => 'default',
    });

    const mcpBodies = vi.mocked(ctx.fetch).mock.calls
      .filter(([request]) => request.method === 'POST' && request.url.includes('/mcp?directory='))
      .map(([request]) => JSON.parse(String(request.body ?? '{}')) as unknown);

    expect(mcpBodies).toEqual([]);
  });

  it('registers transcript source readers backed by the active OpenCode provider session', async () => {
    const transcriptDefinitionCalls: TranscriptSourceDefinitionV1[] = [];
    const ctx = createContextFixture();
    vi.mocked(ctx.transcripts.defineSource).mockImplementation(async (definition: TranscriptSourceDefinitionV1) => {
      transcriptDefinitionCalls.push(definition);
      return {
        id: definition.id,
        dispose: vi.fn(async () => undefined),
      };
    });
    vi.mocked(ctx.fetch).mockImplementation(async (request) => {
      if (request.url.endsWith('/session') && request.method === 'POST') {
        return {
          ok: true,
          status: 200,
          headers: {},
          text: async () => JSON.stringify({ id: 'oc-session-1' }),
          json: async () => ({ id: 'oc-session-1' }),
          arrayBuffer: async () => new ArrayBuffer(0),
        };
      }
      if (request.url.endsWith('/session/oc-session-1/message') && request.method === 'GET') {
        return {
          ok: true,
          status: 200,
          headers: {},
          text: async () => JSON.stringify([
            {
              info: { id: 'msg-user', role: 'user', time: { created: 1 } },
              parts: [{ type: 'text', text: 'hello' }],
            },
            {
              info: { id: 'msg-internal', role: 'assistant', summary: true, time: { created: 2 } },
              parts: [{ type: 'text', text: 'hidden summary' }],
            },
            {
              info: { id: 'msg-agent', role: 'assistant', time: { created: 3 } },
              parts: [{ type: 'text', text: 'visible answer' }],
            },
          ]),
          json: async () => [
            {
              info: { id: 'msg-user', role: 'user', time: { created: 1 } },
              parts: [{ type: 'text', text: 'hello' }],
            },
            {
              info: { id: 'msg-internal', role: 'assistant', summary: true, time: { created: 2 } },
              parts: [{ type: 'text', text: 'hidden summary' }],
            },
            {
              info: { id: 'msg-agent', role: 'assistant', time: { created: 3 } },
              parts: [{ type: 'text', text: 'visible answer' }],
            },
          ],
          arrayBuffer: async () => new ArrayBuffer(0),
        };
      }
      throw new Error(`Unexpected request ${request.method} ${request.url}`);
    });
    const plan = await createOpenCodeServerSessionRuntime({
      ctx,
      sessionParams: {
        cwd: '/tmp/opencode-project',
        sessionId: 'happy-session-1',
      },
    });
    const runtime = await plan.config.createSessionRuntime({
      directory: '/tmp/opencode-project',
      session: { sessionId: 'happy-session-1' },
      setThinking: vi.fn(),
    });

    await (runtime as { startOrLoadSession(): Promise<unknown> }).startOrLoadSession();
    const source = transcriptDefinitionCalls[0];
    const page = await source.page({ direction: 'older', maxBytes: 100_000, maxItems: 10 });
    const tail = await source.readAfter({ cursor: 'tail', maxBytes: 100_000, maxItems: 10 });
    const afterTail = await source.readAfter({
      cursor: tail.nextCursor ?? 'tail',
      maxBytes: 100_000,
      maxItems: 10,
    });

    expect(page.items.map((item) => (item as { id?: string }).id)).toEqual(['msg-user', 'msg-agent']);
    expect(tail).toMatchObject({
      items: [],
      truncated: false,
    });
    expect(afterTail.items).toEqual([]);
    expect(ctx.fetch).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET',
      url: 'http://127.0.0.1:4096/session/oc-session-1/message',
    }));
  });
});
