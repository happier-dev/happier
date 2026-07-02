import { describe, expect, it, vi } from 'vitest';

import type { PluginContextV1 } from '@happier-dev/plugin-sdk';
import { RuntimeEventV1Schema, type RuntimeEventV1 } from '@happier-dev/protocol';

import type { OpenCodeRuntimeTurnOperations } from './operations.js';
import { createOpenCodeServerRuntime } from './runtime.js';
import type { OpenCodeServerClient } from './openCodeServerClient.js';

type RuntimeWithProviderEvents = OpenCodeRuntimeTurnOperations & Readonly<{
  handleProviderEvent(event: unknown): Promise<void>;
}>;

type TestOpenCodeClient = OpenCodeServerClient & Readonly<{
  emitProviderEvent(event: unknown): void;
  setMessages(messages: readonly unknown[]): void;
  subscribeGlobalEvents(input: Readonly<{
    signal: AbortSignal;
    onEvent: (event: unknown) => void;
  }>): Promise<void>;
}>;

function createContextFixture() {
  const runtimeEvents: RuntimeEventV1[] = [];
  const metadataWrites: unknown[] = [];
  const stateFieldWrites: unknown[] = [];
  const writeMetadata = vi.fn(async (request: unknown) => {
    metadataWrites.push(request);
  });
  const writeStateField = vi.fn(async (request: unknown) => {
    stateFieldWrites.push(request);
  });
  const ctx = {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    transcripts: {
      append: vi.fn(async () => undefined),
      defineSource: vi.fn(),
    },
    events: {
      emit: vi.fn(async () => undefined),
      subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
    },
    sessions: {
      writeMetadata,
      writeStateField,
    },
    session: {
      permissions: {
        requestDecision: vi.fn(async () => ({ decision: 'approved' })),
        getMode: vi.fn(() => 'default'),
      },
    },
    telemetry: {
      emit: vi.fn(),
    },
    fetch: vi.fn(),
    // Test fixture intentionally implements only the PluginContext fields exercised by this runtime leaf.
  } as unknown as PluginContextV1;

  return { ctx, runtimeEvents, metadataWrites, stateFieldWrites, writeMetadata, writeStateField };
}

function createClientFixture(): TestOpenCodeClient {
  let messages: readonly unknown[] = [];
  let providerEventHandler: ((event: unknown) => void) | null = null;
  return {
    emitProviderEvent(event) {
      providerEventHandler?.(event);
    },
    setMessages(nextMessages) {
      messages = nextMessages;
    },
    sessionCreate: vi.fn(async () => ({ id: 'ses-1' })),
    sessionPromptAsync: vi.fn(async () => undefined),
    sessionAbort: vi.fn(async () => undefined),
    sessionStatus: vi.fn(async () => ({ type: 'idle' })),
    sessionMessages: vi.fn(async () => messages),
    sessionTodo: vi.fn(async () => [
      { id: 'todo-1', content: 'Ship OpenCode runtime', status: 'in_progress', priority: 'high' },
    ]),
    subscribeGlobalEvents: vi.fn(async ({ onEvent }) => {
      providerEventHandler = onEvent;
    }),
    providersList: vi.fn(async () => []),
  } satisfies TestOpenCodeClient;
}

async function createStartedRuntime(params?: Readonly<{
  client?: TestOpenCodeClient;
  ctx?: PluginContextV1;
  runtimeEvents?: RuntimeEventV1[];
}>): Promise<RuntimeWithProviderEvents> {
  const runtime = createOpenCodeServerRuntime({
    ctx: params?.ctx ?? createContextFixture().ctx,
    directory: '/repo',
    happierSessionId: 'happy-session-1',
    baseUrl: 'http://127.0.0.1:4096',
    client: params?.client ?? createClientFixture(),
  }) as RuntimeWithProviderEvents;
  if (params?.runtimeEvents) {
    runtime.subscribeRuntimeEvents((message) => {
      const parsed = RuntimeEventV1Schema.safeParse(message);
      if (parsed.success) {
        params.runtimeEvents!.push(parsed.data);
      }
    });
  }
  await runtime.startOrLoadSession();
  return runtime;
}

