import type {
  ExecClientHandleV1,
  ExecJsonStreamClientSpecV1,
  JsonStreamClientV1,
  PluginContextV1,
} from '@happier-dev/plugin-sdk';
import type { RuntimeEventV1 } from '@happier-dev/protocol/runtime';
import { RuntimeEventV1Schema } from '@happier-dev/protocol/runtime';
import { describe, expect, it } from 'vitest';

import { buildPiCompletedContextCompactionPayload } from './events.js';
import { createPiRuntimeOperations } from './operations.js';

type Capture = {
  specs: ExecJsonStreamClientSpecV1[];
  written: unknown[];
  listener?: (record: unknown) => void | Promise<void>;
};

function createPluginContext(capture: Capture): PluginContextV1 {
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
    logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    config: { values: {} },
    features: { isEnabled: () => false },
    capabilities: { has: () => false, list: () => [] },
    agents: {} as PluginContextV1['agents'],
    managedServer: {} as PluginContextV1['managedServer'],
    mcp: {} as PluginContextV1['mcp'],
    terminalHost: {} as PluginContextV1['terminalHost'],
    sessionHooks: {} as PluginContextV1['sessionHooks'],
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
    session: {} as PluginContextV1['session'],
    sessions: {} as PluginContextV1['sessions'],
    transcripts: {} as PluginContextV1['transcripts'],
    telemetry: {} as PluginContextV1['telemetry'],
    artifacts: {} as PluginContextV1['artifacts'],
    notifications: {} as PluginContextV1['notifications'],
    abort: {} as PluginContextV1['abort'],
    timeout: {} as PluginContextV1['timeout'],
    progress: {} as PluginContextV1['progress'],
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function emit(capture: Capture, record: unknown): Promise<void> {
  await capture.listener?.(record);
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

async function createRuntime(capture: Capture) {
  const params = {
    ctx: createPluginContext(capture),
    cwd: '/tmp/pi-workspace',
    env: {},
    happierSessionId: 'happier-session-1',
    initialSessionId: 'pi-provider-session-1',
  };
  return await createPiRuntimeOperations(params);
}

function parseEvents(events: RuntimeEventV1[]): RuntimeEventV1[] {
  return events.map((event) => RuntimeEventV1Schema.parse(event));
}

describe('createPiRuntimeOperations', () => {
  it('projects raw Pi turn records to canonical runtime events', async () => {
    const capture: Capture = { specs: [], written: [] };
    const { operations } = await createRuntime(capture);
    const events: RuntimeEventV1[] = [];
    operations.subscribeRuntimeEvents((event) => {
      events.push(event);
    });

    operations.beginTurnLifecycle();
    const prompt = operations.sendTurnPrompt('hello');
    await ackLastCommand(capture);
    await prompt;
    await emit(capture, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'hello' },
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

    const parsedEvents = parseEvents(events);
    const turnStart = parsedEvents.find((event) => event.kind === 'turn-start');
    expect(turnStart).toMatchObject({
      kind: 'turn-start',
      sessionId: 'happier-session-1',
      startedBy: 'provider',
    });
    expect(parsedEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'message-delta',
        sessionId: 'happier-session-1',
        turnId: turnStart?.turnId,
        delta: { text: 'hello' },
      }),
      expect.objectContaining({
        kind: 'tool-call',
        sessionId: 'happier-session-1',
        turnId: turnStart?.turnId,
        toolCallId: 'tool-call-1',
        toolName: 'grep',
        toolInput: { pattern: 'PiRuntime' },
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
        providerTurnId: 'provider-turn-1',
      }),
    ]));
  });

  it('projects raw Pi compaction records through the protocol event contract', async () => {
    const capture: Capture = { specs: [], written: [] };
    const { operations } = await createRuntime(capture);
    const events: RuntimeEventV1[] = [];
    operations.subscribeRuntimeEvents((event) => {
      events.push(event);
    });

    operations.beginTurnLifecycle();
    await emit(capture, { type: 'compaction_start', reason: 'manual' });
    await emit(capture, {
      type: 'compaction_end',
      reason: 'overflow',
      result: { tokensBefore: 100, tokensAfter: 40, retryAttempt: 1 },
    });

    const compactionEvents = parseEvents(events).filter((event) => event.kind === 'context-compaction');
    expect(compactionEvents).toEqual([
      expect.objectContaining({
        kind: 'context-compaction',
        phase: 'started',
        sessionId: 'happier-session-1',
        source: 'provider-event',
        trigger: 'manual',
        backendId: 'pi',
        agentId: 'pi',
        providerSessionId: 'pi-provider-session-1',
      }),
      expect.objectContaining({
        kind: 'context-compaction',
        phase: 'completed',
        sessionId: 'happier-session-1',
        source: 'provider-event',
        trigger: 'overflow',
        tokenCountBefore: 100,
        tokenCountAfter: 40,
        retryAttempt: 1,
      }),
    ]);
    expect(compactionEvents.every((event) => !('provider' in event))).toBe(true);
  });

  it('preserves terminal compaction phases from provider payload fields', () => {
    expect(buildPiCompletedContextCompactionPayload({
      type: 'compaction_end',
      reason: 'overflow',
      phase: 'failed',
      willRetry: false,
    })).toMatchObject({
      phase: 'failed',
      trigger: 'overflow',
    });

    expect(buildPiCompletedContextCompactionPayload({
      type: 'compaction_end',
      reason: 'manual',
      result: { phase: 'canceled' },
      willRetry: false,
    })).toMatchObject({
      phase: 'cancelled',
      trigger: 'manual',
    });
  });

  it('keeps turn completion pending until a terminal Pi event arrives', async () => {
    const capture: Capture = { specs: [], written: [] };
    const { operations } = await createRuntime(capture);

    operations.beginTurnLifecycle();
    let completed = false;
    const completion = operations.waitForTurnCompletion().then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);

    await emit(capture, { type: 'agent_end' });
    await completion;
    expect(completed).toBe(true);
  });
});
