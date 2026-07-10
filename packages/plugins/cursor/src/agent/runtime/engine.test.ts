import { describe, expect, it, vi } from 'vitest';

import type {
  AcpRuntimeHandleV1,
  AcpSessionRuntimeV1,
  PluginContextV1,
  SessionRuntimeConfigUpdateV1,
} from '@happier-dev/plugin-sdk';
import type { RuntimeEventV1 } from '@happier-dev/plugin-sdk/experimental/runtime/session';

import { createCursorBackendEngine } from './engine.js';

function createAcpSessionRuntimeFixture(params?: Readonly<{
  subscribeRuntimeEvents?: AcpSessionRuntimeV1['subscribeRuntimeEvents'];
}>): AcpSessionRuntimeV1 {
  return {
    beginTurnLifecycle: vi.fn(),
    startOrLoadSession: vi.fn(async () => 'cursor-provider-session-1'),
    sendTurnPrompt: vi.fn(async () => undefined),
    waitForTurnCompletion: vi.fn(async () => undefined),
    subscribeRuntimeEvents: vi.fn(params?.subscribeRuntimeEvents ?? ((_handler: (event: RuntimeEventV1) => void) => () => undefined)),
    cancelTurn: vi.fn(async () => undefined),
    updateSessionRuntimeConfig: vi.fn(async () => undefined),
  };
}

function createPluginContextFixture(params?: Readonly<{
  handle?: AcpRuntimeHandleV1;
}>): PluginContextV1 {
  const handle = params?.handle ?? {
    runtime: {
      backendId: 'cursor',
      sessionId: 'happier-session-1',
      client: {
        request: vi.fn(),
        notify: vi.fn(),
        registerRequestHandler: vi.fn(() => () => undefined),
        registerNotificationHandler: vi.fn(() => () => undefined),
      },
      request: vi.fn(),
      notify: vi.fn(),
    },
    sessionRuntime: createAcpSessionRuntimeFixture(),
    dispose: vi.fn(async () => undefined),
  } satisfies AcpRuntimeHandleV1;
  // Boundary fixture: tests exercise the Cursor plugin contract and only need the SDK services below.
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    config: {
      values: {
        HAPPIER_CURSOR_API_ENDPOINT: 'https://cursor.example.test',
      },
    },
    env: {
      get: vi.fn((name: string) => name === 'CURSOR_API_KEY' ? 'cursor-api-key' : undefined),
      list: vi.fn(() => ({})),
    },
    agentRuntime: {
      acp: {
        createRuntime: vi.fn(async () => handle),
      },
    },
  } as unknown as PluginContextV1;
}

