import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ManagedServerSnapshotV1, PluginContextV1 } from '@happier-dev/plugin-sdk';
import type { RuntimeEventV1 } from '@happier-dev/plugin-sdk/experimental/runtime/session';
import {
  createAdapterHarness,
  createPluginContextV1Fixture,
  type AdapterHarnessV1,
} from '@happier-dev/plugin-sdk/experimental/testing/adapterHarness';

import {
  OPEN_CODE_BROKER_SELECTIONS_ENV,
  serializeOpenCodeBrokerSelections,
} from '../../auth/services/broker/index.js';
import type { OpenCodeRuntimeTurnOperations } from './operations.js';
import { createOpenCodePublicSessionRuntime } from './sessionRuntime.js';
import { createOpenCodeServerRuntime } from './runtime.js';
import type { OpenCodeServerClient } from './openCodeServerClient.js';

type RuntimeWithProviderEvents = OpenCodeRuntimeTurnOperations & Readonly<{
  handleProviderEvent(event: unknown): Promise<void>;
}>;

type TestOpenCodeClient = OpenCodeServerClient & Readonly<{
  emitProviderEvent(event: unknown): void;
  setMessages(messages: readonly unknown[]): void;
  globalConfigGet(): Promise<Readonly<Record<string, unknown>>>;
  permissionReply(input: Readonly<{
    requestId: string;
    reply: 'once' | 'always' | 'reject';
    message?: string | null;
  }>): Promise<void>;
  subscribeGlobalEvents(input: Readonly<{
    signal: AbortSignal;
    onEvent: (event: unknown) => void;
  }>): Promise<void>;
}>;

const activeHarnesses: AdapterHarnessV1[] = [];

afterEach(() => {
  let validationError: unknown;
  for (const harness of activeHarnesses) {
    try {
      harness.expectAllEventsValidated();
    } catch (error) {
      validationError ??= error;
    } finally {
      harness.dispose();
    }
  }
  activeHarnesses.length = 0;
  vi.useRealTimers();
  if (validationError) throw validationError;
});

function createContextFixture(options?: Parameters<typeof createPluginContextV1Fixture>[0]) {
  const harness = createAdapterHarness();
  activeHarnesses.push(harness);
  const fixture = createPluginContextV1Fixture(options);

  return {
    ctx: fixture.ctx,
    harness,
    runtimeEvents: harness.canonical(),
    metadataWrites: fixture.records.sessionMetadataWrites,
    stateFieldWrites: fixture.records.sessionStateFieldWrites,
    logs: fixture.records.logs,
    transcriptAppends: fixture.records.transcriptAppends,
  };
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
    permissionReply: vi.fn(async () => undefined),
    appSkills: vi.fn(async () => []),
    globalConfigGet: vi.fn(async () => ({})),
    subscribeGlobalEvents: vi.fn(async ({ onEvent }) => {
      providerEventHandler = onEvent;
    }),
    providersList: vi.fn(async () => []),
  } satisfies TestOpenCodeClient;
}

