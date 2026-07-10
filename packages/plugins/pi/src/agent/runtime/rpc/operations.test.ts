import type {
  ExecClientHandleV1,
  ExecJsonStreamClientSpecV1,
  JsonStreamClientV1,
  PluginContextV1,
  RuntimeEventV1,
} from '@happier-dev/plugin-sdk';
import { createExecutionRunHostBackendFromSessionRuntime } from '@happier-dev/plugin-sdk';
import { RuntimeEventV1Schema } from '@happier-dev/plugin-sdk/experimental/runtime/session';
import { describe, expect, it, vi } from 'vitest';

import {
  PI_BROKER_SELECTIONS_ENV,
  resolvePiBrokerExtensionPath,
  serializePiBrokerSelections,
} from '../../auth/services/broker/index.js';
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
    ctx: createPluginContext(capture),
    cwd: '/tmp/pi-workspace',
    env: {},
    happierSessionId: 'happier-session-1',
    initialSessionId: 'pi-provider-session-1',
  };
  return await createPiRuntimeOperations(params);
}

async function createRuntimeWithEnv(capture: Capture, env: Readonly<Record<string, string>>) {
  return await createPiRuntimeOperations({
    ctx: createPluginContext(capture),
    cwd: '/tmp/pi-workspace',
    env,
    happierSessionId: 'happier-session-1',
    initialSessionId: 'pi-provider-session-1',
  });
}

function parseEvents(events: RuntimeEventV1[]): RuntimeEventV1[] {
  return events.map((event) => RuntimeEventV1Schema.parse(event));
}

