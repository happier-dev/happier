import type { JsonValue } from '@happier-dev/plugin-sdk';
import type {
  ManagedExecutableRef } from '@happier-dev/plugin-sdk/managed-services';
import type {
  PluginProtocolClientHandle,
  PluginProtocolClientSpec,
} from '@happier-dev/plugin-sdk/exec/protocol-clients';
import type {
  AgentSessionConfigurationSnapshot,
  AgentSessionRuntime,
  AgentSessionRuntimeEvent,
  AgentSessionSendRequest,
  AgentSessionModelsSource,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { AgentSessionRuntimeEventSchema } from '@happier-dev/plugin-sdk/agents/runtime';
import { describe, expect, it, vi } from 'vitest';

import {
  PI_REQUEST_AUTH_CAPABILITY_PATH_ENV,
  PI_REQUEST_AUTH_PRODUCER_VERSION_ENV,
  resolvePiRequestAuthExtensionPath,
} from '../../auth/services/requestAuth/index.js';
import { buildPiCompletedContextCompactionPayload } from './events.js';
import { createPiRuntimeOperations } from './operations.js';

type Capture = {
  specs: Extract<PluginProtocolClientSpec, { kind: 'jsonStream' }>[];
  written: unknown[];
  availableCommands?: readonly Readonly<{
    name: string;
    description?: string;
    source?: 'extension' | 'prompt' | 'skill';
  }>[];
  commandCatalogRequestCount?: number;
  sessionStatsRequestCount?: number;
  sessionStats?: unknown;
  versionProbeCount?: number;
  versionOutput?: string;
  systemToolResolveCount?: number;
  resolvedExecutable?: ManagedExecutableRef;
  versionProbeExecutable?: ManagedExecutableRef;
  listener?: (record: unknown) => void | Promise<void>;
  resolveExit?: (result: Awaited<ReturnType<PluginProtocolClientHandle<'jsonStream'>['wait']>>) => void;
  warnings?: unknown[][];
};

function createRuntimeContext(capture: Capture) {
  const client = {
    subscribe(listener) {
      capture.listener = listener;
      return { dispose: () => {
        if (capture.listener === listener) capture.listener = undefined;
      } };
    },
    async write(record: JsonValue) {
      if (isRecord(record) && record.type === 'get_commands' && typeof record.id === 'string') {
        capture.commandCatalogRequestCount = (capture.commandCatalogRequestCount ?? 0) + 1;
        await capture.listener?.({
          type: 'response',
          id: record.id,
          command: 'get_commands',
          success: true,
          data: { commands: capture.availableCommands ?? [] },
        });
        return;
      }
      if (isRecord(record) && record.type === 'get_session_stats' && typeof record.id === 'string') {
        capture.sessionStatsRequestCount = (capture.sessionStatsRequestCount ?? 0) + 1;
        await capture.listener?.({
          type: 'response',
          id: record.id,
          command: 'get_session_stats',
          success: true,
          data: capture.sessionStats ?? { contextUsage: null },
        });
        return;
      }
      capture.written.push(record);
    },
    dispose: async () => undefined,
  };
  const exit = new Promise<Awaited<ReturnType<PluginProtocolClientHandle<'jsonStream'>['wait']>>>((resolve) => {
    capture.resolveExit = resolve;
  });
  const handle: PluginProtocolClientHandle<'jsonStream'> = {
    client,
    process: {
      pid: 123,
      write: async () => undefined,
      closeStdin: async () => undefined,
      wait: () => exit,
      onOutput: () => ({ dispose: () => undefined }),
      dispose: async () => undefined,
    },
    wait: () => exit,
    dispose: async () => undefined,
  };
  return {
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: (...args: unknown[]) => capture.warnings?.push(args),
      error: () => undefined,
    },
    services: {
      exec: {
        systemTools: {
          resolve: async () => {
            capture.systemToolResolveCount = (capture.systemToolResolveCount ?? 0) + 1;
            const executable = Object.freeze({
              kind: 'systemTool' as const,
              id: 'pi-cli',
            });
            capture.resolvedExecutable = executable;
            return {
              executable,
              executablePath: '/tmp/happier-pi-cli',
            };
          },
        },
        run: async (request) => {
          capture.versionProbeCount = (capture.versionProbeCount ?? 0) + 1;
          capture.versionProbeExecutable = request.executable;
          return {
            termination: {
              observed: { kind: 'exit' as const, exitCode: 0 },
              requestedBy: { kind: 'none' as const },
            },
            stdout: new TextEncoder().encode(capture.versionOutput ?? '0.81.1'),
            stderr: new Uint8Array(),
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        },
        clients: {
          spawn: async (spec: Extract<PluginProtocolClientSpec, { kind: 'jsonStream' }>) => {
          capture.specs.push(spec);
          return handle;
        },
        },
      },
    },
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function emit(capture: Capture, record: unknown): Promise<void> {
  await capture.listener?.(record);
}

async function emitExit(
  capture: Capture,
  result: Readonly<{ exitCode: number | null; signal: string | null; stdout: string; stderr: string }>,
): Promise<void> {
  capture.resolveExit?.({
    termination: {
      observed: result.signal ? { kind: 'signal', signal: result.signal } : { kind: 'exit', exitCode: result.exitCode ?? 0 },
      requestedBy: { kind: 'none' },
    },
    stdout: new Uint8Array(),
    stderr: new TextEncoder().encode(result.stderr),
    stdoutTruncated: false,
    stderrTruncated: false,
  });
  await Promise.resolve();
}

async function ackLastCommand(capture: Capture, data?: unknown): Promise<void> {
  const command = capture.written.at(-1);
  if (!isRecord(command) || typeof command.id !== 'string' || typeof command.type !== 'string') {
    throw new Error('Expected Pi command to be written before acknowledging it');
  }
  await emit(capture, {
    type: 'response',
    id: command.id,
    command: command.type,
    success: true,
    ...(data === undefined ? {} : { data }),
  });
}

async function ackCommandAt(capture: Capture, index: number, data?: unknown): Promise<void> {
  const command = capture.written[index];
  if (!isRecord(command) || typeof command.id !== 'string' || typeof command.type !== 'string') {
    throw new Error(`Expected Pi command ${index} to be written before acknowledging it`);
  }
  await emit(capture, {
    type: 'response',
    id: command.id,
    command: command.type,
    success: true,
    ...(data === undefined ? {} : { data }),
  });
}

async function failLastCommand(capture: Capture, error = 'Pi RPC command failed'): Promise<void> {
  const command = capture.written.at(-1);
  if (!isRecord(command) || typeof command.id !== 'string' || typeof command.type !== 'string') {
    throw new Error('Expected Pi command to be written before rejecting it');
  }
  await emit(capture, {
    type: 'response',
    id: command.id,
    command: command.type,
    success: false,
    error,
  });
}

async function waitForWrittenCount(capture: Capture, count: number): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (capture.written.length < count) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${count} Pi RPC writes`);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function createRuntime(capture: Capture) {
  const params = {
    ...createRuntimeContext(capture),
    cwd: '/tmp/pi-workspace',
    env: {},
    sessionId: 'happier-session-1',
    initialSessionId: 'pi-provider-session-1',
  };
  return await createPiRuntimeOperations(params);
}

async function createRuntimeWithEnv(capture: Capture, env: Readonly<Record<string, string>>) {
  return await createPiRuntimeOperations({
    ...createRuntimeContext(capture),
    cwd: '/tmp/pi-workspace',
    env,
    sessionId: 'happier-session-1',
    initialSessionId: 'pi-provider-session-1',
  });
}

function parseEvents(events: AgentSessionRuntimeEvent[]): AgentSessionRuntimeEvent[] {
  return events.map((event) => AgentSessionRuntimeEventSchema.parse(event));
}

function sendPrompt(
  runtime: AgentSessionRuntime,
  text: string,
  options: Readonly<{
    inputIds?: AgentSessionSendRequest['inputIds'];
    delivery?: AgentSessionSendRequest['delivery'];
  }> = {},
) {
  return runtime.send({
    inputIds: options.inputIds ?? ['pi-input-1'],
    input: { text },
    delivery: options.delivery ?? { kind: 'newTurn', turnId: 'pi-turn-1' },
  });
}

function configuration(options: Readonly<Record<string, string>>): AgentSessionConfigurationSnapshot {
  return {
    mode: { value: null, updatedAtMs: 1 },
    model: { value: null, updatedAtMs: 1 },
    permissionIntent: { value: null, updatedAtMs: 1 },
    options: Object.fromEntries(Object.entries(options).map(([id, value]) => [id, { value, updatedAtMs: 1 }])),
  };
}

describe('createPiRuntimeOperations', () => {
  it('publishes the process command catalog once for native command dispatch', async () => {
    const capture: Capture = {
      specs: [],
      written: [],
      availableCommands: [
        { name: 'goal', description: 'Set the session goal' },
        { name: '/SKILL:Review' },
      ],
    };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(AgentSessionRuntimeEventSchema.parse(event)));

    expect(capture.commandCatalogRequestCount).toBe(1);
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'available-commands',
      commands: [
        { name: 'goal', description: 'Set the session goal' },
        { name: 'skill:review' },
      ],
    }));

    await runtime.dispose();
  });

  it('settles an acknowledged provider command that does not start an agent turn', async () => {
    const capture: Capture = {
      specs: [],
      written: [],
      availableCommands: [{ name: 'goal', source: 'extension' }],
    };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(AgentSessionRuntimeEventSchema.parse(event)));

    const submission = sendPrompt(runtime, '/goal fix authentication');
    await waitForWrittenCount(capture, 1);
    expect(capture.written[0]).toEqual(expect.objectContaining({
      type: 'prompt',
      message: '/goal fix authentication',
    }));
    await ackCommandAt(capture, 0);
    await waitForWrittenCount(capture, 2);
    expect(capture.written[1]).toEqual(expect.objectContaining({ type: 'get_state' }));
    await ackCommandAt(capture, 1, {
      sessionId: 'pi-provider-session-1',
      isStreaming: false,
      isCompacting: false,
    });

    await expect(submission).resolves.toEqual({ status: 'admitted' });
    expect(events.map((event) => event.kind)).toEqual(expect.arrayContaining([
      'input-accepted',
      'turn-start',
      'turn-complete',
    ]));
    expect(events.some((event) => event.kind === 'turn-failed')).toBe(false);

    await runtime.dispose();
  });

  it.each([
    ['a prompt command', '/goal fix authentication', { name: 'goal', source: 'prompt' as const }],
    ['a differently-cased extension command', '/goal fix authentication', { name: 'Goal', source: 'extension' as const }],
    ['a tab-delimited extension command', '/goal\tfix authentication', { name: 'goal', source: 'extension' as const }],
  ])('does not apply no-turn settlement to %s', async (_label, text, command) => {
    const capture: Capture = {
      specs: [],
      written: [],
      availableCommands: [command],
    };
    const runtime = await createRuntime(capture);

    const submission = sendPrompt(runtime, text);
    await waitForWrittenCount(capture, 1);
    await ackCommandAt(capture, 0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    if (capture.written.length > 1) {
      await ackCommandAt(capture, 1, {
        sessionId: 'pi-provider-session-1',
        isStreaming: false,
        isCompacting: false,
      });
    }
    await expect(submission).resolves.toEqual({ status: 'admitted' });

    expect(capture.written).toHaveLength(1);
    await runtime.dispose();
  });

  it('exposes the native AgentSessionRuntime contract directly at the Pi RPC owner', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    const subscription = runtime.watch((event) => events.push(AgentSessionRuntimeEventSchema.parse(event)));
    expect(capture.systemToolResolveCount).toBe(1);
    expect(capture.versionProbeCount).toBeUndefined();
    expect(capture.specs[0]?.launch.executable).toBe(capture.resolvedExecutable);
    expect(capture.specs[0]?.launch.cwd).toEqual({ root: 'workspace', relativePath: '' });

    const prompt = runtime.send({
      inputIds: ['pi-input-native-1'],
      input: { text: 'hello' },
      delivery: { kind: 'newTurn', turnId: 'pi-turn-native-1' },
    });
    await waitForWrittenCount(capture, 1);
    await ackLastCommand(capture);

    await expect(prompt).resolves.toEqual({ status: 'admitted' });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'input-accepted',
        inputIds: ['pi-input-native-1'],
        delivery: { kind: 'newTurn', turnId: 'pi-turn-native-1' },
      }),
    ]));
    subscription.dispose();
  });

  it('derives launch provider and startup model from the selected connected service', async () => {
    const capture: Capture = { specs: [], written: [] };

    await createRuntimeWithEnv(capture, {
      HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([
        { kind: 'profile', serviceId: 'openai-codex', profileId: 'primary' },
      ]),
      PI_CODING_AGENT_DIR: '/tmp/happier-pi-agent-dir',
      [PI_REQUEST_AUTH_CAPABILITY_PATH_ENV]: '/tmp/request-auth-capability.json',
    });

    expect(capture.specs[0]?.launch.args).toEqual(expect.arrayContaining([
      '--provider',
      'openai-codex',
      '--model',
      'gpt-5.5',
      '--models',
      'openai-codex/*',
    ]));
  });

  it.each([
    ['0.81.0', '0.81.0'],
    ['0.81.1', '0.81.1'],
    ['0.82.1', '0.82.1'],
    ['v0.82.1', '0.82.1'],
    ['pi 0.82.1+fork.7', '0.82.1+fork.7'],
  ])(
    'loads exactly one request-auth extension on supported Pi %s',
    async (versionOutput, producerVersion) => {
      const capture: Capture = { specs: [], written: [], versionOutput };
      const agentDir = '/tmp/happier-pi-agent-dir';

      await createRuntimeWithEnv(capture, {
        PI_CODING_AGENT_DIR: agentDir,
        [PI_REQUEST_AUTH_CAPABILITY_PATH_ENV]: '/tmp/request-auth-capability.json',
      });

      const args = capture.specs[0]?.launch.args ?? [];
      const extensionIndexes = args
        .map((arg, index) => arg === '--extension' ? index : -1)
        .filter((index) => index >= 0);
      expect(extensionIndexes).toHaveLength(1);
      const extensionIndex = extensionIndexes[0]!;
      expect(extensionIndex).toBeGreaterThanOrEqual(0);
      expect(args[extensionIndex + 1]).toBe(resolvePiRequestAuthExtensionPath(agentDir));
      expect(capture.specs[0]?.launch.env?.[PI_REQUEST_AUTH_PRODUCER_VERSION_ENV]).toBe(producerVersion);
      expect(capture.systemToolResolveCount).toBe(1);
      expect(capture.versionProbeCount).toBe(1);
      expect(capture.versionProbeExecutable).toBe(capture.resolvedExecutable);
      expect(capture.specs[0]?.launch.executable).toBe(capture.resolvedExecutable);
    },
  );

  it.each([
    ['0.74.2', 'version_too_old'],
    ['0.80.10', 'version_too_old'],
    ['00.082.001', 'version_unreadable'],
    ['0.82.1_rc.1', 'version_unreadable'],
    ['pi unknown', 'version_unreadable'],
  ])('rejects unsupported Pi %s before starting a connected request-auth runtime', async (versionOutput, reason) => {
    const capture: Capture = {
      specs: [],
      written: [],
      versionOutput,
    };

    await expect(createRuntimeWithEnv(capture, {
      PI_CODING_AGENT_DIR: '/tmp/happier-pi-agent-dir',
      [PI_REQUEST_AUTH_CAPABILITY_PATH_ENV]: '/tmp/request-auth-capability.json',
    })).rejects.toMatchObject({
      name: 'PiRequestAuthCompatibilityError',
      code: 'pi_request_auth_version_unsupported',
      compatibility: expect.objectContaining({
        supported: false,
        reason,
        minimumVersion: '0.81.0',
      }),
    });

    expect(capture.systemToolResolveCount).toBe(1);
    expect(capture.versionProbeCount).toBe(1);
    expect(capture.specs).toHaveLength(0);
  });

  it.each([
    ['agent dir', {
      [PI_REQUEST_AUTH_CAPABILITY_PATH_ENV]: '/tmp/request-auth-capability.json',
    }],
    ['child capability', {
      PI_CODING_AGENT_DIR: '/tmp/happier-pi-agent-dir',
      HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([
        { kind: 'profile', serviceId: 'openai-codex', profileId: 'primary' },
      ]),
    }],
  ])('fails closed before spawn when request auth is missing the %s', async (_missing, env) => {
    const capture: Capture = { specs: [], written: [] };

    await expect(createRuntimeWithEnv(capture, env)).rejects.toThrow(
      'Pi request-auth runtime requires the agent dir and child endpoint capability',
    );

    expect(capture.versionProbeCount).toBeUndefined();
    expect(capture.specs).toHaveLength(0);
  });

  it('does not impose the request-auth version floor on native Pi sessions', async () => {
    const capture: Capture = {
      specs: [],
      written: [],
      versionOutput: '0.74.2',
    };

    await createRuntime(capture);

    expect(capture.systemToolResolveCount).toBe(1);
    expect(capture.versionProbeCount).toBeUndefined();
    expect(capture.specs[0]?.launch.executable).toBe(capture.resolvedExecutable);
    expect(capture.specs).toHaveLength(1);
  });

  it('projects raw Pi turn records to canonical runtime events', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => {
      events.push(event);
    });

    const prompt = sendPrompt(runtime, 'hello');
    await waitForWrittenCount(capture, 1);
    await ackLastCommand(capture);
    await expect(prompt).resolves.toEqual({ status: 'admitted' });
    await emit(capture, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'hel' },
      message: { role: 'assistant', content: [{ type: 'text', text: 'hel' }] },
    });
    await emit(capture, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'lo' },
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    });
    await emit(capture, {
      type: 'tool_execution_start',
      toolCallId: 'tool-call-1',
      toolName: 'grep',
      args: { pattern: 'PiRuntime' },
    });
    await emit(capture, {
      type: 'tool_execution_end',
      toolCallId: 'tool-call-1',
      toolName: 'grep',
      result: { matches: 2 },
      isError: false,
    });
    await emit(capture, { type: 'turn_end', turnId: 'provider-turn-1' });
    await emit(capture, { type: 'agent_end', willRetry: false });

    expect(events.some((event) => (
      event.kind === 'turn-complete' || event.kind === 'turn-failed' || event.kind === 'turn-cancelled'
    ))).toBe(true);

    const parsedEvents = parseEvents(events);
    const turnStart = parsedEvents.find((event) => event.kind === 'turn-start');
    expect(turnStart).toMatchObject({
      kind: 'turn-start',
      sessionId: 'happier-session-1',
      startedBy: 'host',
    });
    expect(parsedEvents.filter((event) => event.kind === 'message-delta')).toEqual([
      expect.objectContaining({ channel: 'assistant', text: 'hel' }),
      expect.objectContaining({ channel: 'assistant', text: 'lo' }),
    ]);
    expect(parsedEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'tool-call',
        sessionId: 'happier-session-1',
        turnId: turnStart?.turnId,
        toolCallId: 'tool-call-1',
        toolName: 'grep',
        input: { pattern: 'PiRuntime' },
      }),
      expect.objectContaining({
        kind: 'tool-result',
        sessionId: 'happier-session-1',
        turnId: turnStart?.turnId,
        toolCallId: 'tool-call-1',
        output: { matches: 2 },
        isError: false,
      }),
      expect.objectContaining({
        kind: 'turn-complete',
        sessionId: 'happier-session-1',
        turnId: turnStart?.turnId,
        agentTurnId: 'provider-turn-1',
      }),
    ]));
  });

  it('publishes canonical context usage after a completed Pi turn', async () => {
    const capture: Capture = {
      specs: [],
      written: [],
      sessionStats: {
        contextUsage: { tokens: 12_345, contextWindow: 200_000, percent: 6.1725 },
      },
    };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(event));

    const prompt = sendPrompt(runtime, 'hello');
    await waitForWrittenCount(capture, 1);
    await ackLastCommand(capture);
    await expect(prompt).resolves.toEqual({ status: 'admitted' });
    await emit(capture, { type: 'agent_end', willRetry: false });
    await vi.waitFor(() => expect(events.some((event) => event.kind === 'usage-observed')).toBe(true));

    expect(parseEvents(events)).toContainEqual(expect.objectContaining({
      kind: 'usage-observed',
      sessionId: 'happier-session-1',
      context: expect.objectContaining({
        usedTokens: 12_345,
        windowTokens: 200_000,
      }),
    }));

    await runtime.dispose();
  });

  it('publishes typed provider acceptance from the exact Pi prompt RPC response before turn evidence', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(event));

    const prompt = sendPrompt(runtime, 'hello', {
      inputIds: ['pi-input-42'],
      delivery: { kind: 'newTurn', turnId: 'pi-turn-42' },
    });
    await waitForWrittenCount(capture, 1);
    await ackLastCommand(capture);
    await expect(prompt).resolves.toEqual({ status: 'admitted' });

    expect(events.filter((event) => event.kind === 'input-accepted')).toEqual([expect.objectContaining({
      kind: 'input-accepted',
      inputIds: ['pi-input-42'],
      delivery: { kind: 'newTurn', turnId: 'pi-turn-42' },
    })]);

    await emit(capture, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'hello' },
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    });
    await emit(capture, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'again' },
      message: { role: 'assistant', content: [{ type: 'text', text: 'again' }] },
    });

    expect(events.filter((event) => event.kind === 'input-accepted')).toHaveLength(1);
  });

  it('preserves exact prompt acceptance when pre-admission record buffering fails', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(event));

    const prompt = sendPrompt(runtime, 'accepted before observation failure', {
      inputIds: ['pi-input-buffer-failure'],
      delivery: { kind: 'newTurn', turnId: 'pi-turn-buffer-failure' },
    });
    await waitForWrittenCount(capture, 1);
    await emit(capture, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'must not replay' },
      message: { role: 'assistant', content: [{ type: 'text', text: 'must not replay' }] },
    });
    const invalidRecord: Record<string, unknown> = { type: 'agent_start' };
    invalidRecord.self = invalidRecord;
    await emit(capture, invalidRecord);
    await ackLastCommand(capture);

    await expect(prompt).resolves.toMatchObject({ status: 'rejected' });
    expect(events.filter((event) => event.kind === 'input-accepted')).toEqual([
      expect.objectContaining({
        inputIds: ['pi-input-buffer-failure'],
        delivery: { kind: 'newTurn', turnId: 'pi-turn-buffer-failure' },
      }),
    ]);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'input-delivery-failed',
        inputIds: ['pi-input-buffer-failure'],
      }),
    ]));
    expect(events.some((event) => event.kind === 'input-rejected')).toBe(false);
    expect(events.some((event) => event.kind === 'message-delta')).toBe(false);
    await runtime.dispose();
  });

  it('keeps ambiguous prompt response loss custody unknown when pre-admission record buffering fails', async () => {
    vi.useFakeTimers();
    try {
      const capture: Capture = { specs: [], written: [] };
      const runtime = await createRuntime(capture);
      const events: AgentSessionRuntimeEvent[] = [];
      runtime.watch((event) => events.push(event));

      const prompt = sendPrompt(runtime, 'response lost after observation failure', {
        inputIds: ['pi-input-buffered-response-loss'],
        delivery: { kind: 'newTurn', turnId: 'pi-turn-buffered-response-loss' },
      });
      await Promise.resolve();
      await Promise.resolve();
      await emit(capture, {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'must not replay' },
        message: { role: 'assistant', content: [{ type: 'text', text: 'must not replay' }] },
      });
      const invalidRecord: Record<string, unknown> = { type: 'agent_start' };
      invalidRecord.self = invalidRecord;
      await emit(capture, invalidRecord);
      await vi.advanceTimersByTimeAsync(30_000);

      await expect(prompt).resolves.toMatchObject({
        status: 'rejected',
        diagnostic: expect.objectContaining({ code: 'pi_input_outcome_unknown' }),
      });
      expect(capture.written).toHaveLength(1);
      expect(events.filter((event) => event.kind === 'input-accepted')).toEqual([]);
      expect(events.filter((event) => event.kind === 'input-rejected')).toEqual([]);
      expect(events.filter((event) => (
        event.kind === 'input-custody-unknown' || event.kind === 'input-delivery-failed'
      ))).toEqual([
        expect.objectContaining({
          kind: 'input-custody-unknown',
          inputIds: ['pi-input-buffered-response-loss'],
        }),
      ]);
      expect(events.some((event) => event.kind === 'message-delta')).toBe(false);
      await runtime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies canonical reasoning_effort runtime config updates to Pi thinking level', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);

    const update = runtime.updateConfiguration!(configuration({ reasoning_effort: 'high' }));
    await waitForWrittenCount(capture, 1);

    expect(capture.written.at(-1)).toEqual(expect.objectContaining({
      type: 'set_thinking_level',
      level: 'high',
    }));

    await ackLastCommand(capture);
    await expect(update).resolves.toEqual({ status: 'applied', changed: ['options'] });
  });

  it('binds Pi runtime models and republishes them after configuration changes', async () => {
    const capture: Capture = { specs: [], written: [] };
    let source: AgentSessionModelsSource | null = null;
    const disposeBinding = vi.fn();
    const runtime = await createPiRuntimeOperations({
      ...createRuntimeContext(capture),
      models: {
        bind(nextSource) {
          source = nextSource;
          return { dispose: disposeBinding };
        },
      },
      cwd: '/tmp/pi-workspace',
      env: {},
      sessionId: 'happier-session-1',
      initialSessionId: 'pi-provider-session-1',
    });

    expect(source?.read()).toEqual({ models: null });
    const update = runtime.updateConfiguration!(configuration({ reasoning_effort: 'high' }));
    await waitForWrittenCount(capture, 1);
    await ackCommandAt(capture, 0);
    await expect(update).resolves.toEqual({ status: 'applied', changed: ['options'] });
    await waitForWrittenCount(capture, 3);
    await ackCommandAt(capture, 1, {
      model: { provider: 'openai', id: 'gpt-4o-mini' },
      thinkingLevel: 'high',
    });
    await ackCommandAt(capture, 2, {
      models: [{ provider: 'openai', id: 'gpt-4o-mini', name: 'GPT-4o mini', reasoning: true }],
    });
    await vi.waitFor(() => {
      expect(source?.read()).toMatchObject({ currentModelId: 'openai/gpt-4o-mini' });
    });
    expect(source?.read()).toMatchObject({
      currentModelId: 'openai/gpt-4o-mini',
      models: [{ id: 'openai/gpt-4o-mini' }],
    });

    await runtime.dispose();
    expect(disposeBinding).toHaveBeenCalledTimes(1);
  });

  it('does not infer typed provider acceptance from Pi turn evidence before the exact RPC response', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(event));

    const prompt = sendPrompt(runtime, 'hello', {
      inputIds: ['pi-input-43'],
      delivery: { kind: 'newTurn', turnId: 'pi-turn-43' },
    });
    await waitForWrittenCount(capture, 1);
    await emit(capture, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'early' },
      message: { role: 'assistant', content: [{ type: 'text', text: 'early' }] },
    });
    expect(events.some((event) => event.kind === 'input-accepted')).toBe(false);

    await ackLastCommand(capture);
    await expect(prompt).resolves.toEqual({ status: 'admitted' });

    expect(events.filter((event) => event.kind === 'input-accepted')).toEqual([expect.objectContaining({
      kind: 'input-accepted',
      inputIds: ['pi-input-43'],
      delivery: { kind: 'newTurn', turnId: 'pi-turn-43' },
    })]);
  });

  it('keeps ambiguous prompt response loss custody unknown when generic Pi stream activity was buffered', async () => {
    vi.useFakeTimers();
    try {
      const capture: Capture = { specs: [], written: [] };
      const runtime = await createRuntime(capture);
      const events: AgentSessionRuntimeEvent[] = [];
      runtime.watch((event) => events.push(event));

      const prompt = sendPrompt(runtime, 'follow up after resume', {
        inputIds: ['pi-input-44'],
        delivery: { kind: 'newTurn', turnId: 'pi-turn-44' },
      });
      await Promise.resolve();
      await Promise.resolve();
      await emit(capture, { type: 'agent_start' });
      await emit(capture, { type: 'turn_start' });
      await emit(capture, {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'unrelated output' },
        message: { role: 'assistant', content: [{ type: 'text', text: 'unrelated output' }] },
      });
      await vi.advanceTimersByTimeAsync(30_000);

      await expect(prompt).resolves.toMatchObject({
        status: 'rejected',
        diagnostic: expect.objectContaining({ code: 'pi_input_outcome_unknown' }),
      });
      expect(events.filter((event) => event.kind === 'input-accepted')).toEqual([]);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'message-delta', text: 'unrelated output' }),
        expect.objectContaining({ kind: 'input-custody-unknown', inputIds: ['pi-input-44'] }),
      ]));
      await runtime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let a concurrent steer race supply acceptance evidence for a pending prompt', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);

    const prompt = sendPrompt(runtime, 'new turn', {
      inputIds: ['pi-input-new-turn'],
      delivery: { kind: 'newTurn', turnId: 'pi-turn-new-turn' },
    });
    await waitForWrittenCount(capture, 1);
    const steer = sendPrompt(runtime, 'steer concurrently', {
      inputIds: ['pi-input-steer'],
      delivery: { kind: 'steer', turnId: 'pi-turn-new-turn' },
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const writesBeforeAck = capture.written.length;

    if (writesBeforeAck > 1) {
      await ackCommandAt(capture, 1);
    }
    const steerResult = await steer;
    await ackCommandAt(capture, 0);
    await expect(prompt).resolves.toEqual({ status: 'admitted' });

    expect(writesBeforeAck).toBe(1);
    expect(steerResult).toMatchObject({
      status: 'rejected',
      diagnostic: expect.objectContaining({ code: 'pi_input_rejected' }),
    });
  });

  it('classifies an exact negative prompt ACK as rejected before effect', async () => {
    const capture: Capture = { specs: [], written: [], warnings: [] };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(event));

    const prompt = sendPrompt(runtime, 'unacknowledged prompt', {
      inputIds: ['pi-input-no-evidence'],
      delivery: { kind: 'newTurn', turnId: 'pi-turn-no-evidence' },
    });
    await waitForWrittenCount(capture, 1);
    await failLastCommand(capture, 'Provider session failed');

    await expect(prompt).resolves.toMatchObject({
      status: 'rejected',
      diagnostic: expect.objectContaining({
        code: 'pi_provider_session_error',
        message: 'Pi provider rejected the prompt before acceptance without details',
      }),
    });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'input-rejected', inputIds: ['pi-input-no-evidence'] }),
    ]));
    expect(events.some((event) => event.kind === 'input-custody-unknown')).toBe(false);
    expect(capture.warnings).toEqual([
      [
        '[PiRuntime] Provider prompt rejected',
        {
          classification: 'pi_provider_failure',
          providerCode: 'pi_provider_session_error',
          sanitizedPreview: 'Pi provider rejected the prompt before acceptance without details',
        },
      ],
    ]);
    await runtime.dispose();
  });

  it('keeps an exact negative prompt ACK rejected when pre-admission record buffering fails', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(event));

    const prompt = sendPrompt(runtime, 'rejected after observation failure', {
      inputIds: ['pi-input-negative-ack-buffer-failure'],
      delivery: { kind: 'newTurn', turnId: 'pi-turn-negative-ack-buffer-failure' },
    });
    await waitForWrittenCount(capture, 1);
    const invalidRecord: Record<string, unknown> = { type: 'agent_start' };
    invalidRecord.self = invalidRecord;
    await emit(capture, invalidRecord);
    await failLastCommand(capture, 'Prompt was rejected before acceptance');

    await expect(prompt).resolves.toMatchObject({
      status: 'rejected',
      diagnostic: expect.objectContaining({
        code: 'pi_provider_session_error',
        message: 'Pi provider rejected the prompt before acceptance: Prompt was rejected before acceptance',
      }),
    });
    expect(events.filter((event) => event.kind === 'input-rejected')).toEqual([
      expect.objectContaining({ inputIds: ['pi-input-negative-ack-buffer-failure'] }),
    ]);
    expect(events.some((event) => (
      event.kind === 'input-accepted'
      || event.kind === 'input-custody-unknown'
      || event.kind === 'input-delivery-failed'
    ))).toBe(false);
    await runtime.dispose();
  });

  it('keeps an exact negative prompt ACK rejected when unrelated Pi stream activity follows', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(event));

    const prompt = sendPrompt(runtime, 'rejected prompt', {
      inputIds: ['pi-input-negative-ack'],
      delivery: { kind: 'newTurn', turnId: 'pi-turn-negative-ack' },
    });
    await waitForWrittenCount(capture, 1);
    await failLastCommand(capture, 'Prompt was rejected before acceptance');
    await emit(capture, { type: 'agent_start' });
    await emit(capture, { type: 'turn_start' });
    await emit(capture, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'stale output' },
      message: { role: 'assistant', content: [{ type: 'text', text: 'stale output' }] },
    });

    await expect(prompt).resolves.toMatchObject({
      status: 'rejected',
      diagnostic: expect.objectContaining({
        code: 'pi_provider_session_error',
        message: 'Pi provider rejected the prompt before acceptance: Prompt was rejected before acceptance',
      }),
    });
    expect(events.filter((event) => event.kind === 'input-accepted')).toEqual([]);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'message-delta', text: 'stale output' }),
      expect.objectContaining({ kind: 'input-rejected', inputIds: ['pi-input-negative-ack'] }),
    ]));
    await runtime.dispose();
  });

  it.each([
    ['new-turn', { kind: 'newTurn', turnId: 'pi-turn-response-loss' }],
    ['steer', { kind: 'steer', turnId: 'pi-turn-response-loss' }],
  ] as const)('classifies %s prompt response loss after invocation as custody unknown', async (_label, delivery) => {
    vi.useFakeTimers();
    try {
      const capture: Capture = { specs: [], written: [] };
      const runtime = await createRuntime(capture);
      const events: AgentSessionRuntimeEvent[] = [];
      runtime.watch((event) => events.push(event));

      const prompt = sendPrompt(runtime, 'response lost after write', {
        inputIds: ['pi-input-response-loss'],
        delivery,
      });
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(30_000);

      await expect(prompt).resolves.toMatchObject({ status: 'rejected' });
      expect(capture.written).toHaveLength(1);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'input-custody-unknown',
          inputIds: ['pi-input-response-loss'],
        }),
      ]));
      expect(events.some((event) => event.kind === 'input-rejected')).toBe(false);
      await runtime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('projects raw Pi compaction records through the protocol event contract', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => {
      events.push(event);
    });

    const prompt = sendPrompt(runtime, 'hello');
    await waitForWrittenCount(capture, 1);
    await ackLastCommand(capture);
    await expect(prompt).resolves.toEqual({ status: 'admitted' });
    await emit(capture, { type: 'compaction_start', reason: 'threshold' });
    await emit(capture, { type: 'compaction_start', reason: 'threshold' });
    await emit(capture, { type: 'compaction_start', reason: 'manual' });
    await emit(capture, {
      type: 'compaction_end',
      reason: 'overflow',
      result: {
        summary: 'foreign terminal',
        firstKeptEntryId: 'entry-foreign',
        tokensBefore: 101,
        estimatedTokensAfter: 41,
      },
      aborted: false,
      willRetry: true,
    });
    await emit(capture, {
      type: 'compaction_end',
      reason: 'threshold',
      result: {
        summary: 'compacted',
        firstKeptEntryId: 'entry-1',
        tokensBefore: 100,
        estimatedTokensAfter: 40,
      },
      aborted: false,
      willRetry: true,
    });
    await emit(capture, {
      type: 'compaction_end',
      reason: 'threshold',
      result: {
        summary: 'compacted',
        firstKeptEntryId: 'entry-1',
        tokensBefore: 100,
        estimatedTokensAfter: 40,
      },
      aborted: false,
      willRetry: true,
    });

    const compactionEvents = parseEvents(events).filter((event) => event.kind === 'context-compaction');
    expect(compactionEvents).toEqual([
      expect.objectContaining({
        kind: 'context-compaction',
        phase: 'started',
        sessionId: 'happier-session-1',
        trigger: 'threshold',
        compactionId: expect.stringMatching(/^pi:/),
      }),
      expect.objectContaining({
        kind: 'context-compaction',
        phase: 'completed',
        sessionId: 'happier-session-1',
        trigger: 'threshold',
        tokenCountBefore: 100,
        tokenCountAfter: 40,
      }),
    ]);
    expect(compactionEvents[0]?.compactionId).toBe(compactionEvents[1]?.compactionId);
    expect(compactionEvents.every((event) => !('retryAttempt' in event))).toBe(true);
    expect(compactionEvents.every((event) => !('provider' in event))).toBe(true);
  });

  it('maps exact Pi compaction cancellation and sanitized failure fields', () => {
    expect(buildPiCompletedContextCompactionPayload({
      type: 'compaction_end',
      reason: 'manual',
      result: undefined,
      aborted: true,
      willRetry: false,
    })).toMatchObject({
      phase: 'cancelled',
      trigger: 'manual',
    });

    const failed = buildPiCompletedContextCompactionPayload({
      type: 'compaction_end',
      reason: 'overflow',
      result: undefined,
      aborted: false,
      willRetry: false,
      errorMessage: 'Compaction failed: {"error":{"message":"Context limit reached"},"request_id":"secret-request"}',
    });
    expect(failed).toMatchObject({
      phase: 'failed',
      trigger: 'overflow',
      diagnostic: {
        code: 'pi_compaction_failed',
        message: 'Context limit reached',
      },
    });
    expect(JSON.stringify(failed)).not.toContain('secret-request');

    expect(buildPiCompletedContextCompactionPayload({
      type: 'compaction_end',
      reason: 'threshold',
      result: undefined,
      aborted: false,
      willRetry: false,
    })).toMatchObject({
      phase: 'failed',
      diagnostic: { code: 'pi_compaction_failed' },
    });
  });

  it('withholds a retrying Provider diagnostic and publishes only eventual success', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(event));

    const prompt = sendPrompt(runtime, 'hello');
    await waitForWrittenCount(capture, 1);
    await ackLastCommand(capture);
    await expect(prompt).resolves.toEqual({ status: 'admitted' });
    const hasTerminalTurn = () => events.some((event) => (
      event.kind === 'turn-complete' || event.kind === 'turn-failed' || event.kind === 'turn-cancelled'
    ));
    expect(hasTerminalTurn()).toBe(false);

    await emit(capture, {
      type: 'message_end',
      message: {
        role: 'assistant',
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        content: [],
        stopReason: 'error',
        errorMessage: '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      },
    });
    await emit(capture, { type: 'turn_end', turnId: 'inner-turn-1' });
    await emit(capture, { type: 'agent_end', willRetry: true });
    await emit(capture, { type: 'turn_start', turnId: 'inner-turn-2' });
    await emit(capture, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'eventual success' },
      message: { role: 'assistant', content: [{ type: 'text', text: 'eventual success' }] },
    });
    await emit(capture, { type: 'agent_end', willRetry: false });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'message-delta',
        channel: 'assistant',
        text: 'eventual success',
      }),
      expect.objectContaining({
        kind: 'turn-complete',
      }),
    ]));
    expect(events).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'turn-failed',
      }),
    ]));
    expect(hasTerminalTurn()).toBe(true);
    await runtime.dispose();
  });

  it('publishes only the latest Provider diagnostic when a Pi retry also fails', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(event));

    const prompt = sendPrompt(runtime, 'hello');
    await waitForWrittenCount(capture, 1);
    await ackLastCommand(capture);
    await expect(prompt).resolves.toEqual({ status: 'admitted' });

    await emit(capture, {
      type: 'message_end',
      message: {
        role: 'assistant',
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        content: [],
        stopReason: 'error',
        errorMessage:
          '529 {"type":"error","error":{"type":"overloaded_error","message":"First attempt overloaded"}}',
      },
    });
    await emit(capture, { type: 'agent_end', willRetry: true });
    await emit(capture, { type: 'turn_start', turnId: 'inner-turn-2' });
    await emit(capture, {
      type: 'message_end',
      message: {
        role: 'assistant',
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        content: [],
        stopReason: 'error',
        errorMessage: 'Provider request failed without a safe automatic continuation.',
        happierRequestAuthProviderDiagnostic:
          '401 {"type":"error","error":{"type":"authentication_error","message":"Final credential was rejected"}}',
      },
    });
    await emit(capture, { type: 'agent_end', willRetry: false });

    const failed = events.find((event) => event.kind === 'turn-failed');
    expect(failed).toEqual(expect.objectContaining({
      kind: 'turn-failed',
      diagnostic: expect.objectContaining({
        code: 'pi_provider_session_error',
        message: 'Final credential was rejected',
      }),
    }));
    expect(JSON.stringify(failed)).not.toContain('First attempt overloaded');
    await runtime.dispose();
  });

  it('publishes and logs only the normalized safe fields from a structured Provider failure', async () => {
    const capture: Capture = { specs: [], written: [], warnings: [] };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(event));

    const prompt = sendPrompt(runtime, 'hello');
    await waitForWrittenCount(capture, 1);
    await ackLastCommand(capture);
    await expect(prompt).resolves.toEqual({ status: 'admitted' });

    await emit(capture, {
      type: 'message_end',
      message: {
        role: 'assistant',
        provider: 'openai-codex',
        model: 'gpt-5.6-luna',
        content: [],
        stopReason: 'error',
        errorMessage:
          '401: {"error":{"code":"provider_auth_failed","message":"Credential sk-proj-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa was rejected"},"request_body":"secret prompt payload"}',
      },
    });
    await emit(capture, { type: 'agent_end', willRetry: false });

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'turn-failed',
        diagnostic: {
          code: 'provider_auth_failed',
          severity: 'error',
          message: 'Credential [REDACTED] was rejected',
        },
      }),
    ]));
    expect(capture.warnings).toEqual([
      [
        '[PiRuntime] Provider turn failed',
        {
          classification: 'pi_provider_failure',
          providerCode: 'provider_auth_failed',
          sanitizedPreview: 'Credential [REDACTED] was rejected',
        },
      ],
    ]);
    expect(JSON.stringify({ events, warnings: capture.warnings })).not.toContain('sk-proj-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(JSON.stringify({ events, warnings: capture.warnings })).not.toContain('secret prompt payload');
    await runtime.dispose();
  });

  it('preserves partial output and still fails the turn on a later Provider terminal', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(event));

    const prompt = sendPrompt(runtime, 'hello');
    await waitForWrittenCount(capture, 1);
    await ackLastCommand(capture);
    await expect(prompt).resolves.toEqual({ status: 'admitted' });

    await emit(capture, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'partial answer' },
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'partial answer' }],
      },
    });
    await emit(capture, {
      type: 'message_end',
      message: {
        role: 'assistant',
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        content: [{ type: 'text', text: 'partial answer' }],
        stopReason: 'error',
        errorMessage: 'Provider request failed without a safe automatic continuation.',
        happierRequestAuthProviderDiagnostic:
          '529 {"type":"error","error":{"type":"overloaded_error","message":"Provider failed after partial output"}}',
      },
    });
    await emit(capture, { type: 'agent_end', willRetry: false });

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'message-delta',
        channel: 'assistant',
        text: 'partial answer',
      }),
      expect.objectContaining({
        kind: 'turn-failed',
        diagnostic: expect.objectContaining({
          code: 'pi_provider_session_error',
          message: 'Provider failed after partial output',
        }),
      }),
    ]));
    expect(events.some((event) => event.kind === 'turn-complete')).toBe(false);
    await runtime.dispose();
  });

  it('terminalizes cancellation during Pi retry backoff with the withheld Provider diagnostic', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(event));

    const prompt = sendPrompt(runtime, 'hello');
    await waitForWrittenCount(capture, 1);
    await ackLastCommand(capture);
    await expect(prompt).resolves.toEqual({ status: 'admitted' });

    await emit(capture, {
      type: 'message_end',
      message: {
        role: 'assistant',
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        content: [],
        stopReason: 'error',
        errorMessage:
          '529 {"type":"error","error":{"type":"overloaded_error","message":"Provider overloaded before retry backoff"}}',
        happierRequestAuthProviderDiagnostic:
          '529 {"type":"error","error":{"type":"overloaded_error","message":"Provider overloaded before retry backoff"}}',
      },
    });
    await emit(capture, { type: 'agent_end', willRetry: true });

    const cancel = runtime.cancel!({ turnId: 'pi-turn-1', reason: 'user' });
    await waitForWrittenCount(capture, 2);
    await emit(capture, {
      type: 'auto_retry_end',
      success: false,
      finalError: 'Retry cancelled',
    });
    await ackLastCommand(capture);
    await expect(cancel).resolves.toEqual({ status: 'requested', turnId: 'pi-turn-1' });

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'turn-cancelled',
        cause: 'user',
        diagnostic: expect.objectContaining({
          code: 'pi_provider_session_error',
          message: 'Provider overloaded before retry backoff',
        }),
      }),
    ]));
    expect(events.some((event) => event.kind === 'turn-complete')).toBe(false);
    await runtime.dispose();
  });

  it('treats abort as cancelled when cleanup disposes the Pi RPC client first', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);

    const cancel = runtime.cancel!({ turnId: 'pi-turn-1', reason: 'user' });
    await waitForWrittenCount(capture, 1);
    expect(capture.written.at(-1)).toEqual(expect.objectContaining({ type: 'abort' }));

    await runtime.dispose();

    await expect(cancel).resolves.toEqual({ status: 'requested', turnId: 'pi-turn-1' });
  });

  it('terminalizes an acknowledged abort as cancelled once and admits a successor turn', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(AgentSessionRuntimeEventSchema.parse(event)));

    const firstPrompt = sendPrompt(runtime, 'first turn');
    await waitForWrittenCount(capture, 1);
    await ackLastCommand(capture);
    await expect(firstPrompt).resolves.toEqual({ status: 'admitted' });
    await emit(capture, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'partial first response' },
      message: { role: 'assistant', content: [{ type: 'text', text: 'partial first response' }] },
    });

    const cancel = runtime.cancel!({ turnId: 'pi-turn-1', reason: 'user' });
    await waitForWrittenCount(capture, 2);
    expect(capture.written.at(-1)).toEqual(expect.objectContaining({ type: 'abort' }));
    await emit(capture, { type: 'agent_end', willRetry: false });
    expect(events.some((event) => (
      event.kind === 'turn-complete' || event.kind === 'turn-failed' || event.kind === 'turn-cancelled'
    ))).toBe(false);
    await ackLastCommand(capture);
    await expect(cancel).resolves.toEqual({ status: 'requested', turnId: 'pi-turn-1' });

    const terminalEvents = () => events.filter((event) => (
      event.kind === 'turn-complete' || event.kind === 'turn-failed' || event.kind === 'turn-cancelled'
    ));
    expect(terminalEvents()).toEqual([
      expect.objectContaining({
        kind: 'turn-cancelled',
        sessionId: 'happier-session-1',
        turnId: 'pi-turn-1',
        cause: 'user',
      }),
    ]);

    await emit(capture, { type: 'agent_end', willRetry: false });
    expect(terminalEvents()).toHaveLength(1);

    const successor = sendPrompt(runtime, 'successor turn', {
      inputIds: ['pi-input-2'],
      delivery: { kind: 'newTurn', turnId: 'pi-turn-2' },
    });
    await waitForWrittenCount(capture, 3);
    await ackLastCommand(capture);
    await expect(successor).resolves.toEqual({ status: 'admitted' });
    await emit(capture, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'successor response' },
      message: { role: 'assistant', content: [{ type: 'text', text: 'successor response' }] },
    });
    await emit(capture, { type: 'agent_end', willRetry: false });

    expect(terminalEvents()).toEqual([
      expect.objectContaining({
        kind: 'turn-cancelled',
        turnId: 'pi-turn-1',
        cause: 'user',
      }),
      expect.objectContaining({
        kind: 'turn-complete',
        turnId: 'pi-turn-2',
      }),
    ]);
    await runtime.dispose();
  });

  it('releases a deferred final Pi boundary when abort is not acknowledged', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(AgentSessionRuntimeEventSchema.parse(event)));

    const prompt = sendPrompt(runtime, 'turn that keeps running');
    await waitForWrittenCount(capture, 1);
    await ackLastCommand(capture);
    await expect(prompt).resolves.toEqual({ status: 'admitted' });
    await emit(capture, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'completed despite abort failure' },
      message: { role: 'assistant', content: [{ type: 'text', text: 'completed despite abort failure' }] },
    });

    const cancel = runtime.cancel!({ turnId: 'pi-turn-1', reason: 'user' });
    await waitForWrittenCount(capture, 2);
    await emit(capture, { type: 'agent_end', willRetry: false });
    await failLastCommand(capture, 'abort refused');

    await expect(cancel).resolves.toMatchObject({
      status: 'unavailable',
      diagnostic: { code: 'pi_cancel_failed', message: 'abort refused' },
    });
    expect(events.filter((event) => (
      event.kind === 'turn-complete' || event.kind === 'turn-failed' || event.kind === 'turn-cancelled'
    ))).toEqual([
      expect.objectContaining({
        kind: 'turn-complete',
        turnId: 'pi-turn-1',
      }),
    ]);
    await runtime.dispose();
  });

  it('publishes a typed failed turn when Pi ends without assistant text', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => {
      events.push(event);
    });

    const prompt = sendPrompt(runtime, 'hello');
    await waitForWrittenCount(capture, 1);
    await ackLastCommand(capture);
    await expect(prompt).resolves.toEqual({ status: 'admitted' });

    await emit(capture, { type: 'turn_end', turnId: 'provider-turn-empty' });
    expect(events.some((event) => event.kind === 'turn-failed')).toBe(false);
    await emit(capture, { type: 'agent_end', willRetry: false });

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'turn-failed',
        sessionId: 'happier-session-1',
        agentTurnId: 'provider-turn-empty',
        diagnostic: expect.objectContaining({
          code: 'pi_empty_provider_response',
          message: expect.stringContaining('without returning an assistant message'),
        }),
      }),
    ]));
    expect(events).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'turn-complete',
        agentTurnId: 'provider-turn-empty',
      }),
    ]));
  });

  it('preserves Pi assistant error messages instead of reporting a generic empty response', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => {
      events.push(event);
    });

    const prompt = sendPrompt(runtime, 'hello');
    await waitForWrittenCount(capture, 1);
    await ackLastCommand(capture);
    await expect(prompt).resolves.toEqual({ status: 'admitted' });

    const providerError = JSON.stringify({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'Third-party apps now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage and keep going.',
      },
      request_id: 'req_sensitive',
    });

    await emit(capture, {
      type: 'message_end',
      message: {
        role: 'assistant',
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        content: [],
        stopReason: 'error',
        errorMessage: `400 ${providerError}`,
      },
    });
    await emit(capture, {
      type: 'turn_end',
      turnId: 'provider-turn-error',
      message: {
        role: 'assistant',
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        content: [],
        stopReason: 'error',
        errorMessage: `400 ${providerError}`,
      },
    });
    expect(events.some((event) => event.kind === 'turn-failed')).toBe(false);
    await emit(capture, { type: 'agent_end', willRetry: false });

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'turn-failed',
        sessionId: 'happier-session-1',
        agentTurnId: 'provider-turn-error',
        diagnostic: expect.objectContaining({
          code: 'pi_provider_session_error',
          message: expect.stringContaining('Third-party apps now draw from your extra usage'),
        }),
      }),
    ]));
    const failedTurn = events.find((event) => event.kind === 'turn-failed');
    expect(JSON.stringify(failedTurn)).not.toContain('req_sensitive');
    expect(JSON.stringify(failedTurn)).not.toContain('without returning an assistant message');
  });

  it('publishes the exact Provider diagnostic retained beside a retry-suppression message', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => {
      events.push(event);
    });

    const prompt = sendPrompt(runtime, 'hello');
    await waitForWrittenCount(capture, 1);
    await ackLastCommand(capture);
    await expect(prompt).resolves.toEqual({ status: 'admitted' });

    const exactProviderDiagnostic =
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"rate limit maybe; contact support"}}';
    await emit(capture, {
      type: 'message_end',
      message: {
        role: 'assistant',
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        content: [],
        stopReason: 'error',
        errorMessage: 'Provider request failed without a safe automatic continuation.',
        happierRequestAuthProviderDiagnostic: exactProviderDiagnostic,
      },
    });
    await emit(capture, { type: 'turn_end', turnId: 'provider-turn-error' });
    await emit(capture, { type: 'agent_end', willRetry: false });

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'turn-failed',
        diagnostic: expect.objectContaining({
          code: 'pi_provider_session_error',
          message: 'rate limit maybe; contact support',
        }),
      }),
    ]));
  });

  it('maps one sticky unexpected Pi process exit without double-terminalizing disposal', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(event));

    const prompt = sendPrompt(runtime, 'exit during turn');
    await waitForWrittenCount(capture, 1);
    await ackLastCommand(capture);
    await expect(prompt).resolves.toEqual({ status: 'admitted' });
    await emit(capture, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'partial' },
      message: { role: 'assistant', content: [{ type: 'text', text: 'partial' }] },
    });

    const exit = {
      exitCode: 17,
      signal: null,
      stdout: '',
      stderr: 'nested Pi child failure; apiKey=top-secret-value',
    };
    await emitExit(capture, exit);
    await emitExit(capture, exit);

    expect(events.filter((event) => event.kind === 'turn-failed')).toHaveLength(1);
    expect(events.filter((event) => event.kind === 'runtime-ended')).toHaveLength(1);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'turn-failed',
        diagnostic: expect.objectContaining({
          message: expect.stringMatching(/exit code 17.*nested Pi child failure/u),
        }),
      }),
    ]));
    expect(JSON.stringify(events)).not.toContain('top-secret-value');

    await runtime.dispose();
    await emitExit(capture, exit);
    expect(events.filter((event) => (
      event.kind === 'turn-complete' || event.kind === 'turn-failed' || event.kind === 'turn-cancelled'
    ))).toHaveLength(1);
    expect(events.filter((event) => event.kind === 'runtime-ended')).toHaveLength(1);
  });

  it('validates vendor runtime events before publishing them', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => {
      events.push(event);
    });

    await emit(capture, {
      type: 'runtime_event',
      event: {
        kind: 'runtime-activity-snapshot',
        sessionId: 'happier-session-1',
        emittedAtMs: 1,
        state: 'idle',
        activeCount: 0,
      },
    });
    await emit(capture, {
      type: 'runtime_event',
      event: {
        kind: 'message-delta',
        sessionId: 123,
        emittedAtMs: -1,
        delta: 'malformed',
      },
    });
    await emit(capture, {
      type: 'runtime_event',
      event: {
        kind: 'runtime-activity-snapshot',
        sessionId: 'happier-session-1',
        emittedAtMs: 2,
        state: 'active',
        activeCount: 1,
      },
    });

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      sequence: 1,
      kind: 'runtime-activity-snapshot',
      sessionId: 'happier-session-1',
      emittedAtMs: 1,
      state: 'idle',
      activeCount: 0,
    });
    const malformedResult = AgentSessionRuntimeEventSchema.safeParse(events[1]);
    expect(malformedResult.success).toBe(true);
    if (!malformedResult.success) return;
    expect(malformedResult.data).toMatchObject({
      kind: 'runtime-ended',
      sessionId: 'happier-session-1',
      cause: 'protocolError',
      diagnostic: {
        code: 'malformed_runtime_event',
      },
    });
    if (malformedResult.data.kind !== 'runtime-ended') return;
    const details = malformedResult.data.diagnostic?.details;
    expect(isRecord(details)).toBe(true);
    if (!isRecord(details) || !Array.isArray(details.issues)) return;
    expect(details.issues.length).toBeGreaterThan(0);
    expect(details.issues.every((issue) => (
      isRecord(issue) && Object.keys(issue).length === 1 && typeof issue.message === 'string'
    ))).toBe(true);
    expect(JSON.stringify(malformedResult.data)).toContain('message-delta');
  });

  it('rejects child transcript user text runtime events without stable local ids', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => {
      events.push(event);
    });

    await emit(capture, {
      type: 'runtime_event',
      event: {
        kind: 'transcript-user-text',
        sessionId: 'happier-session-1',
        emittedAtMs: 1,
        text: 'child terminal-origin prompt',
      },
    });

    expect(events).toHaveLength(1);
    const malformedResult = AgentSessionRuntimeEventSchema.safeParse(events[0]);
    expect(malformedResult.success).toBe(true);
    if (!malformedResult.success) return;
    expect(malformedResult.data).toMatchObject({
      kind: 'runtime-ended',
      sessionId: 'happier-session-1',
      diagnostic: {
        code: 'malformed_runtime_event',
      },
    });
    expect(JSON.stringify(malformedResult.data)).toContain('transcript-user-text');
  });

  it('validates projected Pi runtime events before publishing them', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(event));
    const send = sendPrompt(runtime, 'hello');
    await waitForWrittenCount(capture, 1);
    await ackLastCommand(capture);
    await expect(send).resolves.toEqual({ status: 'admitted' });
    events.length = 0;

    const nowSpy = vi.spyOn(Date, 'now').mockReturnValueOnce(-1).mockReturnValue(1);
    try {
      await emit(capture, {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'invalid-time' },
        message: { role: 'assistant', content: [{ type: 'text', text: 'invalid-time' }] },
      });
    } finally {
      nowSpy.mockRestore();
    }

    expect(events).toHaveLength(1);
    const malformedResult = AgentSessionRuntimeEventSchema.safeParse(events[0]);
    expect(malformedResult.success).toBe(true);
    if (!malformedResult.success) return;
    expect(malformedResult.data).toMatchObject({
      kind: 'runtime-ended',
      sessionId: 'happier-session-1',
      emittedAtMs: 1,
      diagnostic: {
        code: 'malformed_runtime_event',
      },
    });
    expect(JSON.stringify(malformedResult.data)).toContain('message-delta');
  });

  it('publishes a diagnostic for non-object vendor runtime event payloads', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => {
      events.push(event);
    });

    await emit(capture, {
      type: 'runtime_event',
      event: 'not-a-runtime-event',
    });

    expect(events).toHaveLength(1);
    const malformedResult = AgentSessionRuntimeEventSchema.safeParse(events[0]);
    expect(malformedResult.success).toBe(true);
    if (!malformedResult.success) return;
    expect(malformedResult.data).toMatchObject({
      kind: 'runtime-ended',
      sessionId: 'happier-session-1',
      diagnostic: {
        code: 'malformed_runtime_event',
      },
    });
  });
});
