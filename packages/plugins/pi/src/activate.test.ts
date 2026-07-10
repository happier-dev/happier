import type {
  AgentRuntimeV1,
  ExecClientHandleV1,
  ExecJsonStreamClientSpecV1,
  JsonStreamClientV1,
  PluginContextV1,
  RegisterAgentRuntimeV1,
  SessionRuntimeV1,
} from '@happier-dev/plugin-sdk';
import { describe, expect, it, vi } from 'vitest';

import { activate } from './activate.js';

function createPluginContext(capture: {
  specs: ExecJsonStreamClientSpecV1[];
  written: unknown[];
  listener?: (record: unknown) => void | Promise<void>;
}): PluginContextV1 {
  const client: JsonStreamClientV1 = {
    closed: Promise.resolve(),
    subscribe(listener) {
      capture.listener = listener;
      return () => {
        if (capture.listener === listener) capture.listener = undefined;
      };
    },
    async writeRecord(record) {
      capture.written.push(record);
    },
  };
  const handle: ExecClientHandleV1<JsonStreamClientV1> = {
    client,
    process: {
      pid: 123,
      exit: Promise.resolve({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
      writeStdin: async () => undefined,
      kill: () => undefined,
      dispose: async () => undefined,
    },
    status: 'running',
    onExit: () => () => undefined,
    dispose: async () => undefined,
  };
  return {
    logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    config: { values: {} },
    features: { isEnabled: () => false },
    permissions: { isGranted: () => false, list: () => [] },
    agentRuntime: {
      exec: {
        systemTools: {
          resolve: async () => {
            throw new Error('not used');
          },
        },
        run: async () => {
          throw new Error('not used');
        },
        spawn: async () => {
          throw new Error('not used');
        },
        spawnClient: async (spec) => {
          capture.specs.push(spec as ExecJsonStreamClientSpecV1);
          return handle;
        },
      },
      acp: {
        defineAcpBackend: () => {
          throw new Error('Pi must not register through ACP');
        },
        createRuntime: async () => {
          throw new Error('Pi must not create an ACP runtime');
        },
      },
      agents: {} as PluginContextV1['agentRuntime']['agents'],
      terminalHost: {} as PluginContextV1['agentRuntime']['terminalHost'],
      sessionHooks: {} as PluginContextV1['agentRuntime']['sessionHooks'],
      transcripts: {} as PluginContextV1['agentRuntime']['transcripts'],
      accountUsage: {} as PluginContextV1['agentRuntime']['accountUsage'],
    },
    managedServer: {} as PluginContextV1['managedServer'],
    mcp: {} as PluginContextV1['mcp'],
    errors: {} as PluginContextV1['errors'],
    retry: {} as PluginContextV1['retry'],
    env: { get: () => undefined } as PluginContextV1['env'],
    fs: {} as PluginContextV1['fs'],
    actions: {} as PluginContextV1['actions'],
    connection: {} as PluginContextV1['connection'],
    fetch: {} as PluginContextV1['fetch'],
    storage: {} as PluginContextV1['storage'],
    settings: {} as PluginContextV1['settings'],
    secrets: {} as PluginContextV1['secrets'],
    events: {} as PluginContextV1['events'],
    auth: {} as PluginContextV1['auth'],
    projects: {} as PluginContextV1['projects'],
    account: {} as PluginContextV1['account'],
    reviews: {} as PluginContextV1['reviews'],
    sessions: {} as PluginContextV1['sessions'],
    experimental: {
      telemetry: {} as PluginContextV1['experimental']['telemetry'],
      artifacts: {} as PluginContextV1['experimental']['artifacts'],
    },
    notifications: {} as PluginContextV1['notifications'],
    abort: {} as PluginContextV1['abort'],
    timeout: {} as PluginContextV1['timeout'],
    progress: {} as PluginContextV1['progress'],
  };
}

function readRegisteredBackend(registerAgentRuntime: ReturnType<typeof vi.fn>): RegisterAgentRuntimeV1 {
  const registration = registerAgentRuntime.mock.calls[0]?.[0];
  if (!registration || typeof registration !== 'object') {
    throw new Error('Expected Pi activation to register a backend engine');
  }
  return registration as RegisterAgentRuntimeV1;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function waitForWrittenCount(capture: { written: unknown[] }, count: number): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (capture.written.length < count) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${count} Pi RPC writes`);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function emit(capture: { listener?: (record: unknown) => void | Promise<void> }, record: unknown): Promise<void> {
  await capture.listener?.(record);
}

async function ackWrittenCommand(
  capture: { written: unknown[]; listener?: (record: unknown) => void | Promise<void> },
  index: number,
  data?: unknown,
): Promise<void> {
  const command = capture.written[index];
  if (!isRecord(command) || typeof command.id !== 'string' || typeof command.type !== 'string') {
    throw new Error(`Expected Pi RPC command at index ${index}`);
  }
  await emit(capture, {
    type: 'response',
    id: command.id,
    command: command.type,
    success: true,
    ...(data === undefined ? {} : { data }),
  });
}

describe('activate', () => {
  it('registers Pi as a custom strict-LF JSON stream runtimeCore', async () => {
    const registerAgentRuntime = vi.fn();
    const capture: { specs: ExecJsonStreamClientSpecV1[]; written: unknown[]; listener?: (record: unknown) => void | Promise<void> } = {
      specs: [],
      written: [],
    };

    activate({ registerAgentRuntime });

    const registration = readRegisteredBackend(registerAgentRuntime);
    expect(registration.agentId).toBe('pi');

    const engine = await registration.create(createPluginContext(capture)) as AgentRuntimeV1;
    expect(engine.runtimeCore).toBeDefined();

    const runtime = await engine.runtimeCore?.createSessionRuntime({
      directory: '/tmp/pi-workspace',
      permissionMode: 'safe-yolo',
      isolation: { env: { HAPPIER_PI_THINKING_LEVEL: 'medium' } },
    });
    if (!runtime) throw new Error('Expected Pi runtimeCore to create a session runtime');
    expect(runtime satisfies SessionRuntimeV1).toEqual(expect.objectContaining({
      identity: expect.objectContaining({ read: expect.any(Function) }),
      events: expect.objectContaining({ subscribe: expect.any(Function) }),
      send: expect.any(Function),
      cancel: expect.any(Function),
      dispose: expect.any(Function),
      permissions: { capability: 'static' },
    }));
    expect(capture.specs).toHaveLength(1);
    expect(capture.specs[0]).toMatchObject({
      launch: {
        kind: 'agent-cli',
        agentId: 'pi',
        args: ['--mode', 'rpc', '--tools', 'read,edit,write,grep,find,ls', '--thinking', 'medium'],
        cwd: '/tmp/pi-workspace',
        env: {
          HAPPIER_PI_THINKING_LEVEL: 'medium',
          NODE_ENV: 'production',
          DEBUG: '',
          CI: '1',
        },
      },
      transport: { kind: 'stdio', framing: { kind: 'strict-lf-json' } },
      protocol: { kind: 'json-stream' },
    });
  });

  it('creates Pi execution-run backends through the strict-LF spawnClient runtime', async () => {
    const registerAgentRuntime = vi.fn();
    const capture: { specs: ExecJsonStreamClientSpecV1[]; written: unknown[]; listener?: (record: unknown) => void | Promise<void> } = {
      specs: [],
      written: [],
    };

    activate({ registerAgentRuntime });

    const registration = readRegisteredBackend(registerAgentRuntime);
    const engine = await registration.create(createPluginContext(capture)) as AgentRuntimeV1;
    const backend = engine.runtimeCore?.createExecutionRunBackend({
      cwd: '/tmp/pi-workspace',
      runId: 'happier-execution-run-1',
      permissionMode: 'safe-yolo',
      isolation: { env: { HAPPIER_PI_THINKING_LEVEL: 'high' } },
    });
    if (!backend || !('provisionSession' in backend)) {
      throw new Error('Expected Pi execution-run host backend');
    }

    const messages: unknown[] = [];
    const unsubscribe = backend.subscribeMessages((message) => {
      messages.push(message);
    });

    const provisioned = backend.provisionSession();
    await waitForWrittenCount(capture, 1);
    expect(capture.written[0]).toMatchObject({ type: 'get_state' });
    await ackWrittenCommand(capture, 0, {});
    await waitForWrittenCount(capture, 2);
    expect(capture.written[1]).toMatchObject({ type: 'new_session' });
    await ackWrittenCommand(capture, 1, {});
    await waitForWrittenCount(capture, 3);
    expect(capture.written[2]).toMatchObject({ type: 'get_state' });
    await ackWrittenCommand(capture, 2, { sessionId: 'pi-provider-session-1' });

    await expect(provisioned).resolves.toEqual({ sessionId: 'pi-provider-session-1' });
    expect(capture.specs[0]).toMatchObject({
      launch: {
        kind: 'agent-cli',
        agentId: 'pi',
        args: ['--mode', 'rpc', '--tools', 'read,edit,write,grep,find,ls', '--thinking', 'high'],
        cwd: '/tmp/pi-workspace',
      },
      transport: { kind: 'stdio', framing: { kind: 'strict-lf-json' } },
      protocol: { kind: 'json-stream' },
    });

    const prompt = backend.sendPrompt('pi-provider-session-1', 'hello from execution run');
    await waitForWrittenCount(capture, 4);
    expect(capture.written[3]).toMatchObject({
      type: 'prompt',
      message: 'hello from execution run',
    });
    await ackWrittenCommand(capture, 3);
    await prompt;
    await emit(capture, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'hello' },
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    });

    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'message-delta',
        sessionId: 'happier-execution-run-1',
        delta: { text: 'hello' },
      }),
    ]));

    unsubscribe();
    await backend.dispose();
  });
});
