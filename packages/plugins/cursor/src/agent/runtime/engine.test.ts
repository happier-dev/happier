import { describe, expect, it, vi } from 'vitest';

import type {
  AcpRuntimeHandleV1,
  AcpSessionRuntimeV1,
  PluginContextV1,
} from '@happier-dev/plugin-sdk';
import type { RuntimeEventV1 } from '@happier-dev/protocol/runtime';

import { createCursorBackendEngine } from './engine.js';

function createAcpSessionRuntimeFixture(): AcpSessionRuntimeV1 {
  return {
    beginTurnLifecycle: vi.fn(),
    startOrLoadSession: vi.fn(async () => 'cursor-provider-session-1'),
    sendTurnPrompt: vi.fn(async () => undefined),
    waitForTurnCompletion: vi.fn(async () => undefined),
    subscribeRuntimeEvents: vi.fn((_handler: (event: RuntimeEventV1) => void) => () => undefined),
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
    },
    acp: {
      createRuntime: vi.fn(async () => handle),
    },
  } as unknown as PluginContextV1;
}

describe('createCursorBackendEngine', () => {
  it('creates a host session plan whose runtime factory consumes shared ACP composition', async () => {
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

    const plan = await engine.runtimeCore?.createSessionRuntime({
      cwd: '/tmp/cursor',
      sessionId: 'happier-session-1',
      permissionMode: 'safe-yolo',
    });

    expect(plan).toMatchObject({
      kind: 'hostSessionRuntimePlan',
      providerId: 'cursor',
      opts: {
        directory: '/tmp/cursor',
        backendId: 'cursor',
      },
    });
    const runtime = await (plan as Readonly<{
      config: Readonly<{
        createSessionRuntime(params: Readonly<{
          directory: string;
          session: Readonly<{ sessionId: string }>;
          getPermissionMode: () => string;
        }>): Promise<unknown>;
      }>;
    }>).config.createSessionRuntime({
      directory: '/tmp/cursor',
      session: { sessionId: 'happier-session-1' },
      getPermissionMode: () => 'safe-yolo',
    });

    expect(runtime).toMatchObject({
      beginTurnLifecycle: expect.any(Function),
      startOrLoadSession: expect.any(Function),
      sendTurnPrompt: expect.any(Function),
      waitForTurnCompletion: expect.any(Function),
      subscribeRuntimeEvents: expect.any(Function),
      cancelTurn: expect.any(Function),
      updateSessionRuntimeConfig: expect.any(Function),
      resetOrDisposeRuntime: expect.any(Function),
    });
    await (runtime as Readonly<{
      startOrLoadSession(): Promise<unknown>;
      sendTurnPrompt(prompt: string): Promise<void>;
      cancelTurn(): Promise<void>;
      updateSessionRuntimeConfig(update: Readonly<Record<string, unknown>>): Promise<void>;
      resetOrDisposeRuntime(): Promise<void>;
      waitForTurnCompletion(): Promise<void>;
      subscribeRuntimeEvents(handler: (event: RuntimeEventV1) => void): () => void;
    }>).startOrLoadSession();
    (runtime as Readonly<{
      beginTurnLifecycle(): void;
    }>).beginTurnLifecycle();
    await (runtime as Readonly<{
      sendTurnPrompt(prompt: string): Promise<void>;
    }>).sendTurnPrompt('hello cursor');
    const eventHandler = vi.fn();
    const unsubscribe = (runtime as Readonly<{
      subscribeRuntimeEvents(handler: (event: RuntimeEventV1) => void): () => void;
    }>).subscribeRuntimeEvents(eventHandler);
    await (runtime as Readonly<{
      waitForTurnCompletion(): Promise<void>;
    }>).waitForTurnCompletion();
    unsubscribe();
    await (runtime as Readonly<{
      updateSessionRuntimeConfig(update: Readonly<Record<string, unknown>>): Promise<void>;
    }>).updateSessionRuntimeConfig({ modelId: 'composer-2.5' });
    await (runtime as Readonly<{
      cancelTurn(): Promise<void>;
    }>).cancelTurn();
    await (runtime as Readonly<{
      resetOrDisposeRuntime(): Promise<void>;
    }>).resetOrDisposeRuntime();

    expect(sessionRuntime.startOrLoadSession).toHaveBeenCalledWith();
    expect(sessionRuntime.beginTurnLifecycle).toHaveBeenCalledWith();
    expect(sessionRuntime.sendTurnPrompt).toHaveBeenCalledWith('hello cursor');
    expect(sessionRuntime.subscribeRuntimeEvents).toHaveBeenCalledWith(eventHandler);
    expect(sessionRuntime.waitForTurnCompletion).toHaveBeenCalledWith();
    expect(sessionRuntime.updateSessionRuntimeConfig).toHaveBeenCalledWith({ modelId: 'composer-2.5' });
    expect(sessionRuntime.cancelTurn).toHaveBeenCalledWith();
    expect(handle.dispose).toHaveBeenCalledWith('cursor-session-runtime-disposed');
    expect(ctx.acp.createRuntime).toHaveBeenCalledWith(
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
    const plan = await engine.runtimeCore?.createSessionRuntime({
      cwd: '/tmp/cursor',
      sessionId: 'happier-session-1',
    });

    await (plan as Readonly<{
      config: Readonly<{
        createSessionRuntime(params: Readonly<{ directory: string }>): Promise<unknown>;
      }>;
    }>).config.createSessionRuntime({ directory: '/tmp/cursor' });

    const createRuntimeMock = ctx.acp.createRuntime as unknown as Readonly<{
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

  it('fails closed for execution-run creation because Cursor is session-only in v1', () => {
    const engine = createCursorBackendEngine(createPluginContextFixture());

    expect(() => engine.runtimeCore?.createExecutionRunBackend({ cwd: '/tmp/cursor' })).toThrow(
      /session backend/i,
    );
  });
});