describe('createCursorBackendEngine', () => {
  it('creates a public session runtime that consumes shared ACP composition', async () => {
    const sessionRuntime = createAcpSessionRuntimeFixture();
    const handle = {
      runtime: {
        backendId: 'cursor',
        sessionId: 'happier-session-1',
        client: {
          request: vi.fn(),
          notify: vi.fn(),
          registerRequestHandler: vi.fn(() => () => undefined),
          registerNotificationHandler: vi.fn(() => () => undefined),
        },
        request: vi.fn(),
        notify: vi.fn(),
      },
      sessionRuntime,
      dispose: vi.fn(async () => undefined),
    } satisfies AcpRuntimeHandleV1;
    const ctx = createPluginContextFixture({ handle });
    const engine = createCursorBackendEngine(ctx);

    const runtime = await engine.runtimeCore?.createSessionRuntime({
      cwd: '/tmp/cursor',
      sessionId: 'happier-session-1',
      permissionMode: 'safe-yolo',
    });

    expect(runtime).toMatchObject({
      identity: { read: expect.any(Function) },
      events: { subscribe: expect.any(Function) },
      send: expect.any(Function),
      cancel: expect.any(Function),
      permissions: { capability: 'inline' },
      updateConfig: expect.any(Function),
      dispose: expect.any(Function),
    });
    expect(runtime?.identity.read()).toEqual({ providerSessionId: null });
    const eventHandler = vi.fn();
    const unsubscribe = runtime?.events.subscribe(eventHandler);
    await expect(runtime?.send({ v: 1, text: 'hello cursor' })).resolves.toEqual({ status: 'accepted' });
    expect(runtime?.identity.read()).toEqual({ providerSessionId: 'cursor-provider-session-1' });
    unsubscribe();
    await expect(runtime?.updateConfig?.({ modelId: 'composer-2.5' })).resolves.toBeUndefined();
    await expect(runtime?.cancel?.({ reason: 'user' })).resolves.toEqual({ status: 'cancelled' });
    await expect(runtime?.dispose('session_closed')).resolves.toBeUndefined();

    expect(sessionRuntime.startOrLoadSession).toHaveBeenCalledWith({ mcpServers: [] });
    expect(sessionRuntime.beginTurnLifecycle).toHaveBeenCalledWith();
    expect(sessionRuntime.sendTurnPrompt).toHaveBeenCalledWith('hello cursor');
    expect(sessionRuntime.subscribeRuntimeEvents).toHaveBeenCalledWith(expect.any(Function));
    expect(sessionRuntime.updateSessionRuntimeConfig).toHaveBeenCalledWith({ modelId: 'composer-2.5' });
    expect(sessionRuntime.cancelTurn).toHaveBeenCalledWith();
    expect(handle.dispose).toHaveBeenCalledWith('cursor-session-runtime-disposed');
    expect(ctx.agentRuntime.acp.createRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        backendId: 'cursor',
        transport: expect.objectContaining({
          kind: 'stdio',
        }),
      }),
      expect.objectContaining({
        sessionId: 'happier-session-1',
        cwd: '/tmp/cursor',
        permissionMode: 'safe-yolo',
        extensions: expect.objectContaining({
          requests: expect.objectContaining({
            'cursor/ask_question': expect.any(Function),
            'cursor/create_plan': expect.any(Function),
            'cursor/update_todos': expect.any(Function),
          }),
          notifications: expect.objectContaining({
            'cursor/update_todos': expect.any(Function),
          }),
        }),
        lifecycle: expect.objectContaining({
          authenticate: expect.objectContaining({
            methodId: 'cursor_login',
          }),
          initialize: expect.objectContaining({
            protocolVersion: 1,
          }),
          initializeMeta: expect.objectContaining({
            parameterizedModelPicker: true,
          }),
        }),
      }),
    );
  });

  it('ports Cursor ACP transport quirks through the plugin-owned message hook', async () => {
    const ctx = createPluginContextFixture();
    const engine = createCursorBackendEngine(ctx);
    const runtime = await engine.runtimeCore?.createSessionRuntime({
      cwd: '/tmp/cursor',
      sessionId: 'happier-session-1',
    });

    await runtime?.send({ v: 1, text: 'hello cursor' });

    const createRuntimeMock = ctx.agentRuntime.acp.createRuntime as unknown as Readonly<{
      mock: Readonly<{
        calls: readonly (readonly [Readonly<{ transport: Readonly<{
          customHandler?: Readonly<{
            onMessage?: (
              message: unknown,
              context: Readonly<{ sessionId: string; phase: 'incoming' | 'outgoing' }>,
            ) => unknown | Promise<unknown>;
          }>;
        }> }>, unknown])[];
      }>;
    }>;
    const spec = createRuntimeMock.mock.calls[0]?.[0];
    const onMessage = spec?.transport.customHandler?.onMessage;
    expect(onMessage).toEqual(expect.any(Function));

    expect(await onMessage?.({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { update: { sessionUpdate: 'plan', entries: [] } },
    }, { sessionId: 'happier-session-1', phase: 'incoming' })).toBe('suppress');

    expect(await onMessage?.({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'tool_call_update',
          content: [{
            type: 'diff',
            path: '/Users/leeroy/hello.py',
            oldText: '-- /dev/null\n',
            newText: '++ b//Users/leeroy/hello.py\nprint("hello world")',
          }],
        },
      },
    }, { sessionId: 'happier-session-1', phase: 'incoming' })).toEqual({
      kind: 'replace',
      message: {
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          update: {
            sessionUpdate: 'tool_call_update',
            content: [{
              type: 'diff',
              path: '/Users/leeroy/hello.py',
              oldText: '',
              newText: 'print("hello world")',
            }],
          },
        },
      },
    });
  });

  it('confirms provider acceptance only after Cursor ACP emits runtime evidence', async () => {
    let runtimeEventHandler: ((event: RuntimeEventV1) => void) | null = null;
    const sessionRuntime = createAcpSessionRuntimeFixture({
      subscribeRuntimeEvents: (handler) => {
        runtimeEventHandler = handler;
        return () => {
          if (runtimeEventHandler === handler) runtimeEventHandler = null;
        };
      },
    });
    const handle = {
      runtime: {
        backendId: 'cursor',
        sessionId: 'happier-session-1',
        client: {
          request: vi.fn(),
          notify: vi.fn(),
          registerRequestHandler: vi.fn(() => () => undefined),
          registerNotificationHandler: vi.fn(() => () => undefined),
        },
        request: vi.fn(),
        notify: vi.fn(),
      },
      sessionRuntime,
      dispose: vi.fn(async () => undefined),
    } satisfies AcpRuntimeHandleV1;
    const ctx = createPluginContextFixture({ handle });
    const engine = createCursorBackendEngine(ctx);
    const runtime = await engine.runtimeCore?.createSessionRuntime({
      cwd: '/tmp/cursor',
      sessionId: 'happier-session-1',
    });
    const accepted: Array<Readonly<{ userMessageSeq: number | null; userMessageSeqs?: readonly number[] }>> = [];
    runtime?.setOnPromptAcceptedByProvider?.((info) => accepted.push(info));

    await expect(runtime?.send({ v: 1, text: 'hello cursor' }, { userMessageSeq: 42 }))
      .resolves
      .toEqual({ status: 'accepted' });

    expect(accepted).toEqual([]);

    runtimeEventHandler?.({
      kind: 'message-delta',
      sessionId: 'happier-session-1',
      turnId: 'cursor-turn-1',
      delta: { text: 'hello' },
    });

    expect(accepted).toEqual([{ userMessageSeq: 42, userMessageSeqs: [42] }]);
  });

  it('publishes a provider diagnostic when Cursor completes a turn without output', async () => {
    let runtimeEventHandler: ((event: RuntimeEventV1) => void) | null = null;
    const sessionRuntime = createAcpSessionRuntimeFixture({
      subscribeRuntimeEvents: (handler) => {
        runtimeEventHandler = handler;
        return () => {
          if (runtimeEventHandler === handler) runtimeEventHandler = null;
        };
      },
    });
    const handle = {
      runtime: {
        backendId: 'cursor',
        sessionId: 'happier-session-1',
        client: {
          request: vi.fn(),
          notify: vi.fn(),
          registerRequestHandler: vi.fn(() => () => undefined),
          registerNotificationHandler: vi.fn(() => () => undefined),
        },
        request: vi.fn(),
        notify: vi.fn(),
      },
      sessionRuntime,
      dispose: vi.fn(async () => undefined),
    } satisfies AcpRuntimeHandleV1;
    const ctx = createPluginContextFixture({ handle });
    const engine = createCursorBackendEngine(ctx);
    const runtime = await engine.runtimeCore?.createSessionRuntime({
      cwd: '/tmp/cursor',
      sessionId: 'happier-session-1',
    });
    const events: RuntimeEventV1[] = [];
    runtime?.events.subscribe((event) => events.push(event));

    await expect(runtime?.send({ v: 1, text: 'hello cursor' }, { userMessageSeq: 42 }))
      .resolves
      .toEqual({ status: 'accepted' });
    runtimeEventHandler?.({
      kind: 'turn-start',
      sessionId: 'happier-session-1',
      emittedAtMs: 1,
      turnId: 'cursor-turn-1',
      startedBy: 'provider',
    });
    runtimeEventHandler?.({
      kind: 'turn-complete',
      sessionId: 'happier-session-1',
      emittedAtMs: 2,
      turnId: 'cursor-turn-1',
      agentTurnId: 'cursor-provider-turn-1',
    });

    expect(events).toEqual([
      expect.objectContaining({
        kind: 'turn-start',
        turnId: 'cursor-turn-1',
      }),
      expect.objectContaining({
        kind: 'turn-failed',
        turnId: 'cursor-turn-1',
        agentTurnId: 'cursor-provider-turn-1',
        issue: expect.objectContaining({
          code: 'cursor_empty_provider_response',
          source: 'agent_session_error',
          agentId: 'cursor',
        }),
      }),
    ]);
  });

  it('does not treat Cursor lifecycle progress as user-visible output', async () => {
    let runtimeEventHandler: ((event: RuntimeEventV1) => void) | null = null;
    const sessionRuntime = createAcpSessionRuntimeFixture({
      subscribeRuntimeEvents: (handler) => {
        runtimeEventHandler = handler;
        return () => {
          if (runtimeEventHandler === handler) runtimeEventHandler = null;
        };
      },
    });
    const handle = {
      runtime: {
        backendId: 'cursor',
        sessionId: 'happier-session-1',
        client: {
          request: vi.fn(),
          notify: vi.fn(),
          registerRequestHandler: vi.fn(() => () => undefined),
          registerNotificationHandler: vi.fn(() => () => undefined),
        },
        request: vi.fn(),
        notify: vi.fn(),
      },
      sessionRuntime,
      dispose: vi.fn(async () => undefined),
    } satisfies AcpRuntimeHandleV1;
    const ctx = createPluginContextFixture({ handle });
    const engine = createCursorBackendEngine(ctx);
    const runtime = await engine.runtimeCore?.createSessionRuntime({
      cwd: '/tmp/cursor',
      sessionId: 'happier-session-1',
    });
    const events: RuntimeEventV1[] = [];
    runtime?.events.subscribe((event) => events.push(event));

    await expect(runtime?.send({ v: 1, text: 'hello cursor' }, { userMessageSeq: 42 }))
      .resolves
      .toEqual({ status: 'accepted' });
    runtimeEventHandler?.({
      kind: 'turn-start',
      sessionId: 'happier-session-1',
      emittedAtMs: 1,
      turnId: 'cursor-turn-1',
      startedBy: 'provider',
    });
    runtimeEventHandler?.({
      kind: 'turn-progress',
      sessionId: 'happier-session-1',
      emittedAtMs: 2,
      turnId: 'cursor-turn-1',
    });
    runtimeEventHandler?.({
      kind: 'turn-agent-id-observed',
      sessionId: 'happier-session-1',
      emittedAtMs: 3,
      turnId: 'cursor-turn-1',
      agentTurnId: 'cursor-provider-turn-1',
    });
    runtimeEventHandler?.({
      kind: 'turn-complete',
      sessionId: 'happier-session-1',
      emittedAtMs: 4,
      turnId: 'cursor-turn-1',
      agentTurnId: 'cursor-provider-turn-1',
    });

    expect(events).toEqual([
      expect.objectContaining({
        kind: 'turn-start',
        turnId: 'cursor-turn-1',
      }),
      expect.objectContaining({
        kind: 'turn-progress',
        turnId: 'cursor-turn-1',
      }),
      expect.objectContaining({
        kind: 'turn-agent-id-observed',
        turnId: 'cursor-turn-1',
      }),
      expect.objectContaining({
        kind: 'turn-failed',
        turnId: 'cursor-turn-1',
        agentTurnId: 'cursor-provider-turn-1',
        issue: expect.objectContaining({
          code: 'cursor_empty_provider_response',
        }),
      }),
    ]);
  });

  it('does not treat Cursor tool-only activity as an assistant response', async () => {
    let runtimeEventHandler: ((event: RuntimeEventV1) => void) | null = null;
    const sessionRuntime = createAcpSessionRuntimeFixture({
      subscribeRuntimeEvents: (handler) => {
        runtimeEventHandler = handler;
        return () => {
          if (runtimeEventHandler === handler) runtimeEventHandler = null;
        };
      },
    });
    const handle = {
      runtime: {
        backendId: 'cursor',
        sessionId: 'happier-session-1',
        client: {
          request: vi.fn(),
          notify: vi.fn(),
          registerRequestHandler: vi.fn(() => () => undefined),
          registerNotificationHandler: vi.fn(() => () => undefined),
        },
        request: vi.fn(),
        notify: vi.fn(),
      },
      sessionRuntime,
      dispose: vi.fn(async () => undefined),
    } satisfies AcpRuntimeHandleV1;
    const ctx = createPluginContextFixture({ handle });
    const engine = createCursorBackendEngine(ctx);
    const runtime = await engine.runtimeCore?.createSessionRuntime({
      cwd: '/tmp/cursor',
      sessionId: 'happier-session-1',
    });
    const events: RuntimeEventV1[] = [];
    runtime?.events.subscribe((event) => events.push(event));

    await expect(runtime?.send({ v: 1, text: 'hello cursor' }, { userMessageSeq: 42 }))
      .resolves
      .toEqual({ status: 'accepted' });
    runtimeEventHandler?.({
      kind: 'turn-start',
      sessionId: 'happier-session-1',
      emittedAtMs: 1,
      turnId: 'cursor-turn-1',
      startedBy: 'provider',
    });
    runtimeEventHandler?.({
      kind: 'tool-call',
      sessionId: 'happier-session-1',
      emittedAtMs: 2,
      turnId: 'cursor-turn-1',
      toolCallId: 'tool-1',
      toolName: 'change_title',
      toolInput: { title: 'Session setup' },
    });
    runtimeEventHandler?.({
      kind: 'tool-result',
      sessionId: 'happier-session-1',
      emittedAtMs: 3,
      turnId: 'cursor-turn-1',
      toolCallId: 'tool-1',
      output: { ok: true },
    });
    runtimeEventHandler?.({
      kind: 'turn-complete',
      sessionId: 'happier-session-1',
      emittedAtMs: 4,
      turnId: 'cursor-turn-1',
      agentTurnId: 'cursor-provider-turn-1',
    });

    expect(events.at(-1)).toEqual(expect.objectContaining({
      kind: 'turn-failed',
      turnId: 'cursor-turn-1',
      agentTurnId: 'cursor-provider-turn-1',
      issue: expect.objectContaining({
        code: 'cursor_empty_provider_response',
      }),
    }));
  });

  it('fails empty Cursor completions even when provider terminal events use a different turn id', async () => {
    let runtimeEventHandler: ((event: RuntimeEventV1) => void) | null = null;
    const sessionRuntime = createAcpSessionRuntimeFixture({
      subscribeRuntimeEvents: (handler) => {
        runtimeEventHandler = handler;
        return () => {
          if (runtimeEventHandler === handler) runtimeEventHandler = null;
        };
      },
    });
    const handle = {
      runtime: {
        backendId: 'cursor',
        sessionId: 'happier-session-1',
        client: {
          request: vi.fn(),
          notify: vi.fn(),
          registerRequestHandler: vi.fn(() => () => undefined),
          registerNotificationHandler: vi.fn(() => () => undefined),
        },
        request: vi.fn(),
        notify: vi.fn(),
      },
      sessionRuntime,
      dispose: vi.fn(async () => undefined),
    } satisfies AcpRuntimeHandleV1;
    const ctx = createPluginContextFixture({ handle });
    const engine = createCursorBackendEngine(ctx);
    const runtime = await engine.runtimeCore?.createSessionRuntime({
      cwd: '/tmp/cursor',
      sessionId: 'happier-session-1',
    });
    const events: RuntimeEventV1[] = [];
    runtime?.events.subscribe((event) => events.push(event));

    await expect(runtime?.send({ v: 1, text: 'hello cursor' }, { userMessageSeq: 42 }))
      .resolves
      .toEqual({ status: 'accepted' });
    runtimeEventHandler?.({
      kind: 'turn-start',
      sessionId: 'happier-session-1',
      emittedAtMs: 1,
      turnId: 'host-turn-1',
      agentTurnId: 'host-provider-turn-1',
      startedBy: 'provider',
    });
    runtimeEventHandler?.({
      kind: 'tool-call',
      sessionId: 'happier-session-1',
      emittedAtMs: 2,
      turnId: 'provider-turn-1',
      toolCallId: 'tool-1',
      toolName: 'change_title',
      toolInput: { title: 'Session setup' },
    });
    runtimeEventHandler?.({
      kind: 'turn-complete',
      sessionId: 'happier-session-1',
      emittedAtMs: 3,
      turnId: 'provider-turn-1',
      agentTurnId: 'cursor-provider-turn-1',
    });

    expect(events.at(-1)).toEqual(expect.objectContaining({
      kind: 'turn-failed',
      turnId: 'provider-turn-1',
      agentTurnId: 'cursor-provider-turn-1',
      issue: expect.objectContaining({
        code: 'cursor_empty_provider_response',
      }),
    }));
  });

  it('ignores legacy plural runtime configOptions updates', async () => {
    const sessionRuntime = createAcpSessionRuntimeFixture();
    const handle = {
      runtime: {
        backendId: 'cursor',
        sessionId: 'happier-session-1',
        client: {
          request: vi.fn(),
          notify: vi.fn(),
          registerRequestHandler: vi.fn(() => () => undefined),
          registerNotificationHandler: vi.fn(() => () => undefined),
        },
        request: vi.fn(),
        notify: vi.fn(),
      },
      sessionRuntime,
      dispose: vi.fn(async () => undefined),
    } satisfies AcpRuntimeHandleV1;
    const ctx = createPluginContextFixture({ handle });
    const engine = createCursorBackendEngine(ctx);
    const runtime = await engine.runtimeCore?.createSessionRuntime({
      cwd: '/tmp/cursor',
      sessionId: 'happier-session-1',
    });

    const legacyUpdate = {
      configOptions: {
        mode: 'agent',
      },
    } as unknown as SessionRuntimeConfigUpdateV1; // Boundary fixture: stale JS callers can still send pre-freeze payloads.
    await runtime?.updateConfig?.(legacyUpdate);

    expect(sessionRuntime.updateSessionRuntimeConfig).toHaveBeenCalledWith({});
  });

  it('fails closed for execution-run creation because Cursor is session-only in v1', () => {
    const engine = createCursorBackendEngine(createPluginContextFixture());

    expect(() => engine.runtimeCore?.createExecutionRunBackend({ cwd: '/tmp/cursor' })).toThrow(
      /session backend/i,
    );
  });
});