async function createStartedRuntime(params?: Readonly<{
  client?: TestOpenCodeClient;
  ctx?: PluginContextV1;
  env?: Readonly<Record<string, string>>;
  harness?: AdapterHarnessV1;
  readManagedServerSnapshot?: () => ManagedServerSnapshotV1 | null;
}>): Promise<RuntimeWithProviderEvents> {
  const runtimeParams = {
    ctx: params?.ctx ?? createContextFixture().ctx,
    directory: '/repo',
    happierSessionId: 'happy-session-1',
    baseUrl: 'http://127.0.0.1:49196',
    client: params?.client ?? createClientFixture(),
    env: params?.env,
    readManagedServerSnapshot: params?.readManagedServerSnapshot,
  };
  const runtime = createOpenCodeServerRuntime(runtimeParams) as RuntimeWithProviderEvents;
  params?.harness?.attachRuntime(runtime);
  await runtime.startOrLoadSession();
  return runtime;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function observePromisePending(promise: Promise<unknown>): Readonly<{ isPending(): boolean }> {
  let pending = true;
  void promise.then(
    () => {
      pending = false;
    },
    () => {
      pending = false;
    },
  );
  return {
    isPending: () => pending,
  };
}

describe('createOpenCodeServerRuntime', () => {
  it('exposes the final runtime event subscription operation name', async () => {
    const runtime = await createStartedRuntime();

    expect(typeof runtime.subscribeRuntimeEvents).toBe('function');
    expect('subscribeRuntimeMessages' in runtime).toBe(false);
  });

  it('publishes native todo updates through the registered runtime work-state field', async () => {
    const { ctx, metadataWrites, stateFieldWrites } = createContextFixture();
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
    const { ctx, metadataWrites, stateFieldWrites } = createContextFixture();
    const client = createClientFixture();

    await createStartedRuntime({ ctx, client });

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

  it('passes runtime model and singular configOption updates as OpenCode prompt fields', async () => {
    const { ctx, harness, runtimeEvents, transcriptAppends } = createContextFixture();
    const client = createClientFixture();
    const runtime = await createStartedRuntime({ ctx, client, harness });

    await runtime.updateSessionRuntimeConfig({
      modelId: 'opencode/big-pickle',
    });
    await runtime.updateSessionRuntimeConfig({
      configOption: { id: 'variant', value: ' high ' },
    });
    await runtime.updateSessionRuntimeConfig({
      configOption: { id: 'temperature', value: 0.2 },
    });
    await runtime.sendTurnPrompt('Use deeper reasoning.');

    expect(client.sessionPromptAsync).toHaveBeenCalledWith({
      sessionId: 'ses-1',
      text: 'Use deeper reasoning.',
      model: {
        providerID: 'opencode',
        modelID: 'big-pickle',
      },
      variant: 'high',
      config: {
        temperature: 0.2,
      },
    });
    expect(transcriptAppends).toHaveLength(0);
    expect(runtimeEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'transcript-user-text',
      }),
    ]));
  });

  it('lets OpenCode generate provider user message ids for async prompt turns', async () => {
    const { ctx, harness } = createContextFixture();
    const client = createClientFixture();
    const runtime = await createStartedRuntime({ ctx, client, harness });

    await runtime.sendTurnPrompt('Let OpenCode own message ordering.');

    const promptCall = vi.mocked(client.sessionPromptAsync).mock.calls[0]?.[0];
    expect(promptCall).toMatchObject({
      sessionId: 'ses-1',
      text: 'Let OpenCode own message ordering.',
    });
    expect(promptCall).not.toHaveProperty('messageId');
  });

  it('returns after launching the OpenCode message request instead of waiting for the provider turn to finish', async () => {
    const { ctx, harness } = createContextFixture();
    const client = createClientFixture();
    let settlePromptRequest: (() => void) | null = null;
    vi.mocked(client.sessionPromptAsync).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        settlePromptRequest = resolve;
      });
    });
    const runtime = await createStartedRuntime({ ctx, client, harness });

    const dispatch = runtime.sendTurnPrompt('Keep the provider request open.');
    const result = await Promise.race([
      dispatch.then(() => 'resolved' as const),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 25)),
    ]);

    expect(result).toBe('resolved');
    expect(client.sessionPromptAsync).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'ses-1',
      text: 'Keep the provider request open.',
    }));

    settlePromptRequest?.();
    await dispatch;
  });

  it('waits for the managed OpenCode server.connected startup event before dispatching the first prompt', async () => {
    const { ctx, harness } = createContextFixture();
    const client = createClientFixture();
    const runtime = await createStartedRuntime({
      ctx,
      client,
      harness,
      readManagedServerSnapshot: () => ({
        id: 'opencode-server',
        state: 'healthy',
        mode: 'managed-spawn',
        baseUrl: 'http://127.0.0.1:49196',
        port: 49196,
        credentialEnvKey: 'OPENCODE_SERVER_PASSWORD',
        pid: 100,
        startedAt: 1000,
        lastHealthyAt: 1200,
      } as ManagedServerSnapshotV1),
    });

    const dispatch = runtime.sendTurnPrompt('first prompt before startup readiness');
    const pending = observePromisePending(dispatch);
    await flushMicrotasks();

    expect(client.sessionPromptAsync).not.toHaveBeenCalled();
    expect(pending.isPending()).toBe(true);

    await runtime.handleProviderEvent({ payload: { type: 'server.connected', properties: {} } });
    await expect.poll(() => vi.mocked(client.sessionPromptAsync).mock.calls.length).toBe(1);

    await expect(dispatch).resolves.toBeUndefined();
  });

  it('does not let stale server.connected readiness satisfy a replacement managed-server generation', async () => {
    const { ctx, harness } = createContextFixture();
    const client = createClientFixture();
    let snapshot: ManagedServerSnapshotV1 = {
      id: 'opencode-server',
      state: 'healthy',
      mode: 'managed-spawn',
      baseUrl: 'http://127.0.0.1:49196',
      port: 49196,
      credentialEnvKey: 'OPENCODE_SERVER_PASSWORD',
      pid: 100,
      startedAt: 1000,
      lastHealthyAt: 1200,
    } as ManagedServerSnapshotV1;
    const runtime = await createStartedRuntime({
      ctx,
      client,
      harness,
      readManagedServerSnapshot: () => snapshot,
    });
    await runtime.handleProviderEvent({ payload: { type: 'server.connected', properties: {} } });

    snapshot = {
      ...snapshot,
      baseUrl: 'http://127.0.0.1:49197',
      port: 49197,
      pid: 200,
      startedAt: 2000,
      lastHealthyAt: 2200,
    } as ManagedServerSnapshotV1;
    const dispatch = runtime.sendTurnPrompt('first prompt after managed-server replacement');
    const pending = observePromisePending(dispatch);
    await flushMicrotasks();

    expect(client.sessionPromptAsync).not.toHaveBeenCalled();
    expect(pending.isPending()).toBe(true);

    await runtime.handleProviderEvent({ payload: { type: 'server.connected', properties: {} } });
    await expect.poll(() => vi.mocked(client.sessionPromptAsync).mock.calls.length).toBe(1);

    await expect(dispatch).resolves.toBeUndefined();
  });

  it('falls back to managed-server health readiness when the provider event subscription fails before server.connected', async () => {
    const { ctx, harness } = createContextFixture();
    const client = createClientFixture();
    vi.mocked(client.subscribeGlobalEvents).mockRejectedValueOnce(new Error('SSE unavailable'));
    const runtime = await createStartedRuntime({
      ctx,
      client,
      harness,
      readManagedServerSnapshot: () => ({
        id: 'opencode-server',
        state: 'healthy',
        mode: 'managed-spawn',
        baseUrl: 'http://127.0.0.1:49196',
        port: 49196,
        credentialEnvKey: 'OPENCODE_SERVER_PASSWORD',
        pid: 100,
        startedAt: 1000,
        lastHealthyAt: 1200,
      } as ManagedServerSnapshotV1),
    });

    const dispatch = runtime.sendTurnPrompt('first prompt after event stream failure');

    await expect.poll(() => vi.mocked(client.sessionPromptAsync).mock.calls.length).toBe(1);
    await expect(dispatch).resolves.toBeUndefined();
  });

  it('unblocks a prompt waiting for managed-server readiness when the turn is cancelled', async () => {
    const { ctx, harness } = createContextFixture();
    const client = createClientFixture();
    const runtime = await createStartedRuntime({
      ctx,
      client,
      harness,
      readManagedServerSnapshot: () => ({
        id: 'opencode-server',
        state: 'healthy',
        mode: 'managed-spawn',
        baseUrl: 'http://127.0.0.1:49196',
        port: 49196,
        credentialEnvKey: 'OPENCODE_SERVER_PASSWORD',
        pid: 100,
        startedAt: 1000,
        lastHealthyAt: 1200,
      } as ManagedServerSnapshotV1),
    });

    const dispatch = runtime.sendTurnPrompt('prompt cancelled before startup readiness');
    const pending = observePromisePending(dispatch);
    await flushMicrotasks();

    expect(client.sessionPromptAsync).not.toHaveBeenCalled();
    expect(pending.isPending()).toBe(true);

    await runtime.cancelTurn();

    await expect(dispatch).resolves.toBeUndefined();
    expect(client.sessionPromptAsync).not.toHaveBeenCalled();
  });

  it('resolves bare runtime model ids through a unique connected OpenCode provider before prompting', async () => {
    const { ctx, harness } = createContextFixture();
    const client = createClientFixture();
    vi.mocked(client.providersList).mockResolvedValueOnce([
      {
        id: 'openai',
        models: {
          'gpt-5.4-mini': {
            id: 'gpt-5.4-mini',
            status: 'active',
            capabilities: { input: { text: true } },
          },
        },
      },
    ]);
    const runtime = await createStartedRuntime({ ctx, client, harness });

    await runtime.updateSessionRuntimeConfig({
      modelId: 'gpt-5.4-mini',
    });
    await runtime.sendTurnPrompt('Use the selected model.');

    expect(client.sessionPromptAsync).toHaveBeenCalledWith(expect.objectContaining({
      model: {
        providerID: 'openai',
        modelID: 'gpt-5.4-mini',
      },
    }));
  });

  it('uses per-prompt model overrides without replacing the selected runtime model', async () => {
    const { ctx, harness } = createContextFixture();
    const client = createClientFixture();
    vi.mocked(client.globalConfigGet).mockResolvedValue({ model: 'openai/default-large' });
    vi.mocked(client.providersList).mockResolvedValue([
      {
        id: 'openai',
        models: {
          'gpt-5.2': {
            id: 'gpt-5.2',
            status: 'active',
            capabilities: { input: { text: true } },
          },
          'gpt-5.4-mini': {
            id: 'gpt-5.4-mini',
            status: 'active',
            capabilities: { input: { text: true } },
          },
        },
      },
    ]);
    const runtime = await createStartedRuntime({ ctx, client, harness });

    await runtime.updateSessionRuntimeConfig({
      modelId: 'openai/gpt-5.2',
    });
    await runtime.sendTurnPrompt('Use the one-shot model.', { modelId: 'gpt-5.4-mini' });
    await runtime.sendTurnPrompt('Use the selected runtime model.');

    expect(client.sessionPromptAsync).toHaveBeenNthCalledWith(1, expect.objectContaining({
      model: {
        providerID: 'openai',
        modelID: 'gpt-5.4-mini',
      },
    }));
    expect(client.sessionPromptAsync).toHaveBeenNthCalledWith(2, expect.objectContaining({
      model: {
        providerID: 'openai',
        modelID: 'gpt-5.2',
      },
    }));
  });

  it('resolves bare runtime model ids through the active default provider before unique fallback', async () => {
    const { ctx, harness } = createContextFixture();
    const client = createClientFixture();
    vi.mocked(client.globalConfigGet).mockResolvedValueOnce({ model: 'active-provider/default-large' });
    vi.mocked(client.providersList).mockResolvedValueOnce([
      {
        id: 'fallback-provider',
        models: {
          'shared-mini': {
            id: 'shared-mini',
            status: 'active',
            capabilities: { input: { text: true } },
          },
        },
      },
      {
        id: 'active-provider',
        models: {
          'default-large': {
            id: 'default-large',
            status: 'active',
            capabilities: { input: { text: true } },
          },
          'shared-mini': {
            id: 'shared-mini',
            status: 'active',
            capabilities: { input: { text: true } },
          },
        },
      },
    ]);
    const runtime = await createStartedRuntime({ ctx, client, harness });

    await runtime.updateSessionRuntimeConfig({
      modelId: 'shared-mini',
    });
    await runtime.sendTurnPrompt('Use the selected default-provider model.');

    expect(client.sessionPromptAsync).toHaveBeenCalledWith(expect.objectContaining({
      model: {
        providerID: 'active-provider',
        modelID: 'shared-mini',
      },
    }));
  });

  it('ignores legacy plural runtime configOptions updates', async () => {
    const { ctx, harness } = createContextFixture();
    const client = createClientFixture();
    const runtime = await createStartedRuntime({ ctx, client, harness });

    await runtime.updateSessionRuntimeConfig({
      configOptions: {
        variant: ' high ',
        temperature: 0.2,
      },
    });
    await runtime.sendTurnPrompt('Use default reasoning.');

    expect(client.sessionPromptAsync).toHaveBeenCalledWith({
      sessionId: 'ses-1',
      text: 'Use default reasoning.',
    });
  });

  it('publishes a canonical failed turn when OpenCode rejects prompt submission', async () => {
    const { ctx, harness, runtimeEvents, transcriptAppends } = createContextFixture();
    const client = createClientFixture();
    const promptError = new Error('OpenCode server request failed: 401 Unauthorized Authorization: Bearer sk-live-secret');
    vi.mocked(client.sessionPromptAsync).mockRejectedValueOnce(promptError);
    const runtime = await createStartedRuntime({ ctx, client, harness });

    runtime.beginTurnLifecycle();
    await expect(runtime.sendTurnPrompt('Please answer briefly.')).resolves.toBeUndefined();

    await vi.waitFor(() => {
      expect(runtimeEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'turn-failed',
          issue: expect.objectContaining({
            agentId: 'opencode',
            code: 'opencode_prompt_submission_failed',
            source: 'agent_session_error',
            sanitizedPreview: expect.stringContaining('Unauthorized'),
          }),
        }),
      ]));
    });

    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'turn-failed',
        issue: expect.objectContaining({
          agentId: 'opencode',
          code: 'opencode_prompt_submission_failed',
          source: 'agent_session_error',
          sanitizedPreview: expect.stringContaining('Unauthorized'),
        }),
      }),
      expect.objectContaining({
        kind: 'transcript-agent-message-committed',
        agentId: 'opencode',
        body: expect.objectContaining({
          type: 'turn_failed',
        }),
      }),
    ]));
    expect(runtimeEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'transcript-user-text',
      }),
    ]));
    expect(JSON.stringify(runtimeEvents)).not.toContain('sk-live-secret');
    expect(transcriptAppends).toHaveLength(0);
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
    const client = createClientFixture();
    const publishError = new Error('session-state unavailable');
    const { ctx, logs } = createContextFixture({
      onSessionStateFieldWrite: async (request) => {
        if ((request as Readonly<{ fieldId?: unknown }>).fieldId !== 'runtime.workState') return;
        throw publishError;
      },
    });
    const runtime = await createStartedRuntime({ ctx, client });

    await expect(runtime.handleProviderEvent({
      payload: {
        type: 'todo.updated',
        properties: { sessionID: 'ses-1' },
      },
    })).resolves.toBeUndefined();

    expect(client.sessionTodo).toHaveBeenCalledWith({ sessionId: 'ses-1' });
    expect(logs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        level: 'debug',
        message: expect.stringContaining('todo'),
        fields: expect.objectContaining({ error: publishError }),
      }),
    ]));
  });

  it('bridges OpenCode permission asks through the session permission service and replies once', async () => {
    const permissionRequests: unknown[] = [];
    const { ctx } = createContextFixture({
      onPermissionDecision: async (request) => {
        permissionRequests.push(request);
        return { decision: 'denied', rationale: 'read-only mode denied bash' };
      },
    });
    const client = createClientFixture();
    const runtime = await createStartedRuntime({ ctx, client });

    await runtime.handleProviderEvent({
      payload: {
        type: 'permission.asked',
        properties: {
          sessionID: 'ses-1',
          id: 'per_123',
          permission: 'bash',
          patterns: ['echo "WAVE90_CLI_SURFACE_OK"'],
        },
      },
    });
    await runtime.handleProviderEvent({
      payload: {
        type: 'permission.asked',
        properties: {
          sessionID: 'ses-1',
          id: 'per_123',
          permission: 'bash',
          patterns: ['echo "WAVE90_CLI_SURFACE_OK"'],
        },
      },
    });

    expect(permissionRequests).toEqual([
      expect.objectContaining({
        provider: 'opencode',
        requestId: 'per_123',
        toolName: 'bash',
        input: expect.objectContaining({
          permission: 'bash',
          patterns: ['echo "WAVE90_CLI_SURFACE_OK"'],
          providerSessionId: 'ses-1',
        }),
      }),
    ]);
    expect(client.permissionReply).toHaveBeenCalledTimes(1);
    expect(client.permissionReply).toHaveBeenCalledWith({
      requestId: 'per_123',
      reply: 'reject',
      message: 'read-only mode denied bash',
    });
  });

  it('reattaches provider event subscription after a stream drop before later permission asks', async () => {
    const permissionRequests: unknown[] = [];
    const { ctx } = createContextFixture({
      onPermissionDecision: async (request) => {
        permissionRequests.push(request);
        return { decision: 'approved' };
      },
    });
    const client = createClientFixture();
    const subscriptionHandlers: Array<(event: unknown) => void> = [];
    let rejectFirstSubscription!: (reason?: unknown) => void;
    vi.mocked(client.subscribeGlobalEvents).mockImplementation(({ onEvent }) => {
      subscriptionHandlers.push(onEvent);
      if (subscriptionHandlers.length === 1) {
        return new Promise<void>((_resolve, reject) => {
          rejectFirstSubscription = reject;
        });
      }
      return new Promise<void>(() => undefined);
    });

    await createStartedRuntime({ ctx, client });

    expect(client.subscribeGlobalEvents).toHaveBeenCalledTimes(1);
    rejectFirstSubscription(new Error('stream dropped'));
    await expect.poll(() => vi.mocked(client.subscribeGlobalEvents).mock.calls.length).toBe(2);

    subscriptionHandlers[1]?.({
      payload: {
        type: 'permission.asked',
        properties: {
          sessionID: 'ses-1',
          id: 'per_after_reconnect',
          permission: 'bash',
          patterns: ['pwd'],
        },
      },
    });

    await expect.poll(() => vi.mocked(client.permissionReply).mock.calls.length).toBe(1);
    expect(permissionRequests).toEqual([
      expect.objectContaining({
        provider: 'opencode',
        requestId: 'per_after_reconnect',
      }),
    ]);
    expect(client.permissionReply).toHaveBeenCalledWith({
      requestId: 'per_after_reconnect',
      reply: 'once',
    });
  });

  it('fails OpenCode permission asks closed when the session permission service errors', async () => {
    const permissionError = new Error('permission surface unavailable');
    const { ctx, logs } = createContextFixture({
      onPermissionDecision: async () => {
        throw permissionError;
      },
    });
    const client = createClientFixture();
    const runtime = await createStartedRuntime({ ctx, client });

    await runtime.handleProviderEvent({
      payload: {
        type: 'permission.asked',
        properties: {
          sessionID: 'ses-1',
          id: 'per_fail_closed',
          permission: 'bash',
          patterns: ['pwd'],
        },
      },
    });

    expect(client.permissionReply).toHaveBeenCalledWith({
      requestId: 'per_fail_closed',
      reply: 'reject',
      message: expect.stringContaining('failed closed'),
    });
    expect(logs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        level: 'debug',
        message: expect.stringContaining('permission'),
        fields: expect.objectContaining({ error: permissionError }),
      }),
    ]));
  });

  it('replies to turnless OpenCode permission asks even if a Happier turn starts before the decision', async () => {
    let resolvePermissionDecision: ((value: { decision: 'approved' }) => void) | null = null;
    const pendingPermissionDecision = new Promise<{ decision: 'approved' }>((resolve) => {
      resolvePermissionDecision = resolve;
    });
    const { ctx, harness } = createContextFixture({
      onPermissionDecision: async () => await pendingPermissionDecision,
    });
    const client = createClientFixture();
    const runtime = await createStartedRuntime({ ctx, client, harness });

    const permissionAsk = runtime.handleProviderEvent({
      payload: {
        type: 'permission.asked',
        properties: {
          sessionID: 'ses-1',
          id: 'per_turnless',
          permission: 'bash',
          patterns: ['pwd'],
        },
      },
    });
    void permissionAsk.catch(() => undefined);
    await Promise.resolve();

    await runtime.sendTurnPrompt('hello');
    resolvePermissionDecision?.({ decision: 'approved' });
    await permissionAsk;

    expect(client.permissionReply).toHaveBeenCalledWith({
      requestId: 'per_turnless',
      reply: 'once',
    });
  });

  it('keeps turns open for live provider tool work until reconnect history supplies terminal evidence', async () => {
    const { ctx, harness, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    const runtime = await createStartedRuntime({ ctx, client, harness });
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

  it('publishes live OpenCode tool parts as canonical runtime tool events', async () => {
    const { ctx, harness, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    const runtime = await createStartedRuntime({ ctx, client, harness });
    runtime.beginTurnLifecycle();

    const turnStart = runtimeEvents.find((event) => event.kind === 'turn-start');
    const turnId = (turnStart as { turnId?: string } | undefined)?.turnId;
    expect(turnId).toBeTruthy();

    await runtime.handleProviderEvent({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-tool-1',
            type: 'tool',
            sessionID: 'ses-1',
            messageID: 'msg-tool-1',
            callID: 'call-tool-1',
            tool: 'bash',
            state: {
              status: 'running',
              input: { command: 'pwd' },
            },
          },
        },
      },
    });

    await runtime.handleProviderEvent({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-tool-1',
            type: 'tool',
            sessionID: 'ses-1',
            messageID: 'msg-tool-1',
            callID: 'call-tool-1',
            tool: 'bash',
            state: {
              status: 'completed',
              input: { command: 'pwd' },
              output: 'repo\n',
              title: 'repo/probe.txt',
              metadata: { preview: 'repo' },
            },
          },
        },
      },
    });

    expect(runtimeEvents).toContainEqual(expect.objectContaining({
      kind: 'tool-call',
      sessionId: 'happy-session-1',
      turnId,
      toolCallId: 'call-tool-1',
      toolName: 'bash',
      toolInput: { command: 'pwd' },
    }));
    expect(runtimeEvents).toContainEqual(expect.objectContaining({
      kind: 'tool-result',
      sessionId: 'happy-session-1',
      turnId,
      toolCallId: 'call-tool-1',
      output: {
        output: 'repo\n',
        title: 'repo/probe.txt',
        metadata: { preview: 'repo' },
      },
    }));
  });

  it('backfills current-turn OpenCode tool events from completed history before assistant commit', async () => {
    const { ctx, harness, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    vi.mocked(client.sessionPromptAsync).mockImplementationOnce(async () => {
      client.setMessages([
        {
          info: {
            id: 'msg-history-user',
            role: 'user',
            sessionID: 'ses-1',
            time: { created: Date.now() + 1 },
          },
          parts: [
            { id: 'part-history-user', type: 'text', text: 'run pwd' },
          ],
        },
        {
          info: {
            id: 'msg-history-assistant',
            role: 'assistant',
            sessionID: 'ses-1',
            time: { completed: Date.now() + 2 },
          },
          parts: [
            {
              id: 'part-history-tool',
              type: 'tool',
              sessionID: 'ses-1',
              messageID: 'msg-history-assistant',
              callID: 'call-history-tool',
              tool: 'bash',
              state: {
                status: 'completed',
                input: { command: 'pwd' },
                output: 'repo\n',
              },
            },
            { id: 'part-history-text', type: 'text', text: 'The repo path is /repo.' },
          ],
        },
      ]);
    });
    const runtime = await createStartedRuntime({ ctx, client, harness });

    await runtime.sendTurnPrompt('run pwd');
    await runtime.handleProviderEvent({
      payload: {
        type: 'session.idle',
        properties: { sessionID: 'ses-1' },
      },
    });

    const turnStart = runtimeEvents.find((event) => event.kind === 'turn-start');
    const turnId = (turnStart as { turnId?: string } | undefined)?.turnId;
    expect(turnId).toBeTruthy();

    const toolCallIndex = runtimeEvents.findIndex((event) => event.kind === 'tool-call');
    const toolResultIndex = runtimeEvents.findIndex((event) => event.kind === 'tool-result');
    const assistantCommitIndex = runtimeEvents.findIndex((event) => event.kind === 'transcript-agent-message-committed');
    const turnCompleteIndex = runtimeEvents.findIndex((event) => event.kind === 'turn-complete');

    expect(toolCallIndex).toBeGreaterThan(-1);
    expect(toolResultIndex).toBeGreaterThan(toolCallIndex);
    expect(assistantCommitIndex).toBeGreaterThan(toolResultIndex);
    expect(turnCompleteIndex).toBeGreaterThan(assistantCommitIndex);
    expect(runtimeEvents[toolCallIndex]).toEqual(expect.objectContaining({
      kind: 'tool-call',
      sessionId: 'happy-session-1',
      turnId,
      toolCallId: 'call-history-tool',
      toolName: 'bash',
      toolInput: { command: 'pwd' },
    }));
    expect(runtimeEvents[toolResultIndex]).toEqual(expect.objectContaining({
      kind: 'tool-result',
      sessionId: 'happy-session-1',
      turnId,
      toolCallId: 'call-history-tool',
      output: 'repo\n',
    }));
    expect(runtimeEvents[assistantCommitIndex]).toEqual(expect.objectContaining({
      kind: 'transcript-agent-message-committed',
      localId: 'opencode:ses-1:msg-history-assistant',
      body: {
        type: 'message',
        message: 'The repo path is /repo.',
      },
    }));
  });

  it('does not duplicate OpenCode tool events when history repeats live-published parts', async () => {
    const { ctx, harness, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    const runtime = await createStartedRuntime({ ctx, client, harness });
    runtime.beginTurnLifecycle();

    await runtime.handleProviderEvent({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-tool-live',
            type: 'tool',
            sessionID: 'ses-1',
            messageID: 'msg-live-tool-assistant',
            callID: 'call-live-tool',
            tool: 'bash',
            state: {
              status: 'running',
              input: { command: 'pwd' },
            },
          },
        },
      },
    });
    await runtime.handleProviderEvent({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-tool-live',
            type: 'tool',
            sessionID: 'ses-1',
            messageID: 'msg-live-tool-assistant',
            callID: 'call-live-tool',
            tool: 'bash',
            state: {
              status: 'completed',
              input: { command: 'pwd' },
              output: 'repo\n',
            },
          },
        },
      },
    });

    client.setMessages([
      {
        info: {
          id: 'msg-live-tool-assistant',
          role: 'assistant',
          sessionID: 'ses-1',
          time: { completed: Date.now() },
        },
        parts: [
          {
            id: 'part-tool-live',
            type: 'tool',
            sessionID: 'ses-1',
            messageID: 'msg-live-tool-assistant',
            callID: 'call-live-tool',
            tool: 'bash',
            state: {
              status: 'completed',
              input: { command: 'pwd' },
              output: 'repo\n',
            },
          },
          { id: 'part-live-text', type: 'text', text: 'The repo path is /repo.' },
        ],
      },
    ]);
    await runtime.handleProviderEvent({
      payload: {
        type: 'session.idle',
        properties: { sessionID: 'ses-1' },
      },
    });

    expect(runtimeEvents.filter((event) => event.kind === 'tool-call')).toHaveLength(1);
    expect(runtimeEvents.filter((event) => event.kind === 'tool-result')).toHaveLength(1);
    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'turn-complete' }),
    ]));
  });

  it('keeps polling turns open while refreshed OpenCode history still has running provider work', async () => {
    const { ctx, harness, runtimeEvents } = createContextFixture();
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
    const runtime = await createStartedRuntime({ ctx, client, harness });
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

  it('commits observed assistant transcript text from OpenCode history before completing the turn', async () => {
    const { ctx, harness, runtimeEvents, transcriptAppends } = createContextFixture();
    const client = createClientFixture();
    client.setMessages([
      {
        info: { id: 'msg-assistant-1', role: 'assistant', sessionID: 'ses-1' },
        parts: [
          { id: 'part-text-1', type: 'text', text: 'OPENCODE_LIVE_OK' },
        ],
      },
    ]);
    const runtime = await createStartedRuntime({ ctx, client, harness });
    runtime.beginTurnLifecycle();

    await runtime.handleProviderEvent({
      payload: {
        type: 'message.updated',
        properties: {
          info: { id: 'msg-assistant-1', role: 'assistant', sessionID: 'ses-1' },
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
      expect.objectContaining({
        kind: 'transcript-agent-message-committed',
        agentId: 'opencode',
        localId: 'opencode:ses-1:msg-assistant-1',
        body: {
          type: 'message',
          message: 'OPENCODE_LIVE_OK',
        },
      }),
      expect.objectContaining({ kind: 'turn-complete' }),
    ]));
    expect(transcriptAppends).toHaveLength(0);

    await runtime.handleProviderEvent({
      payload: {
        type: 'session.idle',
        properties: { sessionID: 'ses-1' },
      },
    });

    const committedAssistantEvents = runtimeEvents.filter((event) => (
      event.kind === 'transcript-agent-message-committed'
      && event.agentId === 'opencode'
      && event.body
      && typeof event.body === 'object'
      && !Array.isArray(event.body)
      && (event.body as Readonly<{ message?: unknown }>).message === 'OPENCODE_LIVE_OK'
    ));
    expect(committedAssistantEvents).toHaveLength(1);
  });

  it('commits assistant transcript text that follows the current provider user message in history', async () => {
    const { ctx, harness, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    vi.mocked(client.sessionPromptAsync).mockImplementationOnce(async () => {
      client.setMessages([
        {
          info: {
            id: 'msg-provider-generated-current-user',
            role: 'user',
            sessionID: 'ses-1',
            time: { created: Date.now() },
          },
          parts: [
            { id: 'part-user-1', type: 'text', text: 'hello' },
          ],
        },
        {
          info: { id: 'msg-assistant-after-user', role: 'assistant', sessionID: 'ses-1' },
          parts: [
            { id: 'part-text-1', type: 'text', text: 'Assistant after user id' },
          ],
        },
      ]);
    });
    const runtime = await createStartedRuntime({ ctx, client, harness });

    runtime.beginTurnLifecycle();
    await runtime.sendTurnPrompt('hello');
    await runtime.handleProviderEvent({
      payload: {
        type: 'session.idle',
        properties: { sessionID: 'ses-1' },
      },
    });

    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'transcript-agent-message-committed',
        agentId: 'opencode',
        localId: 'opencode:ses-1:msg-assistant-after-user',
        body: {
          type: 'message',
          message: 'Assistant after user id',
        },
      }),
      expect.objectContaining({ kind: 'turn-complete' }),
    ]));
    expect(runtimeEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'transcript-user-text' }),
    ]));
  });

  it('does not passively mirror provider user rows that came from a completed Happier turn', async () => {
    const { ctx, harness, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    vi.mocked(client.sessionPromptAsync).mockImplementationOnce(async () => {
      client.setMessages([
        {
          info: {
            id: 'msg-happier-provider-user',
            role: 'user',
            sessionID: 'ses-1',
            time: { created: Date.now() },
          },
          parts: [
            { id: 'part-user-1', type: 'text', text: 'internal system guidance\n\nUSER_MARKER' },
          ],
        },
        {
          info: {
            id: 'msg-happier-provider-assistant',
            role: 'assistant',
            sessionID: 'ses-1',
            finish: 'stop',
            time: { completed: Date.now() + 1 },
          },
          parts: [
            { id: 'part-assistant-1', type: 'text', text: 'USER_MARKER_OK' },
          ],
        },
      ]);
    });
    const runtime = await createStartedRuntime({ ctx, client, harness });

    runtime.beginTurnLifecycle();
    await runtime.sendTurnPrompt('internal system guidance\n\nUSER_MARKER');
    await runtime.handleProviderEvent({
      payload: {
        type: 'session.idle',
        properties: { sessionID: 'ses-1' },
      },
    });

    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'turn-complete' }),
    ]));

    await runtime.handleProviderEvent({
      payload: {
        type: 'session.idle',
        properties: { sessionID: 'ses-1' },
      },
    });

    expect(runtimeEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'transcript-user-text',
        text: expect.stringContaining('internal system guidance'),
      }),
    ]));
  });

  it('does not passively mirror completed Happier turn user rows when OpenCode reports nested created time in seconds', async () => {
    const { ctx, harness, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    vi.useFakeTimers();
    vi.setSystemTime(1_782_215_218_000);
    vi.mocked(client.sessionPromptAsync).mockImplementationOnce(async () => {
      client.setMessages([
        {
          info: {
            id: 'msg-happier-provider-user-seconds',
            role: 'user',
            sessionID: 'ses-1',
            time: { created: 1_782_215_218 },
          },
          parts: [
            { id: 'part-user-seconds', type: 'text', text: 'seconds timestamp guidance\n\nUSER_MARKER_SECONDS' },
          ],
        },
        {
          info: {
            id: 'msg-happier-provider-assistant-seconds',
            role: 'assistant',
            sessionID: 'ses-1',
            finish: 'stop',
            time: { completed: 1_782_215_219_000 },
          },
          parts: [
            { id: 'part-assistant-seconds', type: 'text', text: 'USER_MARKER_SECONDS_OK' },
          ],
        },
      ]);
    });
    const runtime = await createStartedRuntime({ ctx, client, harness });

    await runtime.sendTurnPrompt('seconds timestamp guidance\n\nUSER_MARKER_SECONDS');
    await runtime.waitForTurnCompletion();

    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'turn-complete' }),
    ]));

    await runtime.handleProviderEvent({
      payload: {
        type: 'session.idle',
        properties: { sessionID: 'ses-1' },
      },
    });

    expect(runtimeEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'transcript-user-text',
        text: expect.stringContaining('seconds timestamp guidance'),
      }),
    ]));
  });

  it('does not passively mirror completed Happier turn user rows after runtime recreation', async () => {
    const { ctx, harness, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    vi.mocked(client.sessionPromptAsync).mockImplementationOnce(async () => {
      client.setMessages([
        {
          info: {
            id: 'msg-happier-provider-user-before-restart',
            role: 'user',
            sessionID: 'ses-1',
            time: { created: Date.now() },
          },
          parts: [
            { id: 'part-user-1', type: 'text', text: 'internal restart guidance\n\nUSER_MARKER' },
          ],
        },
        {
          info: {
            id: 'msg-happier-provider-assistant-before-restart',
            role: 'assistant',
            sessionID: 'ses-1',
            finish: 'stop',
            time: { completed: Date.now() + 1 },
          },
          parts: [
            { id: 'part-assistant-1', type: 'text', text: 'USER_MARKER_RESTART_OK' },
          ],
        },
      ]);
    });
    const runtime = await createStartedRuntime({ ctx, client, harness });

    await runtime.sendTurnPrompt('internal restart guidance\n\nUSER_MARKER');
    await runtime.handleProviderEvent({
      payload: {
        type: 'session.idle',
        properties: { sessionID: 'ses-1' },
      },
    });
    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'turn-complete' }),
    ]));

    await runtime.resetOrDisposeRuntime();
    const restartedRuntime = await createStartedRuntime({ ctx, client, harness });
    await restartedRuntime.handleProviderEvent({
      payload: {
        type: 'session.idle',
        properties: { sessionID: 'ses-1' },
      },
    });

    expect(runtimeEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'transcript-user-text',
        text: expect.stringContaining('internal restart guidance'),
      }),
    ]));
  });

  it('does not passively mirror provider user rows after an accepted Happier turn fails before history finality', async () => {
    const { ctx, harness, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    vi.mocked(client.sessionPromptAsync).mockImplementationOnce(async () => {
      client.setMessages([
        {
          info: {
            id: 'msg-happier-provider-user-before-error',
            role: 'user',
            sessionID: 'ses-1',
            time: { created: Date.now() },
          },
          parts: [
            { id: 'part-user-1', type: 'text', text: 'internal error-path guidance\n\nUSER_MARKER' },
          ],
        },
      ]);
    });
    const runtime = await createStartedRuntime({ ctx, client, harness });

    runtime.beginTurnLifecycle();
    await runtime.sendTurnPrompt('internal error-path guidance\n\nUSER_MARKER');
    await runtime.handleProviderEvent({
      payload: {
        type: 'session.error',
        properties: {
          sessionID: 'ses-1',
          error: { message: 'provider failed after accepting prompt' },
        },
      },
    });

    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'turn-failed' }),
    ]));

    await runtime.handleProviderEvent({
      payload: {
        type: 'session.idle',
        properties: { sessionID: 'ses-1' },
      },
    });

    expect(runtimeEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'transcript-user-text',
        text: expect.stringContaining('internal error-path guidance'),
      }),
    ]));
  });

  it('does not passively mirror provider user rows after prompt submission rejects with provider history', async () => {
    const { ctx, harness, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    vi.mocked(client.sessionPromptAsync).mockImplementationOnce(async () => {
      client.setMessages([
        {
          info: {
            id: 'msg-happier-provider-user-before-submit-reject',
            role: 'user',
            sessionID: 'ses-1',
            time: { created: Date.now() },
          },
          parts: [
            { id: 'part-user-1', type: 'text', text: 'internal submit-reject guidance\n\nUSER_MARKER' },
          ],
        },
      ]);
      throw new Error('provider rejected after writing the user row');
    });
    const runtime = await createStartedRuntime({ ctx, client, harness });

    await runtime.sendTurnPrompt('internal submit-reject guidance\n\nUSER_MARKER');
    await vi.waitFor(() => {
      expect(runtimeEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'turn-failed' }),
      ]));
    });

    await runtime.handleProviderEvent({
      payload: {
        type: 'session.idle',
        properties: { sessionID: 'ses-1' },
      },
    });

    expect(runtimeEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'transcript-user-text',
        text: expect.stringContaining('internal submit-reject guidance'),
      }),
    ]));
  });

  it('commits assistant transcript text after OpenCode rewrites the provider user message id', async () => {
    const { ctx, harness, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    vi.mocked(client.sessionPromptAsync).mockImplementationOnce(async () => {
      client.setMessages([
        {
          info: {
            id: 'msg-provider-generated-user',
            role: 'user',
            sessionID: 'ses-1',
            time: { created: Date.now() },
          },
          parts: [
            { id: 'part-user-1', type: 'text', text: '[opencode prompt stack]\nhello' },
          ],
        },
        {
          info: { id: 'msg-assistant-after-generated-user', role: 'assistant', sessionID: 'ses-1' },
          parts: [
            { id: 'part-text-1', type: 'text', text: 'Assistant after generated user id' },
          ],
        },
      ]);
    });
    const runtime = await createStartedRuntime({ ctx, client, harness });

    await runtime.sendTurnPrompt('hello');
    await runtime.waitForTurnCompletion();

    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'transcript-agent-message-committed',
        agentId: 'opencode',
        localId: 'opencode:ses-1:msg-assistant-after-generated-user',
        body: {
          type: 'message',
          message: 'Assistant after generated user id',
        },
      }),
      expect.objectContaining({ kind: 'turn-complete' }),
    ]));
  });

  it('completes a user turn from terminal assistant history while OpenCode status is unknown', async () => {
    const { ctx, harness, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    vi.mocked(client.sessionStatus).mockResolvedValue({});
    vi.mocked(client.sessionPromptAsync).mockImplementationOnce(async () => {
      client.setMessages([
        {
          info: {
            id: 'msg-provider-generated-user',
            role: 'user',
            sessionID: 'ses-1',
            time: { created: Date.now() },
          },
          parts: [
            { id: 'part-user-1', type: 'text', text: '[opencode prompt stack]\nhello' },
          ],
        },
        {
          info: {
            id: 'msg-assistant-before-idle',
            role: 'assistant',
            sessionID: 'ses-1',
            time: { created: 100, completed: 200 },
            finish: 'stop',
          },
          parts: [
            { id: 'part-text-1', type: 'text', text: 'Assistant before explicit idle' },
          ],
        },
      ]);
    });
    const runtime = await createStartedRuntime({ ctx, client, harness });

    await runtime.sendTurnPrompt('hello');
    await runtime.waitForTurnCompletion();

    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'transcript-agent-message-committed',
        agentId: 'opencode',
        localId: 'opencode:ses-1:msg-assistant-before-idle',
        body: {
          type: 'message',
          message: 'Assistant before explicit idle',
        },
      }),
      expect.objectContaining({ kind: 'turn-complete' }),
    ]));
    expect(runtimeEvents.some((event) => event.kind === 'turn-failed')).toBe(false);
  });

  it('keeps the turn open when OpenCode reports idle before producing assistant history', async () => {
    const { ctx, harness, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    vi.mocked(client.sessionPromptAsync).mockImplementationOnce(async () => {
      client.setMessages([
        {
          info: {
            id: 'msg-provider-generated-user',
            role: 'user',
            sessionID: 'ses-1',
            time: { created: Date.now() },
            model: {
              providerID: 'opencode',
              modelID: 'big-pickle',
            },
          },
          parts: [
            {
              id: 'part-user-1',
              type: 'text',
              text: '[analyze-mode]\nhello',
            },
          ],
        },
      ]);
    });
    const runtime = await createStartedRuntime({ ctx, client, harness });

    await runtime.sendTurnPrompt('hello');
    await runtime.waitForTurnCompletion();

    expect(runtimeEvents.some((event) => event.kind === 'turn-failed')).toBe(false);
    expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(false);

    client.setMessages([
      {
        info: {
          id: 'msg-provider-generated-user',
          role: 'user',
          sessionID: 'ses-1',
          time: { created: Date.now() },
        },
        parts: [
          { id: 'part-user-1', type: 'text', text: '[analyze-mode]\nhello' },
        ],
      },
      {
        info: {
          id: 'msg-assistant-after-delayed-idle',
          role: 'assistant',
          sessionID: 'ses-1',
          modelID: 'big-pickle',
          providerID: 'opencode',
          time: { created: 100, completed: 200 },
          finish: 'stop',
        },
        parts: [
          { id: 'part-step-1', type: 'step-start' },
          { id: 'part-reasoning-1', type: 'reasoning', text: 'internal thinking' },
          { id: 'part-text-1', type: 'text', text: 'Assistant after delayed idle' },
        ],
      },
    ]);
    await runtime.waitForTurnCompletion();

    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'transcript-agent-message-committed',
        agentId: 'opencode',
        localId: 'opencode:ses-1:msg-assistant-after-delayed-idle',
        body: {
          type: 'message',
          message: 'Assistant after delayed idle',
        },
      }),
      expect.objectContaining({ kind: 'turn-complete' }),
    ]));
    expect(runtimeEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'turn-failed' }),
    ]));
  });

  it('fails accepted prompts when idle history never produces assistant evidence', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { ctx, harness, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    vi.mocked(client.sessionPromptAsync).mockImplementationOnce(async () => {
      client.setMessages([
        {
          info: {
            id: 'msg-provider-generated-user',
            role: 'user',
            sessionID: 'ses-1',
            time: { created: Date.now() },
            model: {
              providerID: 'opencode',
              modelID: 'big-pickle',
            },
          },
          parts: [
            {
              id: 'part-user-1',
              type: 'text',
              text: '[analyze-mode]\nhello',
            },
          ],
        },
      ]);
    });
    const runtime = await createStartedRuntime({ ctx, client, harness });

    await runtime.sendTurnPrompt('hello');
    await runtime.waitForTurnCompletion();

    expect(runtimeEvents.some((event) => event.kind === 'turn-failed')).toBe(false);
    expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(false);

    vi.setSystemTime(61_001);
    await runtime.waitForTurnCompletion();

    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'turn-failed',
        issue: expect.objectContaining({
          agentId: 'opencode',
          code: 'opencode_empty_provider_response',
          source: 'agent_session_error',
          sanitizedPreview: expect.stringContaining('did not publish assistant'),
        }),
      }),
      expect.objectContaining({
        kind: 'transcript-agent-message-committed',
        agentId: 'opencode',
        body: expect.objectContaining({
          type: 'turn_failed',
        }),
      }),
    ]));
    expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(false);
    expect(client.sessionMessages).toHaveBeenCalledTimes(2);
  });

  it('keeps accepted prompts open when OpenCode remains busy without assistant, tool, or error evidence', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const permissionRequests: unknown[] = [];
    const { ctx, harness, runtimeEvents } = createContextFixture({
      onPermissionDecision: async (request) => {
        permissionRequests.push(request);
        return { decision: 'approved' };
      },
    });
    const client = createClientFixture();
    vi.mocked(client.sessionStatus).mockResolvedValue({ type: 'busy' });
    vi.mocked(client.sessionPromptAsync).mockImplementationOnce(async () => {
      client.setMessages([
        {
          info: {
            id: 'msg-provider-generated-user',
            role: 'user',
            sessionID: 'ses-1',
            time: { created: Date.now() },
            model: {
              providerID: 'opencode',
              modelID: 'big-pickle',
            },
          },
          parts: [
            {
              id: 'part-user-1',
              type: 'text',
              text: '[analyze-mode]\nhello',
            },
          ],
        },
      ]);
    });
    const runtime = await createStartedRuntime({ ctx, client, harness });

    await runtime.sendTurnPrompt('hello');
    await runtime.waitForTurnCompletion();

    expect(runtimeEvents.some((event) => event.kind === 'turn-failed')).toBe(false);
    expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(false);
    expect(client.sessionMessages).not.toHaveBeenCalled();

    vi.setSystemTime(61_001);
    await runtime.waitForTurnCompletion();

    expect(runtimeEvents.some((event) => event.kind === 'turn-failed')).toBe(false);
    expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(false);
    expect(client.sessionMessages).not.toHaveBeenCalled();

    await runtime.handleProviderEvent({
      payload: {
        type: 'permission.asked',
        properties: {
          sessionID: 'ses-1',
          id: 'per_late_busy',
          permission: 'bash',
          patterns: ['ls /tmp/happier-opencode-late-permission/'],
        },
      },
    });

    expect(permissionRequests).toEqual([
      expect.objectContaining({
        provider: 'opencode',
        requestId: 'per_late_busy',
        toolName: 'bash',
      }),
    ]);
    expect(client.permissionReply).toHaveBeenCalledWith({
      requestId: 'per_late_busy',
      reply: 'once',
    });
    expect(runtimeEvents.some((event) => event.kind === 'turn-failed')).toBe(false);
    expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(false);
  });

  it('keeps the turn open while an OpenCode permission request waits for a decision', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const permissionRequests: unknown[] = [];
    let resolvePermissionDecision: ((value: { decision: 'approved' }) => void) | null = null;
    const pendingPermissionDecision = new Promise<{ decision: 'approved' }>((resolve) => {
      resolvePermissionDecision = resolve;
    });
    const { ctx, harness, runtimeEvents } = createContextFixture({
      onPermissionDecision: async (request) => {
        permissionRequests.push(request);
        return await pendingPermissionDecision;
      },
    });
    const client = createClientFixture();
    vi.mocked(client.sessionPromptAsync).mockImplementationOnce(async () => {
      client.setMessages([
        {
          info: {
            id: 'msg-provider-generated-user',
            role: 'user',
            sessionID: 'ses-1',
            time: { created: Date.now() },
            model: {
              providerID: 'opencode',
              modelID: 'big-pickle',
            },
          },
          parts: [
            {
              id: 'part-user-1',
              type: 'text',
              text: '[analyze-mode]\nhello',
            },
          ],
        },
      ]);
    });
    const runtime = await createStartedRuntime({ ctx, client, harness });

    await runtime.sendTurnPrompt('hello');

    const permissionAsk = runtime.handleProviderEvent({
      payload: {
        type: 'permission.asked',
        properties: {
          sessionID: 'ses-1',
          id: 'per_waiting',
          permission: 'bash',
          patterns: ['pwd'],
        },
      },
    });
    void permissionAsk.catch(() => undefined);
    await Promise.resolve();

    expect(permissionRequests).toEqual([
      expect.objectContaining({
        provider: 'opencode',
        requestId: 'per_waiting',
        toolName: 'bash',
      }),
    ]);

    vi.setSystemTime(61_001);
    await runtime.waitForTurnCompletion();

    expect(runtimeEvents.some((event) => event.kind === 'turn-failed')).toBe(false);
    expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(false);
    expect(client.permissionReply).not.toHaveBeenCalled();

    resolvePermissionDecision?.({ decision: 'approved' });
    await permissionAsk;
  });

  it('cancels pending turn-scoped OpenCode permission decisions when provider errors fail the turn', async () => {
    type PermissionDecision = Awaited<
      ReturnType<PluginContextV1['sessions']['current']['permissions']['requestDecision']>
    >;
    const { ctx, harness, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    let capturedSignal: AbortSignal | null = null;
    let resolvePermissionDecision: ((value: PermissionDecision) => void) | null = null;
    let rejectPermissionDecision: ((reason: unknown) => void) | null = null;
    let permissionSettled = false;
    const pendingPermissionDecision = new Promise<PermissionDecision>((resolve, reject) => {
      resolvePermissionDecision = resolve;
      rejectPermissionDecision = reject;
    }).finally(() => {
      permissionSettled = true;
    });
    const ctxWithPermissionSignal: PluginContextV1 = {
      ...ctx,
      sessions: {
        ...ctx.sessions,
        current: {
          ...ctx.sessions.current,
          permissions: {
            ...ctx.sessions.current.permissions,
            requestDecision: vi.fn((_request, options) => {
              capturedSignal = options?.signal ?? null;
              if (capturedSignal) {
                capturedSignal.addEventListener('abort', () => {
                  rejectPermissionDecision?.(
                    capturedSignal?.reason ?? new Error('permission aborted'),
                  );
                }, { once: true });
              }
              return pendingPermissionDecision;
            }),
          },
        },
      },
    };
    const runtime = await createStartedRuntime({ ctx: ctxWithPermissionSignal, client, harness });

    await runtime.sendTurnPrompt('hello');
    const permissionAsk = runtime.handleProviderEvent({
      payload: {
        type: 'permission.asked',
        properties: {
          sessionID: 'ses-1',
          id: 'per_provider_error_abort',
          permission: 'bash',
          patterns: ['pwd'],
        },
      },
    });
    void permissionAsk.catch(() => undefined);
    await Promise.resolve();

    try {
      expect(capturedSignal).toBeInstanceOf(AbortSignal);

      await runtime.handleProviderEvent({
        payload: {
          type: 'session.error',
          properties: {
            sessionID: 'ses-1',
            error: { message: 'provider failed while permission was pending' },
          },
        },
      });

      expect(capturedSignal?.aborted).toBe(true);
      await permissionAsk;
      expect(client.permissionReply).not.toHaveBeenCalled();
      expect(runtimeEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'turn-failed' }),
      ]));
      expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(false);
    } finally {
      if (!permissionSettled) {
        resolvePermissionDecision?.({ decision: 'denied' });
        await permissionAsk.catch(() => undefined);
      }
    }
  });

  it('reports user-denied OpenCode permissions as permission failures instead of empty provider responses', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { ctx, harness, runtimeEvents } = createContextFixture({
      onPermissionDecision: async () => ({ decision: 'denied', rationale: 'QA denied shell access' }),
    });
    const client = createClientFixture();
    vi.mocked(client.sessionPromptAsync).mockResolvedValueOnce(undefined);
    const runtime = await createStartedRuntime({ ctx, client, harness });

    await runtime.sendTurnPrompt('hello');
    await runtime.handleProviderEvent({
      payload: {
        type: 'permission.asked',
        properties: {
          sessionID: 'ses-1',
          id: 'per_denied',
          permission: 'bash',
          patterns: ['pwd'],
        },
      },
    });

    client.setMessages([
      {
        info: {
          id: 'msg-provider-generated-user',
          role: 'user',
          sessionID: 'ses-1',
          time: { created: 1_000 },
        },
        parts: [
          { id: 'part-user-1', type: 'text', text: '[opencode prompt stack]\nhello' },
        ],
      },
      {
        info: {
          id: 'msg-denied-assistant',
          role: 'assistant',
          sessionID: 'ses-1',
          time: { created: 1_010, completed: 1_020 },
        },
        parts: [
          {
            id: 'part-denied-tool',
            type: 'tool',
            sessionID: 'ses-1',
            messageID: 'msg-denied-assistant',
            callID: 'call-denied-tool',
            tool: 'bash',
            state: {
              status: 'error',
              input: { command: 'pwd' },
              output: 'Permission denied by user',
            },
          },
        ],
      },
    ]);

    await runtime.waitForTurnCompletion();

    expect(client.permissionReply).toHaveBeenCalledWith({
      requestId: 'per_denied',
      reply: 'reject',
      message: 'QA denied shell access',
    });
    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'tool-result',
        toolCallId: 'call-denied-tool',
        isError: true,
      }),
      expect.objectContaining({
        kind: 'turn-failed',
        issue: expect.objectContaining({
          agentId: 'opencode',
          code: 'opencode_permission_denied',
          source: 'permission_blocked',
          sanitizedPreview: expect.stringContaining('permission'),
        }),
      }),
    ]));
    expect(runtimeEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'turn-failed',
        issue: expect.objectContaining({
          code: 'opencode_empty_provider_response',
        }),
      }),
    ]));
    expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(false);
  });

  it('reports user-denied OpenCode permissions as permission failures when no assistant history is recorded', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { ctx, harness, runtimeEvents } = createContextFixture({
      onPermissionDecision: async () => ({ decision: 'denied', rationale: 'QA denied shell access' }),
    });
    const client = createClientFixture();
    vi.mocked(client.sessionPromptAsync).mockResolvedValueOnce(undefined);
    const runtime = await createStartedRuntime({ ctx, client, harness });

    await runtime.sendTurnPrompt('hello');
    await runtime.handleProviderEvent({
      payload: {
        type: 'permission.asked',
        properties: {
          sessionID: 'ses-1',
          id: 'per_denied_no_history',
          permission: 'bash',
          patterns: ['pwd'],
        },
      },
    });

    client.setMessages([
      {
        info: {
          id: 'msg-provider-generated-user',
          role: 'user',
          sessionID: 'ses-1',
          time: { created: 1_000 },
        },
        parts: [
          { id: 'part-user-1', type: 'text', text: '[opencode prompt stack]\nhello' },
        ],
      },
    ]);

    vi.setSystemTime(61_001);
    await runtime.waitForTurnCompletion();

    expect(client.permissionReply).toHaveBeenCalledWith({
      requestId: 'per_denied_no_history',
      reply: 'reject',
      message: 'QA denied shell access',
    });
    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'turn-failed',
        issue: expect.objectContaining({
          agentId: 'opencode',
          code: 'opencode_permission_denied',
          source: 'permission_blocked',
          sanitizedPreview: expect.stringContaining('permission'),
        }),
      }),
    ]));
    expect(runtimeEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'turn-failed',
        issue: expect.objectContaining({
          code: 'opencode_empty_provider_response',
        }),
      }),
    ]));
    expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(false);
  });

  it('keeps the turn open after a delayed permission reply resets the idle assistant grace', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    let resolvePermissionDecision: ((value: { decision: 'approved' }) => void) | null = null;
    let permissionResolved = false;
    const pendingPermissionDecision = new Promise<{ decision: 'approved' }>((resolve) => {
      resolvePermissionDecision = (value) => {
        permissionResolved = true;
        resolve(value);
      };
    });
    const { ctx, harness, runtimeEvents } = createContextFixture({
      onPermissionDecision: async () => await pendingPermissionDecision,
    });
    const client = createClientFixture();
    vi.mocked(client.sessionPromptAsync).mockImplementationOnce(async () => {
      client.setMessages([
        {
          info: {
            id: 'msg-provider-generated-user',
            role: 'user',
            sessionID: 'ses-1',
            time: { created: Date.now() },
            model: {
              providerID: 'opencode',
              modelID: 'big-pickle',
            },
          },
          parts: [
            {
              id: 'part-user-1',
              type: 'text',
              text: '[analyze-mode]\nhello',
            },
          ],
        },
      ]);
    });
    const runtime = await createStartedRuntime({ ctx, client, harness });

    await runtime.sendTurnPrompt('hello');
    const permissionAsk = runtime.handleProviderEvent({
      payload: {
        type: 'permission.asked',
        properties: {
          sessionID: 'ses-1',
          id: 'per_delayed',
          permission: 'bash',
          patterns: ['pwd'],
        },
      },
    });
    void permissionAsk.catch(() => undefined);
    await Promise.resolve();

    try {
      vi.setSystemTime(61_001);
      resolvePermissionDecision?.({ decision: 'approved' });
      await permissionAsk;
      expect(client.permissionReply).toHaveBeenCalledWith({
        requestId: 'per_delayed',
        reply: 'once',
      });

      await runtime.waitForTurnCompletion();

      expect(runtimeEvents.some((event) => event.kind === 'turn-failed')).toBe(false);
      expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(false);
    } finally {
      if (!permissionResolved) {
        resolvePermissionDecision?.({ decision: 'approved' });
        await permissionAsk;
      }
    }
  });

  it('starts a fresh turn lifecycle for follow-up prompts after completing a previous turn', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { ctx, harness, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    vi.mocked(client.sessionPromptAsync).mockImplementation(async (input) => {
      if (input.text === 'first') {
        client.setMessages([
          {
            info: { id: 'msg-user-first', role: 'user', sessionID: 'ses-1', time: { created: Date.now() } },
            parts: [
              { id: 'part-user-first', type: 'text', text: '[opencode prompt stack]\nfirst' },
            ],
          },
          {
            info: {
              id: 'msg-assistant-first',
              role: 'assistant',
              sessionID: 'ses-1',
              time: { created: 100, completed: 200 },
            },
            parts: [
              { id: 'part-text-first', type: 'text', text: 'first done' },
            ],
          },
        ]);
        return;
      }
      client.setMessages([
        {
          info: { id: 'msg-user-second', role: 'user', sessionID: 'ses-1', time: { created: Date.now() } },
          parts: [
            { id: 'part-user-second', type: 'text', text: '[opencode prompt stack]\nsecond' },
          ],
        },
      ]);
    });
    const runtime = await createStartedRuntime({ ctx, client, harness });

    await runtime.sendTurnPrompt('first');
    await runtime.waitForTurnCompletion();
    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'turn-complete' }),
      expect.objectContaining({
        kind: 'transcript-agent-message-committed',
        agentId: 'opencode',
        localId: 'opencode:ses-1:msg-assistant-first',
      }),
    ]));

    vi.setSystemTime(2_000);
    await runtime.sendTurnPrompt('second');

    expect(runtimeEvents.filter((event) => event.kind === 'turn-start')).toHaveLength(2);

    vi.setSystemTime(63_000);
    await runtime.waitForTurnCompletion();

    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'turn-failed',
        issue: expect.objectContaining({
          agentId: 'opencode',
          code: 'opencode_empty_provider_response',
        }),
      }),
      expect.objectContaining({
        kind: 'transcript-agent-message-committed',
        agentId: 'opencode',
        body: expect.objectContaining({
          type: 'turn_failed',
        }),
      }),
    ]));
  });

  it('fails active user turns when OpenCode completes with an empty assistant message', async () => {
    const { ctx, harness, runtimeEvents, transcriptAppends } = createContextFixture();
    const client = createClientFixture();
    vi.mocked(client.sessionPromptAsync).mockImplementationOnce(async (input) => {
      client.setMessages([
        {
          info: {
            id: 'msg-provider-generated-user',
            role: 'user',
            sessionID: 'ses-1',
            time: { created: Date.now() },
          },
          parts: [
            { id: 'part-user-1', type: 'text', text: '[opencode prompt stack]\nhello' },
          ],
        },
        {
          info: {
            id: 'msg-empty-assistant',
            role: 'assistant',
            sessionID: 'ses-1',
            time: { created: 100, completed: 200 },
          },
          parts: [],
        },
      ]);
    });
    const runtime = await createStartedRuntime({ ctx, client, harness });

    await runtime.sendTurnPrompt('hello');
    await runtime.waitForTurnCompletion();

    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'turn-failed',
        issue: expect.objectContaining({
          agentId: 'opencode',
          code: 'opencode_empty_provider_response',
          source: 'agent_session_error',
        }),
      }),
      expect.objectContaining({
        kind: 'transcript-agent-message-committed',
        agentId: 'opencode',
        body: expect.objectContaining({
          type: 'turn_failed',
        }),
      }),
    ]));
    expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(false);
    expect(transcriptAppends).toHaveLength(0);
    expect(client.sessionMessages).toHaveBeenCalledTimes(1);
  });

  it('backs off full history refreshes while waiting for idle assistant history', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { ctx, harness } = createContextFixture();
    const client = createClientFixture();
    const operations = await createStartedRuntime({ ctx, client, harness });
    const runtime = createOpenCodePublicSessionRuntime(operations);

    await runtime.send({ v: 1, text: 'hello' });
    await flushMicrotasks();

    for (let i = 0; i < 20; i += 1) {
      await vi.advanceTimersByTimeAsync(250);
      await flushMicrotasks();
    }

    expect(client.sessionStatus).toHaveBeenCalledTimes(21);
    expect(client.sessionMessages.mock.calls.length).toBeLessThanOrEqual(6);
    expect(runtime.isTurnInFlight()).toBe(true);
  });

  it('fails active user turns with the provider error recorded on the terminal assistant history message', async () => {
    const { ctx, harness, runtimeEvents, transcriptAppends } = createContextFixture();
    const client = createClientFixture();
    vi.mocked(client.sessionPromptAsync).mockImplementationOnce(async () => {
      client.setMessages([
        {
          info: {
            id: 'msg-provider-generated-user',
            role: 'user',
            sessionID: 'ses-1',
            time: { created: Date.now() },
          },
          parts: [
            { id: 'part-user-1', type: 'text', text: '[opencode prompt stack]\nhello' },
          ],
        },
        {
          info: {
            id: 'msg-error-assistant',
            parentID: 'msg-provider-generated-user',
            role: 'assistant',
            sessionID: 'ses-1',
            time: { created: 100, completed: 200 },
            error: {
              name: 'UnknownError',
              data: {
                message: 'Token refresh failed: 401 Authorization: Bearer sk-live-secret',
              },
            },
          },
          parts: [],
        },
      ]);
    });
    const runtime = await createStartedRuntime({ ctx, client, harness });

    await runtime.sendTurnPrompt('hello');
    await runtime.waitForTurnCompletion();

    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'turn-failed',
        issue: expect.objectContaining({
          agentId: 'opencode',
          code: 'opencode_provider_session_error',
          source: 'auth_error',
          sanitizedPreview: expect.stringContaining('Token refresh failed: 401'),
        }),
      }),
      expect.objectContaining({
        kind: 'transcript-agent-message-committed',
        agentId: 'opencode',
        body: expect.objectContaining({
          type: 'turn_failed',
        }),
      }),
    ]));
    expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(false);
    expect(JSON.stringify(runtimeEvents)).not.toContain('sk-live-secret');
    expect(transcriptAppends).toHaveLength(0);
    expect(client.sessionMessages).toHaveBeenCalledTimes(1);
  });

  it('fails and confirms provider acceptance from an immediate assistant error prompt response', async () => {
    const { ctx, harness, runtimeEvents, transcriptAppends } = createContextFixture();
    const client = createClientFixture();
    const immediateAssistantError = {
      info: {
        id: 'msg-immediate-error',
        role: 'assistant',
        sessionID: 'ses-1',
        time: { created: Date.now() },
        error: {
          name: 'ProviderAuthError',
          data: {
            message: 'Token refresh failed: 401 Authorization: Bearer sk-live-secret',
          },
        },
      },
      parts: [],
    };
    vi.mocked(client.sessionPromptAsync).mockResolvedValueOnce(immediateAssistantError);
    const operations = await createStartedRuntime({ ctx, client, harness });
    const runtime = createOpenCodePublicSessionRuntime(operations);
    const accepted: Array<Readonly<{
      userMessageSeq: number | null;
      userMessageSeqs?: readonly number[];
    }>> = [];
    runtime.setOnPromptAcceptedByProvider?.((info) => {
      accepted.push(info);
    });

    await expect(runtime.send(
      { v: 1, text: 'hello' },
      { userMessageSeq: 58 },
    )).resolves.toMatchObject({ status: 'accepted' });

    await vi.waitFor(() => {
      expect(runtimeEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'turn-failed',
          issue: expect.objectContaining({
            agentId: 'opencode',
            code: 'opencode_provider_session_error',
            source: 'auth_error',
            sanitizedPreview: expect.stringContaining('Token refresh failed: 401'),
          }),
        }),
      ]));
    });

    expect(accepted).toEqual([{ userMessageSeq: 58, userMessageSeqs: [58] }]);
    expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(false);
    expect(JSON.stringify(runtimeEvents)).not.toContain('sk-live-secret');
    expect(transcriptAppends).toHaveLength(0);
    await runtime.dispose?.();
  });

  it('does not attribute stale assistant errors from an older identical prompt to the active turn', async () => {
    const { ctx, harness, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    vi.mocked(client.sessionPromptAsync).mockImplementationOnce(async () => {
      client.setMessages([
        {
          info: { id: 'msg-older-user', role: 'user', sessionID: 'ses-1' },
          parts: [
            { id: 'part-older-user', type: 'text', text: '[opencode prompt stack]\nrepeat me' },
          ],
        },
        {
          info: {
            id: 'msg-older-error-assistant',
            role: 'assistant',
            sessionID: 'ses-1',
            time: { created: 100, completed: 200 },
            error: {
              name: 'StaleProviderError',
              data: {
                message: 'stale provider error from earlier repeated prompt',
              },
            },
          },
          parts: [],
        },
        {
          info: { id: 'msg-current-rewritten-user', role: 'user', sessionID: 'ses-1' },
          parts: [
            { id: 'part-current-user', type: 'text', text: '[opencode prompt stack]\nrepeat me' },
          ],
        },
      ]);
    });
    const runtime = await createStartedRuntime({ ctx, client, harness });

    await runtime.sendTurnPrompt('repeat me');
    await runtime.waitForTurnCompletion();

    expect(runtimeEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'turn-failed' }),
      expect.objectContaining({ kind: 'turn-complete' }),
    ]));
    expect(JSON.stringify(runtimeEvents)).not.toContain('stale provider error from earlier repeated prompt');
    expect(client.sessionMessages).toHaveBeenCalledTimes(1);
  });

  it('does not complete from an older identical prompt when current provider user history is missing', async () => {
    const { ctx, harness, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    vi.mocked(client.sessionStatus).mockResolvedValue({});
    vi.mocked(client.sessionPromptAsync).mockImplementationOnce(async () => {
      client.setMessages([
        {
          info: { id: 'msg-older-user', role: 'user', sessionID: 'ses-1' },
          parts: [
            { id: 'part-older-user', type: 'text', text: '[opencode prompt stack]\nrepeat me' },
          ],
        },
        {
          info: {
            id: 'msg-older-assistant',
            role: 'assistant',
            sessionID: 'ses-1',
            time: { created: 100, completed: 200 },
            finish: 'stop',
          },
          parts: [
            { id: 'part-older-text', type: 'text', text: 'stale assistant from earlier repeated prompt' },
          ],
        },
      ]);
    });
    const runtime = await createStartedRuntime({ ctx, client, harness });

    await runtime.sendTurnPrompt('repeat me');
    await runtime.waitForTurnCompletion();

    expect(runtimeEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'transcript-agent-message-committed',
        localId: 'opencode:ses-1:msg-older-assistant',
      }),
      expect.objectContaining({ kind: 'turn-complete' }),
    ]));
    expect(JSON.stringify(runtimeEvents)).not.toContain('stale assistant from earlier repeated prompt');
    expect(client.sessionMessages).toHaveBeenCalledTimes(1);
  });

  it('fails active user turns when OpenCode completes provider tool work without assistant text', async () => {
    const { ctx, harness, runtimeEvents, transcriptAppends } = createContextFixture();
    const client = createClientFixture();
    vi.mocked(client.sessionPromptAsync).mockImplementationOnce(async () => {
      client.setMessages([
        {
          info: {
            id: 'msg-provider-generated-user',
            role: 'user',
            sessionID: 'ses-1',
            time: { created: Date.now() },
          },
          parts: [
            { id: 'part-user-1', type: 'text', text: '[opencode prompt stack]\nhello' },
          ],
        },
        {
          info: {
            id: 'msg-tool-only-assistant',
            role: 'assistant',
            sessionID: 'ses-1',
            time: { created: 100, completed: 200 },
          },
          parts: [
            {
              id: 'part-file-read',
              type: 'tool',
              sessionID: 'ses-1',
              messageID: 'msg-tool-only-assistant',
              callID: 'call-file-read',
              tool: 'file',
              state: {
                status: 'completed',
                input: { path: 'README.md' },
                output: 'read file contents',
              },
            },
          ],
        },
      ]);
    });
    const runtime = await createStartedRuntime({ ctx, client, harness });

    await runtime.sendTurnPrompt('hello');
    await runtime.waitForTurnCompletion();

    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'turn-failed',
        issue: expect.objectContaining({
          agentId: 'opencode',
          code: 'opencode_empty_provider_response',
          source: 'agent_session_error',
        }),
      }),
      expect.objectContaining({
        kind: 'transcript-agent-message-committed',
        agentId: 'opencode',
        body: expect.objectContaining({
          type: 'turn_failed',
        }),
      }),
    ]));
    expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(false);
    expect(transcriptAppends).toHaveLength(0);
  });

  it('keeps active turns open when the status poll fails transiently', async () => {
    const { ctx, harness, runtimeEvents, logs } = createContextFixture();
    const client = createClientFixture();
    const pollError = new Error('status endpoint unavailable');
    vi.mocked(client.sessionStatus)
      .mockRejectedValueOnce(pollError)
      .mockResolvedValueOnce({ type: 'idle' });
    const runtime = await createStartedRuntime({ ctx, client, harness });
    runtime.beginTurnLifecycle();

    await expect(runtime.waitForTurnCompletion()).resolves.toBeUndefined();
    expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(false);
    expect(logs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        level: 'debug',
        message: expect.stringContaining('status poll failed'),
        fields: expect.objectContaining({ error: pollError }),
      }),
    ]));

    await runtime.waitForTurnCompletion();

    expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(true);
  });

  it('fails active turns when status polling fails after the managed server exits', async () => {
    const { ctx, harness, runtimeEvents, transcriptAppends } = createContextFixture();
    const client = createClientFixture();
    vi.mocked(client.sessionStatus).mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:49196'));
    const runtime = await createStartedRuntime({
      ctx,
      client,
      harness,
      readManagedServerSnapshot: () => ({
        id: 'opencode-server',
        state: 'unhealthy',
        mode: 'managed-spawn',
        baseUrl: 'http://127.0.0.1:49196',
        port: 49196,
        credentialEnvKey: 'OPENCODE_SERVER_PASSWORD',
        pid: 123,
        startedAt: 100,
        lastHealthyAt: 120,
        lastErrorMessage: "Managed server 'opencode-server' exited after becoming healthy",
        diagnostics: {
          exitCode: 1,
          exitSignal: null,
          stderrTail: 'server crashed after ready with Authorization: Bearer sk-live-secret',
        },
      }),
    });
    runtime.beginTurnLifecycle();

    await runtime.waitForTurnCompletion();

    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'turn-failed',
        issue: expect.objectContaining({
          agentId: 'opencode',
          code: 'opencode_managed_server_unhealthy',
          source: 'agent_process_exit',
          sanitizedPreview: expect.stringContaining('exited after becoming healthy'),
        }),
      }),
      expect.objectContaining({
        kind: 'transcript-agent-message-committed',
        agentId: 'opencode',
        body: expect.objectContaining({
          type: 'turn_failed',
        }),
      }),
    ]));
    expect(JSON.stringify(runtimeEvents)).not.toContain('sk-live-secret');
    expect(transcriptAppends).toHaveLength(0);

    await runtime.waitForTurnCompletion();
    expect(client.sessionStatus).toHaveBeenCalledTimes(1);
  });

  it('ignores broad history running tools that are not tied to the active OpenCode turn', async () => {
    const { ctx, harness, runtimeEvents } = createContextFixture();
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
    const runtime = await createStartedRuntime({ ctx, client, harness });
    runtime.beginTurnLifecycle();

    await runtime.waitForTurnCompletion();

    expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(true);
  });

  it('completes active turns when OpenCode reports idle after provider work has drained', async () => {
    const { ctx, harness, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    const runtime = await createStartedRuntime({ ctx, client, harness });
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
    expect(client.sessionMessages).toHaveBeenCalledTimes(1);
  });

  it('starts a provider-autonomous turn for native background task parent output', async () => {
    const { ctx, harness, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    const runtime = await createStartedRuntime({ ctx, client, harness });

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
      expect.objectContaining({ agentTurnId: 'ses-1' }),
    ]));
  });

  it('wires provider events from the OpenCode server subscription into turn lifecycle handling', async () => {
    const { ctx, harness, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    const runtime = await createStartedRuntime({ ctx, client, harness });

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
      expect.objectContaining({ agentTurnId: 'ses-1' }),
    ]));

    await runtime.resetOrDisposeRuntime();
  });

  it('starts a provider-autonomous turn for oh-my-openagent background output', async () => {
    const { ctx, harness, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    const runtime = await createStartedRuntime({ ctx, client, harness });

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
      expect.objectContaining({ agentTurnId: 'ses-1' }),
    ]));
  });

  it('publishes detached runtime activity for an OpenCode background task launch and clears it from a matching wake', async () => {
    const { ctx, harness, stateFieldWrites } = createContextFixture();
    const client = createClientFixture();
    const runtime = await createStartedRuntime({ ctx, client, harness });
    runtime.beginTurnLifecycle();
    stateFieldWrites.length = 0;

    await runtime.handleProviderEvent({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-background-task-launch',
            type: 'tool',
            sessionID: 'ses-1',
            messageID: 'msg-background-task-launch',
            callID: 'call-background-task-launch',
            tool: 'task',
            state: {
              status: 'completed',
              input: { description: 'Run in background', background: true },
              output: '<task state="running" id="ses-background-child"></task>',
              metadata: { sessionId: 'ses-background-child', background: true },
            },
          },
        },
      },
    });

    await expect.poll(() => stateFieldWrites.some((write) => (
      write.fieldId === 'runtime.activity' &&
      (write.value as { activeCount?: unknown; sourceClass?: unknown }).activeCount === 1 &&
      (write.value as { activeCount?: unknown; sourceClass?: unknown }).sourceClass === 'provider_detached_task'
    ))).toBe(true);
    expect(stateFieldWrites).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        fieldId: 'runtime.activity',
        value: expect.objectContaining({ sourceClass: 'provider_autonomous_output' }),
      }),
    ]));

    await runtime.handleProviderEvent({
      payload: {
        type: 'session.idle',
        properties: { sessionID: 'ses-1' },
      },
    });
    await runtime.handleProviderEvent({
      payload: {
        type: 'message.part.delta',
        properties: {
          sessionID: 'ses-1',
          messageID: 'msg-background-task-wake',
          partID: 'part-background-task-wake',
          delta: '<task state="completed" id="ses-background-child"><task_result>Done</task_result></task>',
        },
      },
    });

    await expect.poll(() => stateFieldWrites.filter((write) => write.fieldId === 'runtime.activity').at(-1)).toMatchObject({
      fieldId: 'runtime.activity',
      value: {
        v: 1,
        activeCount: 0,
        observedAtMs: null,
        expiresAtMs: null,
        sourceClass: null,
      },
    });
  });

  it('does not clear all OpenCode detached runtime activity for an unattributed single-task wake', async () => {
    const { ctx, harness, stateFieldWrites } = createContextFixture();
    const client = createClientFixture();
    const runtime = await createStartedRuntime({ ctx, client, harness });
    runtime.beginTurnLifecycle();

    await runtime.handleProviderEvent({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-background-task-unattributed',
            type: 'tool',
            sessionID: 'ses-1',
            messageID: 'msg-background-task-unattributed',
            callID: 'call-background-task-unattributed',
            tool: 'task',
            state: {
              status: 'completed',
              input: { background: true },
              output: '<task state="running" id="ses-background-child-unattributed"></task>',
              metadata: { sessionId: 'ses-background-child-unattributed', background: true },
            },
          },
        },
      },
    });
    await expect.poll(() => stateFieldWrites.some((write) => (
      write.fieldId === 'runtime.activity' &&
      (write.value as { activeCount?: unknown; sourceClass?: unknown }).activeCount === 1 &&
      (write.value as { activeCount?: unknown; sourceClass?: unknown }).sourceClass === 'provider_detached_task'
    ))).toBe(true);

    await runtime.handleProviderEvent({
      payload: {
        type: 'session.idle',
        properties: { sessionID: 'ses-1' },
      },
    });
    const writesBeforeWake = stateFieldWrites.length;
    await runtime.handleProviderEvent({
      payload: {
        type: 'message.part.delta',
        properties: {
          sessionID: 'ses-1',
          messageID: 'msg-background-task-unattributed-wake',
          partID: 'part-background-task-unattributed-wake',
          delta: [
            '<system-reminder>',
            '[BACKGROUND TASK COMPLETED]',
            '<!-- OMO_INTERNAL_INITIATOR -->',
            '</system-reminder>',
          ].join('\n'),
        },
      },
    });

    expect(stateFieldWrites).toHaveLength(writesBeforeWake);

    await runtime.handleProviderEvent({
      payload: {
        type: 'message.part.delta',
        properties: {
          sessionID: 'ses-1',
          messageID: 'msg-background-task-all-complete',
          partID: 'part-background-task-all-complete',
          delta: [
            '<system-reminder>',
            '[ALL BACKGROUND TASKS COMPLETE]',
            '<!-- OMO_INTERNAL_INITIATOR -->',
            '</system-reminder>',
          ].join('\n'),
        },
      },
    });

    await expect.poll(() => stateFieldWrites.filter((write) => write.fieldId === 'runtime.activity').at(-1)).toMatchObject({
      fieldId: 'runtime.activity',
      value: {
        v: 1,
        activeCount: 0,
        observedAtMs: null,
        expiresAtMs: null,
        sourceClass: null,
      },
    });
  });

  it('does not publish detached runtime activity for foreground-only OpenCode tool work', async () => {
    const { ctx, harness, stateFieldWrites } = createContextFixture();
    const client = createClientFixture();
    const runtime = await createStartedRuntime({ ctx, client, harness });
    runtime.beginTurnLifecycle();
    stateFieldWrites.length = 0;

    await runtime.handleProviderEvent({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-foreground-tool',
            type: 'tool',
            sessionID: 'ses-1',
            messageID: 'msg-foreground-tool',
            callID: 'call-foreground-tool',
            tool: 'bash',
            state: {
              status: 'running',
              input: { command: 'npm test' },
              output: '',
            },
          },
        },
      },
    });

    expect(stateFieldWrites).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ fieldId: 'runtime.activity' }),
    ]));
  });

  it('ignores background task events from other OpenCode sessions', async () => {
    const { ctx, harness, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    const runtime = await createStartedRuntime({ ctx, client, harness });

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
    const { ctx, harness, runtimeEvents, transcriptAppends } = createContextFixture();
    const client = createClientFixture();
    const runtime = await createStartedRuntime({ ctx, client, harness });
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
          agentId: 'opencode',
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
    expect(transcriptAppends).toHaveLength(0);
    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'transcript-agent-message-committed',
        agentId: 'opencode',
        body: expect.objectContaining({
          type: 'turn_failed',
        }),
      }),
    ]));
  });

  it('fails active turns when OpenCode reports a provider session error event', async () => {
    const { ctx, harness, runtimeEvents, transcriptAppends } = createContextFixture();
    const client = createClientFixture();
    const runtime = await createStartedRuntime({ ctx, client, harness });
    runtime.beginTurnLifecycle();

    await runtime.handleProviderEvent({
      payload: {
        type: 'session.error',
        properties: {
          sessionID: 'ses-1',
          error: {
            name: 'ProviderAuthError',
            data: {
              message: 'Token refresh failed: 401 Authorization: Bearer sk-live-secret',
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
      expect.objectContaining({
        kind: 'turn-failed',
        issue: expect.objectContaining({
          agentId: 'opencode',
          code: 'opencode_provider_session_error',
          source: 'auth_error',
          sanitizedPreview: expect.stringContaining('Token refresh failed: 401'),
        }),
      }),
      expect.objectContaining({
        kind: 'transcript-agent-message-committed',
        agentId: 'opencode',
        body: expect.objectContaining({
          type: 'turn_failed',
        }),
      }),
    ]));
    expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(false);
    expect(JSON.stringify(runtimeEvents)).not.toContain('sk-live-secret');
    expect(transcriptAppends).toHaveLength(0);
  });

  it('reports connected-service runtime-auth recovery for provider session auth errors', async () => {
    const refreshRuntimeAuth = vi.fn(async () => ({
      status: 'unavailable' as const,
      reason: 'runtime_auth_selection_unavailable',
    }));
    const fixture = createContextFixture();
    const ctx = {
      ...fixture.ctx,
      sessions: {
        ...fixture.ctx.sessions,
        current: {
          ...fixture.ctx.sessions.current,
          auth: {
            services: {
              refreshRuntimeAuth,
            },
          },
        },
      },
    } as PluginContextV1;
    const client = createClientFixture();
    const runtime = await createStartedRuntime({
      ctx,
      client,
      harness: fixture.harness,
      env: {
        [OPEN_CODE_BROKER_SELECTIONS_ENV]: serializeOpenCodeBrokerSelections({
          openai: {
            serviceId: 'openai-codex',
            profileId: 'codex-profile',
            accountId: null,
            planType: 'plus',
          },
        }),
      },
    });
    runtime.beginTurnLifecycle();

    await runtime.handleProviderEvent({
      payload: {
        type: 'session.error',
        properties: {
          sessionID: 'ses-1',
          error: {
            name: 'ProviderAuthError',
            data: {
              message: 'Token refresh failed: 401 Authorization: Bearer sk-live-secret',
            },
          },
        },
      },
    });
    await flushMicrotasks();

    expect(refreshRuntimeAuth).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'opencode',
      serviceId: 'openai-codex',
      targetId: 'happy-session-1',
      classification: expect.objectContaining({
        kind: 'auth_expired',
        limitCategory: 'auth_invalid',
        serviceId: 'openai-codex',
        profileId: 'codex-profile',
        connectedServiceRecovery: 'available',
      }),
      reason: 'provider_session_auth_failure',
    }));
    expect(refreshRuntimeAuth.mock.calls[0]?.[0]).not.toHaveProperty('selection');
    expect(JSON.stringify(refreshRuntimeAuth.mock.calls)).not.toContain('sk-live-secret');
  });

  it('publishes a provider session failure once when provider event and status polling race', async () => {
    const { ctx, harness, runtimeEvents, transcriptAppends } = createContextFixture();
    const client = createClientFixture();
    vi.mocked(client.sessionStatus).mockResolvedValue({
      type: 'error',
      error: {
        name: 'ProviderAuthError',
        data: {
          message: 'Token refresh failed: 401 Authorization: Bearer sk-live-secret',
        },
      },
    });
    const runtime = await createStartedRuntime({ ctx, client, harness });
    runtime.beginTurnLifecycle();

    await Promise.all([
      runtime.handleProviderEvent({
        payload: {
          type: 'session.error',
          properties: {
            sessionID: 'ses-1',
            error: {
              name: 'ProviderAuthError',
              data: {
                message: 'Token refresh failed: 401 Authorization: Bearer sk-live-secret',
              },
            },
          },
        },
      }),
      runtime.waitForTurnCompletion(),
    ]);

    expect(runtimeEvents.filter((event) => event.kind === 'turn-failed')).toHaveLength(1);
    expect(runtimeEvents.filter((event) => (
      event.kind === 'transcript-agent-message-committed'
      && event.agentId === 'opencode'
      && event.body.type === 'turn_failed'
    ))).toHaveLength(1);
    expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(false);
    expect(JSON.stringify(runtimeEvents)).not.toContain('sk-live-secret');
    expect(transcriptAppends).toHaveLength(0);
  });

  it('fails active turns when status polling reports a provider session error', async () => {
    const { ctx, harness, runtimeEvents, transcriptAppends } = createContextFixture();
    const client = createClientFixture();
    vi.mocked(client.sessionStatus).mockResolvedValue({
      type: 'error',
      error: {
        name: 'ProviderAuthError',
        data: {
          message: 'Token refresh failed: 401 Authorization: Bearer sk-live-secret',
        },
      },
    });
    const runtime = await createStartedRuntime({ ctx, client, harness });
    runtime.beginTurnLifecycle();

    await runtime.waitForTurnCompletion();

    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'turn-failed',
        issue: expect.objectContaining({
          agentId: 'opencode',
          code: 'opencode_provider_session_error',
          source: 'auth_error',
          sanitizedPreview: expect.stringContaining('Token refresh failed: 401'),
        }),
      }),
      expect.objectContaining({
        kind: 'transcript-agent-message-committed',
        agentId: 'opencode',
        body: expect.objectContaining({
          type: 'turn_failed',
        }),
      }),
    ]));
    expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(false);
    expect(JSON.stringify(runtimeEvents)).not.toContain('sk-live-secret');
    expect(transcriptAppends).toHaveLength(0);
  });

  it('fails active turns when control-plane status polling reports usage-limit retry', async () => {
    const { ctx, harness, runtimeEvents, transcriptAppends } = createContextFixture();
    const client = createClientFixture();
    vi.mocked(client.sessionStatus).mockResolvedValue({
      type: 'retry',
      attempt: 4,
      message: 'Quota limit reached for this account',
      next: Date.now() + 60_000,
    });
    const runtime = await createStartedRuntime({ ctx, client, harness });
    runtime.beginTurnLifecycle();

    await expect(runtime.waitForTurnCompletion()).rejects.toThrow('Quota limit reached for this account');

    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'turn-failed',
        issue: expect.objectContaining({
          source: 'usage_limit',
          agentId: 'opencode',
          code: 'opencode_session_retry',
          usageLimit: expect.objectContaining({
            limitCategory: 'usage_limit',
          }),
        }),
      }),
    ]));
    expect(transcriptAppends).toHaveLength(0);
    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'transcript-agent-message-committed',
        agentId: 'opencode',
        body: expect.objectContaining({
          type: 'turn_failed',
        }),
      }),
    ]));
  });

  describe('managed-server generation recovery (Lane E)', () => {
    function generationSnapshot(overrides: Partial<ManagedServerSnapshotV1>): ManagedServerSnapshotV1 {
      return {
        id: 'opencode-server',
        state: 'healthy',
        mode: 'managed-spawn',
        baseUrl: 'http://127.0.0.1:49196',
        port: 49196,
        credentialEnvKey: 'OPENCODE_SERVER_PASSWORD',
        pid: 100,
        startedAt: 1000,
        lastHealthyAt: 1200,
        ...overrides,
      } as ManagedServerSnapshotV1;
    }

    function runningToolPart(callId: string) {
      return {
        id: `part-${callId}`,
        type: 'tool',
        sessionID: 'ses-1',
        messageID: `msg-${callId}`,
        callID: callId,
        tool: 'bash',
        state: { status: 'running' },
      };
    }

    it('fails the active turn exactly once when the managed server is replaced with unreconciled tool work', async () => {
      const { ctx, harness, runtimeEvents } = createContextFixture();
      const client = createClientFixture();
      // Replacement server's history still shows the tool running → unreconciled live-known work.
      client.setMessages([
        { info: { id: 'msg-call-live-1', role: 'assistant', sessionID: 'ses-1' }, parts: [runningToolPart('call-live-1')] },
      ]);
      let snapshot = generationSnapshot({});
      const runtime = await createStartedRuntime({
        ctx,
        client,
        harness,
        readManagedServerSnapshot: () => snapshot,
      });
      runtime.beginTurnLifecycle();
      // Observe the live running tool under generation A.
      await runtime.handleProviderEvent({
        payload: { type: 'message.part.updated', properties: { part: runningToolPart('call-live-1') } },
      });

      // Managed server replaced mid-turn (new pid/startedAt/baseUrl) → generation B.
      snapshot = generationSnapshot({ pid: 200, startedAt: 2000, baseUrl: 'http://127.0.0.1:49197', port: 49197 });
      await runtime.waitForTurnCompletion();
      await runtime.waitForTurnCompletion();

      const restartFailures = runtimeEvents.filter(
        (event) => event.kind === 'turn-failed'
          && (event as { issue?: { code?: string } }).issue?.code === 'opencode_server_restarted_during_turn',
      );
      expect(restartFailures).toHaveLength(1);
      expect(restartFailures[0]).toEqual(expect.objectContaining({
        issue: expect.objectContaining({
          agentId: 'opencode',
          code: 'opencode_server_restarted_during_turn',
          source: 'stream_error',
        }),
      }));
      // No prompt replay, no abort.
      expect(client.sessionPromptAsync).not.toHaveBeenCalled();
      expect(client.sessionAbort).not.toHaveBeenCalled();
    });

    it('does not fail the turn when the replacement server reconciles the tool as terminal', async () => {
      const { ctx, harness, runtimeEvents } = createContextFixture();
      const client = createClientFixture();
      let snapshot = generationSnapshot({});
      const runtime = await createStartedRuntime({
        ctx,
        client,
        harness,
        readManagedServerSnapshot: () => snapshot,
      });
      runtime.beginTurnLifecycle();
      await runtime.handleProviderEvent({
        payload: { type: 'message.part.updated', properties: { part: runningToolPart('call-live-2') } },
      });

      // The replacement server's durable history shows the tool COMPLETED (reconciled terminal).
      client.setMessages([
        {
          info: { id: 'msg-call-live-2', role: 'assistant', sessionID: 'ses-1' },
          parts: [{ ...runningToolPart('call-live-2'), state: { status: 'completed' } }],
        },
      ]);
      snapshot = generationSnapshot({ pid: 200, startedAt: 2000, baseUrl: 'http://127.0.0.1:49197', port: 49197 });
      await runtime.waitForTurnCompletion();

      expect(runtimeEvents.some(
        (event) => event.kind === 'turn-failed'
          && (event as { issue?: { code?: string } }).issue?.code === 'opencode_server_restarted_during_turn',
      )).toBe(false);
    });

    it('does not wedge: orphaned old-generation work reaches a terminal turn state', async () => {
      const { ctx, harness, runtimeEvents } = createContextFixture();
      const client = createClientFixture();
      let snapshot = generationSnapshot({});
      const runtime = await createStartedRuntime({
        ctx,
        client,
        harness,
        readManagedServerSnapshot: () => snapshot,
      });
      runtime.beginTurnLifecycle();
      // Live running tool tracked under generation A.
      await runtime.handleProviderEvent({
        payload: { type: 'message.part.updated', properties: { part: runningToolPart('call-orphan') } },
      });
      // Replacement server: history is empty (the orphaned tool is gone), so it cannot be reconciled
      // terminal and remains as unreconciled live-known work → the supervisor fails the turn once
      // rather than letting orphaned old-generation work wedge completion forever.
      client.setMessages([]);
      snapshot = generationSnapshot({ pid: 200, startedAt: 2000, baseUrl: 'http://127.0.0.1:49197', port: 49197 });

      await runtime.waitForTurnCompletion();
      await runtime.waitForTurnCompletion();

      const terminal = runtimeEvents.filter(
        (event) => event.kind === 'turn-failed' || event.kind === 'turn-complete',
      );
      expect(terminal.length).toBeGreaterThanOrEqual(1);
      expect(runtimeEvents.some(
        (event) => event.kind === 'turn-failed'
          && (event as { issue?: { code?: string } }).issue?.code === 'opencode_server_restarted_during_turn',
      )).toBe(true);
    });

    it('fails the active turn when the managed server is replaced while a permission ask is pending', async () => {
      let resolvePermissionDecision: ((value: { decision: 'approved' }) => void) | null = null;
      let permissionResolved = false;
      const pendingPermissionDecision = new Promise<{ decision: 'approved' }>((resolve) => {
        resolvePermissionDecision = (value) => {
          permissionResolved = true;
          resolve(value);
        };
      });
      const { ctx, harness, runtimeEvents } = createContextFixture({
        onPermissionDecision: async () => await pendingPermissionDecision,
      });
      const client = createClientFixture();
      let snapshot = generationSnapshot({});
      const runtime = await createStartedRuntime({
        ctx,
        client,
        harness,
        readManagedServerSnapshot: () => snapshot,
      });
      await runtime.handleProviderEvent({ payload: { type: 'server.connected', properties: {} } });

      await runtime.sendTurnPrompt('hello');
      const permissionAsk = runtime.handleProviderEvent({
        payload: {
          type: 'permission.asked',
          properties: {
            sessionID: 'ses-1',
            id: 'per_generation_replaced',
            permission: 'bash',
            patterns: ['pwd'],
          },
        },
      });
      void permissionAsk.catch(() => undefined);
      await Promise.resolve();

      try {
        snapshot = generationSnapshot({ pid: 200, startedAt: 2000, baseUrl: 'http://127.0.0.1:49197', port: 49197 });

        await runtime.waitForTurnCompletion();

        expect(runtimeEvents).toEqual(expect.arrayContaining([
          expect.objectContaining({
            kind: 'turn-failed',
            issue: expect.objectContaining({
              agentId: 'opencode',
              code: 'opencode_server_restarted_during_turn',
              source: 'stream_error',
            }),
          }),
        ]));
        expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(false);
      } finally {
        if (!permissionResolved) {
          resolvePermissionDecision?.({ decision: 'approved' });
          await permissionAsk;
        }
      }
    });

    it('drops stale permission decisions after the original turn is failed and a new turn starts', async () => {
      let resolvePermissionDecision: ((value: { decision: 'approved' }) => void) | null = null;
      const pendingPermissionDecision = new Promise<{ decision: 'approved' }>((resolve) => {
        resolvePermissionDecision = resolve;
      });
      const { ctx, harness, runtimeEvents } = createContextFixture({
        onPermissionDecision: async () => await pendingPermissionDecision,
      });
      const client = createClientFixture();
      let snapshot = generationSnapshot({});
      const runtime = await createStartedRuntime({
        ctx,
        client,
        harness,
        readManagedServerSnapshot: () => snapshot,
      });
      await runtime.handleProviderEvent({ payload: { type: 'server.connected', properties: {} } });

      await runtime.sendTurnPrompt('hello');
      const stalePermissionAsk = runtime.handleProviderEvent({
        payload: {
          type: 'permission.asked',
          properties: {
            sessionID: 'ses-1',
            id: 'per_stale_after_restart',
            permission: 'bash',
            patterns: ['pwd'],
          },
        },
      });
      void stalePermissionAsk.catch(() => undefined);
      await Promise.resolve();

      snapshot = generationSnapshot({ pid: 200, startedAt: 2000, baseUrl: 'http://127.0.0.1:49197', port: 49197 });
      await runtime.waitForTurnCompletion();
      await runtime.handleProviderEvent({ payload: { type: 'server.connected', properties: {} } });
      await runtime.sendTurnPrompt('next turn');

      resolvePermissionDecision?.({ decision: 'approved' });
      await stalePermissionAsk;

      expect(client.permissionReply).not.toHaveBeenCalled();
      expect(runtimeEvents.filter((event) => event.kind === 'turn-failed')).toHaveLength(1);
      expect(runtimeEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'turn-failed',
          issue: expect.objectContaining({
            code: 'opencode_server_restarted_during_turn',
          }),
        }),
      ]));
    });

    it('drops permission decisions when the managed server was replaced before restart observation', async () => {
      let resolvePermissionDecision: ((value: { decision: 'approved' }) => void) | null = null;
      const pendingPermissionDecision = new Promise<{ decision: 'approved' }>((resolve) => {
        resolvePermissionDecision = resolve;
      });
      const { ctx, harness, runtimeEvents } = createContextFixture({
        onPermissionDecision: async () => await pendingPermissionDecision,
      });
      const client = createClientFixture();
      let snapshot = generationSnapshot({});
      const runtime = await createStartedRuntime({
        ctx,
        client,
        harness,
        readManagedServerSnapshot: () => snapshot,
      });
      await runtime.handleProviderEvent({ payload: { type: 'server.connected', properties: {} } });

      await runtime.sendTurnPrompt('hello');
      const stalePermissionAsk = runtime.handleProviderEvent({
        payload: {
          type: 'permission.asked',
          properties: {
            sessionID: 'ses-1',
            id: 'per_stale_before_observe',
            permission: 'bash',
            patterns: ['pwd'],
          },
        },
      });
      void stalePermissionAsk.catch(() => undefined);
      await Promise.resolve();

      snapshot = generationSnapshot({ pid: 200, startedAt: 2000, baseUrl: 'http://127.0.0.1:49197', port: 49197 });
      resolvePermissionDecision?.({ decision: 'approved' });
      await stalePermissionAsk;

      expect(client.permissionReply).not.toHaveBeenCalled();

      await runtime.waitForTurnCompletion();

      expect(runtimeEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'turn-failed',
          issue: expect.objectContaining({
            code: 'opencode_server_restarted_during_turn',
          }),
        }),
      ]));
    });
  });

  describe('origin-agnostic transcript projection (Lane H / S2)', () => {
    function externalUserMessage(messageId: string, text: string, createdAtMs: number) {
      return {
        info: { id: messageId, role: 'user', sessionID: 'ses-1', time: { created: createdAtMs } },
        parts: [{ id: `${messageId}-part`, type: 'text', text }],
      };
    }

    function providerUserMessageWithCreatedAtMs(messageId: string, text: string, createdAtMs: number) {
      return {
        info: { id: messageId, role: 'user', sessionID: 'ses-1', createdAtMs },
        parts: [{ id: `${messageId}-part`, type: 'text', text }],
      };
    }

    function externalTerminalAssistantMessage(messageId: string, text: string, completedAtMs: number) {
      return {
        info: {
          id: messageId,
          role: 'assistant',
          sessionID: 'ses-1',
          finish: 'stop',
          time: { created: completedAtMs - 10, completed: completedAtMs },
        },
        parts: [{ id: `${messageId}-part`, type: 'text', text }],
      };
    }

    function userTextEvents(events: readonly RuntimeEventV1[]): RuntimeEventV1[] {
      return events.filter((event) => event.kind === 'transcript-user-text');
    }

    function committedAssistantEvents(events: readonly RuntimeEventV1[]): RuntimeEventV1[] {
      return events.filter((event) => event.kind === 'transcript-agent-message-committed'
        && (event as { body?: { type?: string } }).body?.type === 'message');
    }

    it.each([
      ['prompt-stack wrapper', '[analyze-mode]\nHappier system prompt...\nUser request: RUQA_PROMPT_STACK'],
      ['plain provider prompt', 'RUQA plain dispatched prompt'],
    ])('does not passively mirror a delayed Happier-authored %s user row after turn completion', async (_label, prompt) => {
      vi.useFakeTimers();
      vi.setSystemTime(10_000);
      const { ctx, harness, runtimeEvents } = createContextFixture();
      const client = createClientFixture();
      const runtime = await createStartedRuntime({ ctx, client, harness });

      await runtime.sendTurnPrompt(prompt);
      await runtime.handleProviderEvent({
        payload: {
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'msg-authored-assistant-part',
              messageID: 'msg-authored-assistant',
              type: 'text',
              text: 'AUTHORED_ASSISTANT_OK',
            },
          },
        },
      });
      client.setMessages([
        externalTerminalAssistantMessage('msg-authored-assistant', 'AUTHORED_ASSISTANT_OK', 11_000),
      ]);
      vi.setSystemTime(11_000);
      await runtime.handleProviderEvent({ payload: { type: 'session.idle', properties: {} } });

      expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(true);
      expect(committedAssistantEvents(runtimeEvents)).toHaveLength(1);
      expect(userTextEvents(runtimeEvents)).toHaveLength(0);

      client.setMessages([
        providerUserMessageWithCreatedAtMs('msg-delayed-authored-user', prompt, 10_001),
        externalTerminalAssistantMessage('msg-authored-assistant', 'AUTHORED_ASSISTANT_OK', 11_000),
      ]);
      await runtime.handleProviderEvent({ payload: { type: 'server.connected', properties: {} } });

      expect(userTextEvents(runtimeEvents)).toHaveLength(0);
      expect(committedAssistantEvents(runtimeEvents)).toHaveLength(1);
    });

    it('does not passively mirror delayed OpenCode prompt-stack rows that wrap a Happier-authored prompt', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(20_000);
      const { ctx, harness, runtimeEvents } = createContextFixture();
      const client = createClientFixture();
      const runtime = await createStartedRuntime({ ctx, client, harness });
      const prompt = 'Reply exactly: RUQA_PROMPT_STACK_WRAPPED';

      await runtime.sendTurnPrompt(prompt);
      await runtime.handleProviderEvent({
        payload: {
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'msg-wrapped-assistant-part',
              messageID: 'msg-wrapped-assistant',
              type: 'text',
              text: 'RUQA_PROMPT_STACK_WRAPPED',
            },
          },
        },
      });
      client.setMessages([
        externalTerminalAssistantMessage('msg-wrapped-assistant', 'RUQA_PROMPT_STACK_WRAPPED', 21_000),
      ]);
      vi.setSystemTime(21_000);
      await runtime.handleProviderEvent({ payload: { type: 'session.idle', properties: {} } });

      expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(true);
      expect(userTextEvents(runtimeEvents)).toHaveLength(0);
      expect(committedAssistantEvents(runtimeEvents)).toHaveLength(1);

      client.setMessages([
        providerUserMessageWithCreatedAtMs(
          'msg-delayed-wrapped-authored-user',
          [
            '[analyze-mode]',
            'ANALYSIS MODE. Gather context before diving deep.',
            'Session title',
            'Options',
            `User request: ${prompt}`,
            'Linked workspace files',
          ].join('\n'),
          20_001,
        ),
        providerUserMessageWithCreatedAtMs(
          'msg-delayed-wrapped-authored-user-2',
          [
            '[search-mode]',
            'Session title',
            'Attachments',
            `User request: ${prompt}`,
          ].join('\n'),
          20_002,
        ),
        externalTerminalAssistantMessage('msg-wrapped-assistant', 'RUQA_PROMPT_STACK_WRAPPED', 21_000),
      ]);
      await runtime.handleProviderEvent({ payload: { type: 'server.connected', properties: {} } });

      expect(userTextEvents(runtimeEvents)).toHaveLength(0);
      expect(committedAssistantEvents(runtimeEvents)).toHaveLength(1);
    });

    it('mirrors settled TUI-authored user + assistant messages into the transcript when no Happier turn is active', async () => {
      const { ctx, harness, runtimeEvents } = createContextFixture();
      const client = createClientFixture();
      client.setMessages([
        externalUserMessage('msg-ext-user', 'a question typed in the OpenCode TUI', 1_000),
        externalTerminalAssistantMessage('msg-ext-assistant', 'TUI_ANSWER_OK', 2_000),
      ]);
      const runtime = await createStartedRuntime({ ctx, client, harness });

      // No Happier turn in flight: a server.connected catch-up mirrors the external turn.
      await runtime.handleProviderEvent({ payload: { type: 'server.connected', properties: {} } });

      const userEvents = userTextEvents(runtimeEvents);
      const assistantEvents = committedAssistantEvents(runtimeEvents);
      expect(userEvents).toHaveLength(1);
      expect((userEvents[0] as { text?: string }).text).toContain('a question typed in the OpenCode TUI');
      expect(assistantEvents).toHaveLength(1);
      expect((assistantEvents[0] as { body?: { message?: string } }).body?.message).toBe('TUI_ANSWER_OK');
      // Mirror-only: never re-enqueued back to OpenCode.
      expect(client.sessionPromptAsync).not.toHaveBeenCalled();
      // No turn lifecycle is fabricated for the external turn.
      expect(runtimeEvents.some((event) => event.kind === 'turn-start')).toBe(false);
    });

    it('does not passively mirror late assistant messages from a Happier-authored turn that already failed', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      const { ctx, harness, runtimeEvents } = createContextFixture();
      const client = createClientFixture();
      const runtime = await createStartedRuntime({ ctx, client, harness });
      const prompt = 'RUQA late assistant should stay quarantined';
      const authoredProviderUser = externalUserMessage('msg-late-authored-user', prompt, 1_000);

      await runtime.sendTurnPrompt(prompt);
      client.setMessages([authoredProviderUser]);
      await runtime.waitForTurnCompletion();

      expect(runtimeEvents.some((event) => event.kind === 'turn-failed')).toBe(false);
      expect(committedAssistantEvents(runtimeEvents)).toHaveLength(0);

      vi.setSystemTime(61_001);
      await runtime.waitForTurnCompletion();

      expect(runtimeEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'turn-failed',
          issue: expect.objectContaining({
            agentId: 'opencode',
            code: 'opencode_empty_provider_response',
          }),
        }),
      ]));
      expect(committedAssistantEvents(runtimeEvents)).toHaveLength(0);

      client.setMessages([
        authoredProviderUser,
        externalTerminalAssistantMessage('msg-late-authored-assistant', 'LATE_ASSISTANT_MUST_NOT_MIRROR', 62_000),
      ]);
      vi.setSystemTime(62_000);
      await runtime.handleProviderEvent({ payload: { type: 'session.idle', properties: { sessionID: 'ses-1' } } });

      expect(userTextEvents(runtimeEvents)).toHaveLength(0);
      expect(committedAssistantEvents(runtimeEvents)).toHaveLength(0);
      expect(JSON.stringify(runtimeEvents)).not.toContain('LATE_ASSISTANT_MUST_NOT_MIRROR');
    });

    it('is idempotent: re-triggering the passive projection does not duplicate mirrored messages', async () => {
      const { ctx, harness, runtimeEvents } = createContextFixture();
      const client = createClientFixture();
      client.setMessages([
        externalUserMessage('msg-ext-user-2', 'second TUI question', 3_000),
        externalTerminalAssistantMessage('msg-ext-assistant-2', 'SECOND_ANSWER', 4_000),
      ]);
      const runtime = await createStartedRuntime({ ctx, client, harness });

      await runtime.handleProviderEvent({ payload: { type: 'server.connected', properties: {} } });
      await runtime.handleProviderEvent({ payload: { type: 'server.connected', properties: {} } });

      expect(userTextEvents(runtimeEvents)).toHaveLength(1);
      expect(committedAssistantEvents(runtimeEvents)).toHaveLength(1);
    });

    it('keeps external-user dedupe scoped to the active provider session', async () => {
      const { ctx, harness, runtimeEvents } = createContextFixture();
      const client = createClientFixture();
      vi.mocked(client.sessionCreate)
        .mockResolvedValueOnce({ id: 'provider-session-1' })
        .mockResolvedValueOnce({ id: 'provider-session-2' });
      client.setMessages([
        externalUserMessage('msg-colliding-user', 'first provider-session TUI question', 3_000),
      ]);
      const runtime = await createStartedRuntime({ ctx, client, harness });

      await runtime.handleProviderEvent({ payload: { type: 'server.connected', properties: {} } });
      client.setMessages([
        externalUserMessage('msg-colliding-user', 'second provider-session TUI question', 4_000),
      ]);
      await runtime.startOrLoadSession();
      await runtime.handleProviderEvent({ payload: { type: 'server.connected', properties: {} } });

      const mirroredUserEvents = userTextEvents(runtimeEvents);
      expect(mirroredUserEvents.map((event) => (event as { text?: string }).text)).toEqual([
        'first provider-session TUI question',
        'second provider-session TUI question',
      ]);
      expect(mirroredUserEvents.map((event) => event.localId)).toEqual([
        'opencode:provider-session-1:msg-colliding-user',
        'opencode:provider-session-2:msg-colliding-user',
      ]);
    });

    it('does not mirror in-progress (non-terminal) assistant messages', async () => {
      const { ctx, harness, runtimeEvents } = createContextFixture();
      const client = createClientFixture();
      client.setMessages([
        externalUserMessage('msg-ext-user-3', 'streaming question', 5_000),
        // No `time.completed` → non-terminal assistant; must not be committed.
        {
          info: { id: 'msg-ext-assistant-3', role: 'assistant', sessionID: 'ses-1' },
          parts: [{ id: 'p3', type: 'text', text: 'partial in-progress text' }],
        },
      ]);
      const runtime = await createStartedRuntime({ ctx, client, harness });

      await runtime.handleProviderEvent({ payload: { type: 'server.connected', properties: {} } });

      // The settled user message mirrors; the in-progress assistant text does not.
      expect(userTextEvents(runtimeEvents)).toHaveLength(1);
      expect(committedAssistantEvents(runtimeEvents)).toHaveLength(0);
    });

    it('does not run the passive projection while a Happier turn is in flight (live path owns it)', async () => {
      const { ctx, harness, runtimeEvents } = createContextFixture();
      const client = createClientFixture();
      client.setMessages([
        externalUserMessage('msg-live-user', 'unrelated history user row', 6_000),
      ]);
      const runtime = await createStartedRuntime({ ctx, client, harness });
      runtime.beginTurnLifecycle();

      // server.connected during an active turn must NOT passively mirror unrelated history rows.
      await runtime.handleProviderEvent({ payload: { type: 'server.connected', properties: {} } });

      expect(userTextEvents(runtimeEvents)).toHaveLength(0);
    });

    it('does not reimport old Happier-authored provider user rows after many authored turns and runtime recreation', async () => {
      const { ctx, harness, runtimeEvents } = createContextFixture();
      const client = createClientFixture();
      vi.useFakeTimers();
      vi.mocked(client.sessionCreate)
        .mockResolvedValueOnce({ id: 'provider-session-long' })
        .mockResolvedValueOnce({ id: 'provider-session-long' });
      client.setMessages([]);
      const runtime = await createStartedRuntime({ ctx, client, harness });
      const authoredMessages: Array<ReturnType<typeof externalUserMessage>> = [];

      for (let index = 0; index < 4097; index += 1) {
        const prompt = `host authored prompt ${index}`;
        const submittedAtMs = 10_000 + (index * 100_000);
        const message = externalUserMessage(`msg-authored-${index}`, prompt, submittedAtMs);
        authoredMessages.push(message);
        vi.setSystemTime(submittedAtMs);
        client.setMessages([message]);
        await runtime.sendTurnPrompt(prompt);
        vi.setSystemTime(submittedAtMs + 61_001);
        await runtime.waitForTurnCompletion();
      }

      await runtime.resetOrDisposeRuntime();
      const eventCountBeforeRecreate = runtimeEvents.length;
      client.setMessages(authoredMessages);
      const recreated = await createStartedRuntime({ ctx, client, harness });

      await recreated.handleProviderEvent({ payload: { type: 'server.connected', properties: {} } });

      const recreatedEvents = runtimeEvents.slice(eventCountBeforeRecreate);
      expect(userTextEvents(recreatedEvents)).toHaveLength(0);
    }, 15_000);
  });
});