describe('createPiRuntimeOperations', () => {
  it('derives launch provider and startup model from the selected connected service', async () => {
    const capture: Capture = { specs: [], written: [] };

    await createRuntimeWithEnv(capture, {
      HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([
        { kind: 'profile', serviceId: 'openai-codex', profileId: 'primary' },
      ]),
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

  it('loads the broker extension when brokered connected-service selections are present', async () => {
    const capture: Capture = { specs: [], written: [] };
    const agentDir = '/tmp/happier-pi-agent-dir';

    await createRuntimeWithEnv(capture, {
      PI_CODING_AGENT_DIR: agentDir,
      [PI_BROKER_SELECTIONS_ENV]: serializePiBrokerSelections({
        anthropic: {
          serviceId: 'claude-subscription',
          profileId: 'claude-oauth',
          accountId: 'claude-account',
          planType: null,
        },
      }),
    });

    const args = capture.specs[0]?.launch.args ?? [];
    const extensionIndex = args.indexOf('--extension');
    expect(extensionIndex).toBeGreaterThanOrEqual(0);
    expect(args[extensionIndex + 1]).toBe(resolvePiBrokerExtensionPath(agentDir));
  });

  it('projects raw Pi turn records to canonical runtime events', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    const events: RuntimeEventV1[] = [];
    runtime.events.subscribe((event) => {
      events.push(event);
    });

    const prompt = runtime.send({ v: 1, text: 'hello' });
    await waitForWrittenCount(capture, 1);
    await ackLastCommand(capture);
    await expect(prompt).resolves.toEqual({ status: 'accepted' });
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
        agentTurnId: 'provider-turn-1',
      }),
    ]));
  });

  it('confirms provider acceptance only after Pi emits turn evidence', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    const accepted: Array<Readonly<{ userMessageSeq: number | null; userMessageSeqs?: readonly number[] }>> = [];
    runtime.setOnPromptAcceptedByProvider?.((info) => {
      accepted.push(info);
    });

    const prompt = runtime.send({ v: 1, text: 'hello' }, { userMessageSeq: 42 });
    await waitForWrittenCount(capture, 1);
    await ackLastCommand(capture);
    await expect(prompt).resolves.toEqual({ status: 'accepted' });

    expect(accepted).toEqual([]);

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

    expect(accepted).toEqual([{ userMessageSeq: 42, userMessageSeqs: [42] }]);
  });

  it('applies canonical reasoning_effort runtime config updates to Pi thinking level', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);

    const update = runtime.updateConfig({
      configOption: { id: 'reasoning_effort', value: 'high' },
    });
    await waitForWrittenCount(capture, 1);

    expect(capture.written.at(-1)).toEqual(expect.objectContaining({
      type: 'set_thinking_level',
      level: 'high',
    }));

    await ackLastCommand(capture);
    await expect(update).resolves.toBeUndefined();
  });

  it('does not miss provider acceptance when Pi emits evidence before the RPC response', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    const accepted: Array<Readonly<{ userMessageSeq: number | null; userMessageSeqs?: readonly number[] }>> = [];
    runtime.setOnPromptAcceptedByProvider?.((info) => {
      accepted.push(info);
    });

    const prompt = runtime.send({ v: 1, text: 'hello' }, { userMessageSeq: 43 });
    await waitForWrittenCount(capture, 1);
    await emit(capture, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'early' },
      message: { role: 'assistant', content: [{ type: 'text', text: 'early' }] },
    });
    await ackLastCommand(capture);
    await expect(prompt).resolves.toEqual({ status: 'accepted' });

    expect(accepted).toEqual([{ userMessageSeq: 43, userMessageSeqs: [43] }]);
  });

  it('waits for the accepted resumed turn stream when the prompt ACK fails before agent_start', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    const accepted: Array<Readonly<{ userMessageSeq: number | null; userMessageSeqs?: readonly number[] }>> = [];
    runtime.setOnPromptAcceptedByProvider?.((info) => {
      accepted.push(info);
    });

    const prompt = runtime.send({ v: 1, text: 'follow up after resume' }, { userMessageSeq: 44 });
    await waitForWrittenCount(capture, 1);
    await failLastCommand(capture, 'Prompt ACK raced with resumed session state');
    await emit(capture, { type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'stale pre-start failure' } });
    await emit(capture, { type: 'turn_end', turnId: 'stale-provider-turn' });
    await emit(capture, { type: 'agent_start', turnId: 'provider-turn-ack-race' });
    await emit(capture, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'accepted' },
      message: { role: 'assistant', content: [{ type: 'text', text: 'accepted' }] },
    });
    await emit(capture, { type: 'turn_end', turnId: 'provider-turn-ack-race' });

    await expect(prompt).resolves.toEqual({ status: 'accepted' });
    expect(accepted).toEqual([{ userMessageSeq: 44, userMessageSeqs: [44] }]);
  });

  it('projects raw Pi compaction records through the protocol event contract', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    const events: RuntimeEventV1[] = [];
    runtime.events.subscribe((event) => {
      events.push(event);
    });

    const prompt = runtime.send({ v: 1, text: 'hello' });
    await waitForWrittenCount(capture, 1);
    await ackLastCommand(capture);
    await expect(prompt).resolves.toEqual({ status: 'accepted' });
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
        source: 'agent-event',
        trigger: 'manual',
        backendId: 'pi',
        agentId: 'pi',
        agentSessionId: 'pi-provider-session-1',
      }),
      expect.objectContaining({
        kind: 'context-compaction',
        phase: 'completed',
        sessionId: 'happier-session-1',
        source: 'agent-event',
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
    const runtime = await createRuntime(capture);
    const backend = createExecutionRunHostBackendFromSessionRuntime({
      createSessionRuntime: () => runtime,
      waitForTurnCompletion: {
        mode: 'untilIdle',
        pollIntervalMs: 1,
      },
    });

    const prompt = backend.sendPrompt('pi-provider-session-1', 'hello');
    await waitForWrittenCount(capture, 1);
    await ackLastCommand(capture);
    await prompt;
    let completed = false;
    const completion = backend.waitForTurnCompletion?.().then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);

    await emit(capture, { type: 'agent_end' });
    await completion;
    expect(completed).toBe(true);
    await backend.dispose();
  });

  it('treats abort as cancelled when cleanup disposes the Pi RPC client first', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);

    const cancel = runtime.cancel();
    await waitForWrittenCount(capture, 1);
    expect(capture.written.at(-1)).toEqual(expect.objectContaining({ type: 'abort' }));

    await runtime.dispose();

    await expect(cancel).resolves.toEqual({ status: 'cancelled' });
  });

  it('publishes a typed failed turn when Pi ends without assistant text', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    const events: RuntimeEventV1[] = [];
    runtime.events.subscribe((event) => {
      events.push(event);
    });

    const prompt = runtime.send({ v: 1, text: 'hello' });
    await waitForWrittenCount(capture, 1);
    await ackLastCommand(capture);
    await expect(prompt).resolves.toEqual({ status: 'accepted' });

    await emit(capture, { type: 'turn_end', turnId: 'provider-turn-empty' });

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'turn-failed',
        sessionId: 'happier-session-1',
        agentTurnId: 'provider-turn-empty',
        issue: expect.objectContaining({
          code: 'pi_empty_provider_response',
          source: 'agent_session_error',
          agentId: 'pi',
          sanitizedPreview: expect.stringContaining('without returning an assistant message'),
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
    const events: RuntimeEventV1[] = [];
    runtime.events.subscribe((event) => {
      events.push(event);
    });

    const prompt = runtime.send({ v: 1, text: 'hello' });
    await waitForWrittenCount(capture, 1);
    await ackLastCommand(capture);
    await expect(prompt).resolves.toEqual({ status: 'accepted' });

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

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'turn-failed',
        sessionId: 'happier-session-1',
        agentTurnId: 'provider-turn-error',
        issue: expect.objectContaining({
          code: 'pi_provider_session_error',
          source: 'agent_session_error',
          agentId: 'pi',
          sanitizedPreview: expect.stringContaining('Third-party apps now draw from your extra usage'),
        }),
      }),
    ]));
    const failedTurn = events.find((event) => event.kind === 'turn-failed');
    expect(JSON.stringify(failedTurn)).not.toContain('req_sensitive');
    expect(JSON.stringify(failedTurn)).not.toContain('without returning an assistant message');
  });

  it('validates vendor runtime events before publishing them', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    const events: RuntimeEventV1[] = [];
    runtime.events.subscribe((event) => {
      events.push(event);
    });

    await emit(capture, {
      type: 'runtime_event',
      event: {
        kind: 'backend-error',
        sessionId: 'happier-session-1',
        emittedAtMs: 1,
        error: { message: 'valid event', code: 'valid_runtime_event' },
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

    expect(events[0]).toEqual({
      kind: 'backend-error',
      sessionId: 'happier-session-1',
      emittedAtMs: 1,
      error: { message: 'valid event', code: 'valid_runtime_event' },
    });
    const malformedResult = RuntimeEventV1Schema.safeParse(events[1]);
    expect(malformedResult.success).toBe(true);
    if (!malformedResult.success) return;
    expect(malformedResult.data).toMatchObject({
      kind: 'backend-error',
      sessionId: 'happier-session-1',
      error: {
        code: 'malformed_runtime_event',
      },
    });
    expect(JSON.stringify(malformedResult.data)).toContain('message-delta');
  });

  it('rejects child transcript user text runtime events without stable local ids', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    const events: RuntimeEventV1[] = [];
    runtime.events.subscribe((event) => {
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
    const malformedResult = RuntimeEventV1Schema.safeParse(events[0]);
    expect(malformedResult.success).toBe(true);
    if (!malformedResult.success) return;
    expect(malformedResult.data).toMatchObject({
      kind: 'backend-error',
      sessionId: 'happier-session-1',
      error: {
        code: 'malformed_runtime_event',
      },
    });
    expect(JSON.stringify(malformedResult.data)).toContain('transcript-user-text');
    expect(JSON.stringify(malformedResult.data)).toContain('localId');
  });

  it('validates projected Pi runtime events before publishing them', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    const events: RuntimeEventV1[] = [];
    runtime.events.subscribe((event) => events.push(event));
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValueOnce(-1).mockReturnValue(1);
    const send = runtime.send({ v: 1, text: 'hello' });

    try {
      await Promise.resolve();
    } finally {
      nowSpy.mockRestore();
    }
    await waitForWrittenCount(capture, 1);
    await ackLastCommand(capture);
    await expect(send).resolves.toEqual({ status: 'accepted' });

    expect(events).toHaveLength(1);
    const malformedResult = RuntimeEventV1Schema.safeParse(events[0]);
    expect(malformedResult.success).toBe(true);
    if (!malformedResult.success) return;
    expect(malformedResult.data).toMatchObject({
      kind: 'backend-error',
      sessionId: 'happier-session-1',
      emittedAtMs: 1,
      error: {
        code: 'malformed_runtime_event',
      },
    });
    expect(JSON.stringify(malformedResult.data)).toContain('turn-start');
  });

  it('publishes a diagnostic for non-object vendor runtime event payloads', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    const events: RuntimeEventV1[] = [];
    runtime.events.subscribe((event) => {
      events.push(event);
    });

    await emit(capture, {
      type: 'runtime_event',
      event: 'not-a-runtime-event',
    });

    expect(events).toHaveLength(1);
    const malformedResult = RuntimeEventV1Schema.safeParse(events[0]);
    expect(malformedResult.success).toBe(true);
    if (!malformedResult.success) return;
    expect(malformedResult.data).toMatchObject({
      kind: 'backend-error',
      sessionId: 'happier-session-1',
      error: {
        code: 'malformed_runtime_event',
      },
    });
  });
});