describe('createOpenCodeServerRuntime', () => {
  it('exposes the final runtime event subscription operation name', async () => {
    const runtime = await createStartedRuntime();

    expect(typeof runtime.subscribeRuntimeEvents).toBe('function');
    expect('subscribeRuntimeMessages' in runtime).toBe(false);
  });

  it('publishes native todo updates through the registered runtime work-state field', async () => {
    const { ctx, metadataWrites, stateFieldWrites, writeMetadata, writeStateField } = createContextFixture();
    const client = createClientFixture();
    const runtime = await createStartedRuntime({ ctx, client });

    expect(typeof runtime.handleProviderEvent).toBe('function');
    await runtime.handleProviderEvent({
      payload: {
        type: 'todo.updated',
        properties: { sessionID: 'ses-1' },
      },
    });

    expect(client.sessionTodo).toHaveBeenCalledWith({ sessionId: 'ses-1' });
    expect(writeMetadata).not.toHaveBeenCalled();
    expect(writeStateField).toHaveBeenCalledWith(expect.objectContaining({
      fieldId: 'runtime.workState',
      reason: 'opencode_todo_updated',
    }));
    expect(metadataWrites).toHaveLength(0);
    const workStateWrites = stateFieldWrites.filter((write) => (
      write as Readonly<{ fieldId?: unknown }>
    ).fieldId === 'runtime.workState');
    expect(workStateWrites).toHaveLength(1);
    expect(workStateWrites[0]).toMatchObject({
      fieldId: 'runtime.workState',
      value: {
        v: 1,
        backendId: 'opencode',
        agentId: 'opencode',
        primaryItemId: 'todo:opencode:todo-1',
        items: [
          expect.objectContaining({
            id: 'todo:opencode:todo-1',
            status: 'active',
            title: 'Ship OpenCode runtime',
          }),
        ],
      },
    });
    expect((workStateWrites[0] as { value?: unknown }).value).toMatchObject({
      backendId: 'opencode',
      agentId: 'opencode',
      primaryItemId: 'todo:opencode:todo-1',
      items: [
        expect.objectContaining({
          id: 'todo:opencode:todo-1',
          status: 'active',
          title: 'Ship OpenCode runtime',
        }),
      ],
    });
  });

  it('publishes provider session identity through the registered session-state field when starting a session', async () => {
    const { ctx, metadataWrites, stateFieldWrites, writeMetadata, writeStateField } = createContextFixture();
    const client = createClientFixture();

    await createStartedRuntime({ ctx, client });

    expect(writeMetadata).not.toHaveBeenCalled();
    expect(writeStateField).toHaveBeenCalledWith(expect.objectContaining({
      fieldId: 'identity.providerSessionId',
      value: {
        metadataKey: 'opencodeSessionId',
        value: 'ses-1',
      },
      reason: 'opencode_session_started',
    }));
    expect(metadataWrites).toHaveLength(0);
    expect(stateFieldWrites).toEqual(expect.arrayContaining([
      expect.objectContaining({
        fieldId: 'identity.providerSessionId',
        value: {
          metadataKey: 'opencodeSessionId',
          value: 'ses-1',
        },
      }),
    ]));
  });

  it('passes runtime config variant as a top-level OpenCode prompt field', async () => {
    const { ctx, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    const runtime = await createStartedRuntime({ ctx, client, runtimeEvents });

    await runtime.updateSessionRuntimeConfig({
      configOptions: {
        variant: ' high ',
        temperature: 0.2,
      },
    });
    await runtime.sendTurnPrompt('Use deeper reasoning.');

    expect(client.sessionPromptAsync).toHaveBeenCalledWith({
      sessionId: 'ses-1',
      messageId: expect.stringMatching(/:user$/),
      text: 'Use deeper reasoning.',
      variant: 'high',
      config: {
        temperature: 0.2,
      },
    });
    expect(ctx.transcripts.append).not.toHaveBeenCalled();
    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'transcript-user-text',
        text: 'Use deeper reasoning.',
        localId: expect.stringMatching(/:user$/),
      }),
    ]));
  });

  it('does not publish execution-run status envelopes on the session runtime event stream', async () => {
    const client = createClientFixture();
    const runtime = await createStartedRuntime({ client });
    const rawEvents: unknown[] = [];
    runtime.subscribeRuntimeEvents((event) => {
      rawEvents.push(event);
    });

    runtime.beginTurnLifecycle();
    await runtime.waitForTurnCompletion();

    expect(rawEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'status' }),
    ]));
  });

  it('keeps todo update events non-fatal when work-state publication fails', async () => {
    const { ctx, writeStateField } = createContextFixture();
    const client = createClientFixture();
    const publishError = new Error('session-state unavailable');
    writeStateField.mockImplementation(async (request: unknown) => {
      if ((request as Readonly<{ fieldId?: unknown }>).fieldId === 'runtime.workState') {
        throw publishError;
      }
    });
    const runtime = await createStartedRuntime({ ctx, client });

    await expect(runtime.handleProviderEvent({
      payload: {
        type: 'todo.updated',
        properties: { sessionID: 'ses-1' },
      },
    })).resolves.toBeUndefined();

    expect(client.sessionTodo).toHaveBeenCalledWith({ sessionId: 'ses-1' });
    expect(ctx.logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('todo'),
      expect.objectContaining({ error: publishError }),
    );
  });

  it('keeps turns open for live provider tool work until reconnect history supplies terminal evidence', async () => {
    const { ctx, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    const runtime = await createStartedRuntime({ ctx, client, runtimeEvents });
    runtime.beginTurnLifecycle();

    await runtime.handleProviderEvent({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'tool',
            sessionID: 'ses-1',
            callID: 'call-1',
            tool: 'bash',
            state: { status: 'running' },
          },
        },
      },
    });

    await runtime.waitForTurnCompletion();
    expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(false);

    client.setMessages([
      {
        parts: [
          {
            type: 'tool',
            sessionID: 'ses-1',
            callID: 'call-1',
            tool: 'bash',
            state: { status: 'completed' },
          },
        ],
      },
    ]);
    await runtime.handleProviderEvent({ payload: { type: 'server.connected', properties: {} } });
    await runtime.waitForTurnCompletion();

    expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(true);
  });

  it('keeps polling turns open while refreshed OpenCode history still has running provider work', async () => {
    const { ctx, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    client.setMessages([
      {
        info: { id: 'msg-running-tool', role: 'assistant', sessionID: 'ses-1' },
        parts: [
          {
            id: 'part-running-tool',
            type: 'tool',
            sessionID: 'ses-1',
            messageID: 'msg-running-tool',
            callID: 'call-running-tool',
            tool: 'bash',
            state: { status: 'running' },
          },
        ],
      },
    ]);
    const runtime = await createStartedRuntime({ ctx, client, runtimeEvents });
    runtime.beginTurnLifecycle();

    await runtime.handleProviderEvent({
      payload: {
        type: 'message.updated',
        properties: {
          info: { id: 'msg-running-tool', role: 'assistant', sessionID: 'ses-1' },
        },
      },
    });
    await runtime.waitForTurnCompletion();

    expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(false);
  });

  it('keeps active turns open when the status poll fails transiently', async () => {
    const { ctx, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    const pollError = new Error('status endpoint unavailable');
    vi.mocked(client.sessionStatus)
      .mockRejectedValueOnce(pollError)
      .mockResolvedValueOnce({ type: 'idle' });
    const runtime = await createStartedRuntime({ ctx, client, runtimeEvents });
    runtime.beginTurnLifecycle();

    await expect(runtime.waitForTurnCompletion()).resolves.toBeUndefined();
    expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(false);
    expect(ctx.logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('status poll failed'),
      expect.objectContaining({ error: pollError }),
    );

    await runtime.waitForTurnCompletion();

    expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(true);
  });

  it('ignores broad history running tools that are not tied to the active OpenCode turn', async () => {
    const { ctx, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    client.setMessages([
      {
        info: { id: 'msg-stale-running-tool', role: 'assistant', sessionID: 'ses-1' },
        parts: [
          {
            id: 'part-stale-running-tool',
            type: 'tool',
            sessionID: 'ses-1',
            messageID: 'msg-stale-running-tool',
            callID: 'call-stale-running-tool',
            tool: 'bash',
            state: { status: 'running' },
          },
        ],
      },
    ]);
    const runtime = await createStartedRuntime({ ctx, client, runtimeEvents });
    runtime.beginTurnLifecycle();

    await runtime.waitForTurnCompletion();

    expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(true);
  });

  it('completes active turns when OpenCode reports idle after provider work has drained', async () => {
    const { ctx, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    const runtime = await createStartedRuntime({ ctx, client, runtimeEvents });
    runtime.beginTurnLifecycle();

    await runtime.handleProviderEvent({
      payload: {
        type: 'session.status',
        properties: {
          sessionID: 'ses-1',
          status: { type: 'idle' },
        },
      },
    });

    expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(true);
  });

  it('starts a provider-autonomous turn for native background task parent output', async () => {
    const { ctx, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    const runtime = await createStartedRuntime({ ctx, client, runtimeEvents });

    await runtime.handleProviderEvent({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'text',
            sessionID: 'ses-1',
            messageID: 'msg-native-background-wake',
            text: '<task id="ses-background-child" state="completed"><task_result>Done</task_result></task>',
          },
        },
      },
    });
    expect(runtimeEvents.some((event) => event.kind === 'turn-start')).toBe(false);

    await runtime.handleProviderEvent({
      payload: {
        type: 'session.status',
        properties: {
          sessionID: 'ses-1',
          status: { type: 'busy' },
        },
      },
    });
    await runtime.handleProviderEvent({
      payload: {
        type: 'session.status',
        properties: {
          sessionID: 'ses-1',
          status: { type: 'idle' },
        },
      },
    });

    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'turn-start' }),
      expect.objectContaining({ kind: 'turn-complete' }),
    ]));
    expect(runtimeEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ providerTurnId: 'ses-1' }),
    ]));
  });

  it('wires provider events from the OpenCode server subscription into turn lifecycle handling', async () => {
    const { ctx, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    const runtime = await createStartedRuntime({ ctx, client, runtimeEvents });

    expect(client.subscribeGlobalEvents).toHaveBeenCalledTimes(1);

    client.emitProviderEvent({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'text',
            sessionID: 'ses-1',
            messageID: 'msg-native-background-wake',
            text: '<task state="completed" id="ses-background-child"><task_result>Done</task_result></task>',
          },
        },
      },
    });
    client.emitProviderEvent({
      payload: {
        type: 'session.status',
        properties: {
          sessionID: 'ses-1',
          status: { type: 'busy' },
        },
      },
    });
    client.emitProviderEvent({
      payload: {
        type: 'session.status',
        properties: {
          sessionID: 'ses-1',
          status: { type: 'idle' },
        },
      },
    });

    await expect.poll(() => runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(true);
    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'turn-start' }),
      expect.objectContaining({ kind: 'turn-complete' }),
    ]));
    expect(runtimeEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ providerTurnId: 'ses-1' }),
    ]));

    await runtime.resetOrDisposeRuntime();
  });

  it('starts a provider-autonomous turn for oh-my-openagent background output', async () => {
    const { ctx, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    const runtime = await createStartedRuntime({ ctx, client, runtimeEvents });

    await runtime.handleProviderEvent({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'text',
            sessionID: 'ses-1',
            messageID: 'msg-omo-background-wake',
            text: [
              '<system-reminder>',
              '[ALL BACKGROUND TASKS COMPLETE]',
              'Use `background_output(task_id="bg_abc123")` to retrieve each result.',
              '</system-reminder>',
              '<!-- OMO_INTERNAL_INITIATOR -->',
            ].join('\n'),
          },
        },
      },
    });
    expect(runtimeEvents.some((event) => event.kind === 'turn-start')).toBe(false);

    await runtime.handleProviderEvent({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'tool',
            sessionID: 'ses-1',
            callID: 'call-background-output',
            tool: 'background_output',
            state: {
              status: 'completed',
              input: { task_id: 'bg_abc123' },
              output: '# Task Result\n\nResult ready',
              metadata: { backgroundTaskId: 'bg_abc123' },
            },
          },
        },
      },
    });
    await runtime.handleProviderEvent({
      payload: {
        type: 'session.idle',
        properties: { sessionID: 'ses-1' },
      },
    });

    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'turn-start' }),
      expect.objectContaining({ kind: 'turn-complete' }),
    ]));
    expect(runtimeEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ providerTurnId: 'ses-1' }),
    ]));
  });

  it('ignores background task events from other OpenCode sessions', async () => {
    const { ctx, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    const runtime = await createStartedRuntime({ ctx, client, runtimeEvents });

    await runtime.handleProviderEvent({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'text',
            sessionID: 'ses-other',
            messageID: 'msg-other-background-wake',
            text: [
              '<system-reminder>',
              '[ALL BACKGROUND TASKS COMPLETE]',
              'Use `background_output(task_id="bg_other")` to retrieve each result.',
              '</system-reminder>',
              '<!-- OMO_INTERNAL_INITIATOR -->',
            ].join('\n'),
          },
        },
      },
    });
    await runtime.handleProviderEvent({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'tool',
            sessionID: 'ses-other',
            callID: 'call-other-background-output',
            tool: 'background_output',
            state: {
              status: 'completed',
              input: { task_id: 'bg_other' },
              output: '# Task Result\n\nOther result',
            },
          },
        },
      },
    });
    await runtime.handleProviderEvent({
      payload: {
        type: 'session.status',
        properties: {
          sessionID: 'ses-1',
          status: { type: 'busy' },
        },
      },
    });
    await runtime.handleProviderEvent({
      payload: {
        type: 'session.idle',
        properties: { sessionID: 'ses-1' },
      },
    });

    expect(runtimeEvents.some((event) => event.kind === 'turn-start')).toBe(false);
    expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(false);
  });

  it('fails active turns when OpenCode reports usage-limit retry status from provider events', async () => {
    const { ctx, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    const runtime = await createStartedRuntime({ ctx, client, runtimeEvents });
    runtime.beginTurnLifecycle();

    await expect(runtime.handleProviderEvent({
      payload: {
        type: 'session.status',
        properties: {
          sessionID: 'ses-1',
          status: {
            type: 'retry',
            attempt: 3,
            message: 'The usage limit has been reached',
            next: Date.now() + 60_000,
          },
        },
      },
    })).rejects.toThrow('The usage limit has been reached');

    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'turn-failed',
        issue: expect.objectContaining({
          source: 'usage_limit',
          provider: 'opencode',
          code: 'opencode_session_retry',
          usageLimit: expect.objectContaining({
            quotaScope: 'account',
            recoverability: 'wait',
            resetAtMs: null,
            retryAfterMs: expect.any(Number),
          }),
        }),
      }),
    ]));
    expect(ctx.transcripts.append).not.toHaveBeenCalled();
    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'transcript-agent-message-committed',
        provider: 'opencode',
        body: expect.objectContaining({
          type: 'turn_failed',
        }),
      }),
    ]));
  });

  it('fails active turns when control-plane status polling reports usage-limit retry', async () => {
    const { ctx, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    vi.mocked(client.sessionStatus).mockResolvedValue({
      type: 'retry',
      attempt: 4,
      message: 'Quota limit reached for this account',
      next: Date.now() + 60_000,
    });
    const runtime = await createStartedRuntime({ ctx, client, runtimeEvents });
    runtime.beginTurnLifecycle();

    await expect(runtime.waitForTurnCompletion()).rejects.toThrow('Quota limit reached for this account');

    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'turn-failed',
        issue: expect.objectContaining({
          source: 'usage_limit',
          provider: 'opencode',
          code: 'opencode_session_retry',
          usageLimit: expect.objectContaining({
            limitCategory: 'usage_limit',
          }),
        }),
      }),
    ]));
    expect(ctx.transcripts.append).not.toHaveBeenCalled();
    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'transcript-agent-message-committed',
        provider: 'opencode',
        body: expect.objectContaining({
          type: 'turn_failed',
        }),
      }),
    ]));
  });
});
