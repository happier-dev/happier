import { describe, expect, it, vi } from 'vitest';
import { AgentSessionRuntimeEventSchema } from '@happier-dev/plugin-sdk/agents/runtime';
import { AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1 } from '@happier-dev/protocol/runtime';

import type { OpenCodeRuntimeTurnOperations } from './operations.js';
import type { OpenCodeRuntimeEvent } from './runtimeEvents.js';
import { createOpenCodeSessionRuntime } from './sessionRuntime.js';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function createOperationsFixture() {
  const subscribers = new Set<(event: OpenCodeRuntimeEvent) => void>();
  const operations = {
    beginTurnLifecycle: vi.fn(),
    openSession: vi.fn(async () => 'provider-session-child'),
    sendTurnPrompt: vi.fn(async () => ({
      providerUserMessageId: 'provider-user-message-1',
    })),
    steerInFlightTurn: vi.fn(async () => ({
      providerUserMessageId: 'provider-user-message-steer',
    })),
    waitForTurnCompletion: vi.fn(async () => undefined),
    subscribeRuntimeEvents(handler) {
      subscribers.add(handler);
      return () => subscribers.delete(handler);
    },
    cancelTurn: vi.fn(async () => undefined),
    compactContext: vi.fn(async () => undefined),
    listSkills: vi.fn(async () => []),
    readSessionIdentity: vi.fn(() => ({ sessionId: 'provider-session-child' })),
    isHappierAuthoredProviderUserMessageId: vi.fn(() => false),
    updateSessionRuntimeConfig: vi.fn(async () => undefined),
    handleProviderEvent: vi.fn(async () => undefined),
    resetOrDisposeRuntime: vi.fn(async () => undefined),
  } satisfies OpenCodeRuntimeTurnOperations;
  return {
    operations,
    publish(event: OpenCodeRuntimeEvent) {
      for (const subscriber of Array.from(subscribers)) subscriber(event);
    },
  };
}

function createRuntime(options: Readonly<{
  models?: Readonly<{
    bind(source: Readonly<{
      read(): Readonly<{
        models: readonly Readonly<{ id: string; name: string }>[];
        currentModelId?: string | null;
      }>;
      subscribe(listener: (snapshot: Readonly<{
        models: readonly Readonly<{ id: string; name: string }>[];
        currentModelId?: string | null;
      }>) => void): Readonly<{ dispose(): void }>;
    }>): Readonly<{ dispose(): void }>;
  }>;
  bindActiveSkillsReader?: (
    sessionId: string,
    reader: () => Promise<unknown>,
  ) => Readonly<{ dispose(): void }>;
}> = {}) {
  const fixture = createOperationsFixture();
  const disposeOperations = vi.fn(async () => undefined);
  const runtime = createOpenCodeSessionRuntime({
    operations: fixture.operations,
    request: {
      kind: 'create',
      sessionId: 'happier-session-child',
      cwd: '/repo',
    },
    disposeOperations,
    ...(options.models ? { models: options.models } : {}),
    ...(options.bindActiveSkillsReader
      ? { bindActiveSkillsReader: options.bindActiveSkillsReader }
      : {}),
  });
  return { ...fixture, runtime, disposeOperations };
}

describe('createOpenCodeSessionRuntime', () => {
  it('publishes exact host input acceptance before a synchronously emitted turn start', async () => {
    const { runtime, operations, publish } = createRuntime();
    const events: Array<{ kind: string; turnId?: string }> = [];
    runtime.watch((event) => events.push(event));
    operations.beginTurnLifecycle.mockImplementationOnce(() => {
      publish({
        kind: 'turn-start',
        sessionId: 'happier-session-child',
        turnId: 'turn-1',
        emittedAtMs: 10,
      });
    });

    await expect(runtime.send({
      inputIds: ['input-1'],
      input: { text: 'Implement the cutover' },
      delivery: { kind: 'newTurn', turnId: 'turn-1' },
    })).resolves.toEqual({ status: 'admitted' });

    expect(operations.beginTurnLifecycle).toHaveBeenCalledWith('turn-1');
    expect(events.filter((event) => (
      event.kind === 'input-accepted' || event.kind === 'turn-start'
    ))).toEqual([
      expect.objectContaining({ kind: 'input-accepted' }),
      expect.objectContaining({ kind: 'turn-start', turnId: 'turn-1' }),
    ]);
  });

  it('keeps steer terminal evidence behind exact host input acceptance until provider acknowledgement', async () => {
    const { runtime, operations, publish } = createRuntime();
    const events: Array<{ kind: string; turnId?: string }> = [];
    runtime.watch((event) => events.push(event));
    publish({
      kind: 'turn-start',
      sessionId: 'happier-session-child',
      turnId: 'turn-1',
      emittedAtMs: 10,
    });
    const steerAcknowledgement = createDeferred<Readonly<{
      providerUserMessageId: string;
    }>>();
    operations.steerInFlightTurn.mockReturnValueOnce(steerAcknowledgement.promise);

    const steering = runtime.send({
      inputIds: ['input-steer'],
      input: { text: 'Change direction' },
      delivery: { kind: 'steer', turnId: 'turn-1' },
    });
    publish({
      kind: 'turn-complete',
      sessionId: 'happier-session-child',
      turnId: 'turn-1',
      emittedAtMs: 20,
    });
    expect(events.filter((event) => event.kind === 'turn-complete')).toEqual([]);
    expect(events.filter((event) => event.kind === 'input-accepted')).toEqual([]);

    steerAcknowledgement.resolve({
      providerUserMessageId: 'provider-user-message-steer',
    });
    await expect(steering).resolves.toEqual({ status: 'admitted' });

    expect(events.filter((event) => (
      event.kind === 'input-accepted' || event.kind === 'turn-complete'
    ))).toEqual([
      expect.objectContaining({ kind: 'input-accepted' }),
      expect.objectContaining({ kind: 'turn-complete', turnId: 'turn-1' }),
    ]);
  });

  it('publishes strict native identity, custody, lifecycle, tool, and transcript events', async () => {
    const { runtime, operations, publish } = createRuntime();
    const events: unknown[] = [];
    runtime.watch((event) => events.push(event));

    await expect(runtime.send({
      inputIds: ['input-1'],
      input: { text: 'Implement the cutover' },
      delivery: { kind: 'newTurn', turnId: 'turn-1' },
    })).resolves.toEqual({ status: 'admitted' });

    publish({
      kind: 'turn-start',
      sessionId: 'happier-session-child',
      turnId: 'turn-1',
      emittedAtMs: 10,
    });
    publish({
      kind: 'tool-call',
      sessionId: 'happier-session-child',
      turnId: 'turn-1',
      toolCallId: 'tool-1',
      toolName: 'bash',
      toolInput: { command: 'pwd' },
      emittedAtMs: 11,
    });
    publish({
      kind: 'transcript-agent-message-committed',
      sessionId: 'happier-session-child',
      agentId: 'opencode',
      localId: 'message-1',
      body: { type: 'message', message: 'Done' },
      emittedAtMs: 12,
    });
    publish({
      kind: 'turn-complete',
      sessionId: 'happier-session-child',
      turnId: 'turn-1',
      emittedAtMs: 13,
    });

    expect(operations.sendTurnPrompt).toHaveBeenCalledWith(
      'Implement the cutover',
      expect.objectContaining({
        localInputId: 'input-1',
        localInputIds: ['input-1'],
      }),
    );
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'provider-session-id',
        providerSessionId: 'provider-session-child',
      }),
      expect.objectContaining({
        kind: 'input-accepted',
        inputIds: ['input-1'],
        delivery: { kind: 'newTurn', turnId: 'turn-1' },
      }),
      expect.objectContaining({
        kind: 'tool-call',
        toolCallId: 'tool-1',
        input: { command: 'pwd' },
      }),
      expect.objectContaining({
        kind: 'transcript-message-committed',
        messageId: 'message-1',
        role: 'assistant',
        text: 'Done',
      }),
      expect.objectContaining({ kind: 'turn-complete', turnId: 'turn-1' }),
    ]));
    for (const event of events) {
      expect(AgentSessionRuntimeEventSchema.safeParse(event).success).toBe(true);
    }
  });

  it('preserves a declared runtime issue source in bounded diagnostic details', () => {
    const { runtime, publish } = createRuntime();
    const events: unknown[] = [];
    runtime.watch((event) => events.push(event));

    publish({
      kind: 'turn-failed',
      sessionId: 'happier-session-child',
      turnId: 'turn-permission-denied',
      emittedAtMs: 14,
      issue: {
        v: 1,
        code: 'opencode_permission_denied',
        source: 'permission_blocked',
        occurredAt: 14,
        agentId: 'opencode',
        sanitizedPreview: 'Native denial detail intentionally does not drive host classification.',
      },
    });

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'turn-failed',
        diagnostic: expect.objectContaining({
          code: 'opencode_permission_denied',
          details: {
            v: 1,
            source: 'permission_blocked',
            agentId: 'opencode',
          },
        }),
      }),
    ]));
  });

  it('reports unknown input custody instead of also accepting a failed provider write', async () => {
    const { runtime, operations, publish } = createRuntime();
    const events: Array<{ kind: string }> = [];
    runtime.watch((event) => events.push(event));
    operations.sendTurnPrompt.mockImplementationOnce(async () => {
      publish({
        kind: 'turn-failed',
        sessionId: 'happier-session-child',
        turnId: 'turn-1',
        emittedAtMs: 20,
        issue: {
          v: 1,
          code: 'opencode_prompt_submission_failed',
          source: 'agent_session_error',
          occurredAt: 20,
          agentId: 'opencode',
          sanitizedPreview: 'connection reset',
        },
      });
    });

    await expect(runtime.send({
      inputIds: ['input-1'],
      input: { text: 'Do it' },
      delivery: { kind: 'newTurn', turnId: 'turn-1' },
    })).resolves.toMatchObject({
      status: 'unavailable',
      retryable: false,
    });

    expect(events.some((event) => event.kind === 'input-custody-unknown')).toBe(true);
    expect(events.some((event) => event.kind === 'input-accepted')).toBe(false);
    expect(events.some((event) => event.kind === 'turn-failed')).toBe(false);
  });

  it('preserves a pre-dispatch operations rejection as input-rejected when no ambiguous turn failure was emitted', async () => {
    const { runtime, operations } = createRuntime();
    const events: Array<{ kind: string; inputIds?: readonly string[] }> = [];
    runtime.watch((event) => events.push(event));
    operations.sendTurnPrompt.mockRejectedValueOnce(
      new Error('OpenCode server became unavailable before prompt submission'),
    );

    await expect(runtime.send({
      inputIds: ['input-pre-dispatch-rejected'],
      input: { text: 'Do not dispatch this prompt' },
      delivery: { kind: 'newTurn', turnId: 'turn-pre-dispatch-rejected' },
    })).resolves.toMatchObject({
      status: 'rejected',
      retryable: true,
      diagnostic: { code: 'opencode_input_rejected' },
    });

    expect(events.filter((event) => (
      event.kind === 'input-rejected'
      || event.kind === 'input-custody-unknown'
      || event.kind === 'input-accepted'
    ))).toEqual([
      expect.objectContaining({
        kind: 'input-rejected',
        inputIds: ['input-pre-dispatch-rejected'],
      }),
    ]);
    expect(operations.sendTurnPrompt).toHaveBeenCalledTimes(1);
  });

  it('delegates cancellation, configuration, and disposal to the one OpenCode owner', async () => {
    const { runtime, operations, publish, disposeOperations } = createRuntime();
    runtime.watch(() => undefined);
    publish({
      kind: 'turn-start',
      sessionId: 'happier-session-child',
      turnId: 'turn-1',
      emittedAtMs: 10,
    });

    await expect(runtime.cancel?.({
      turnId: 'turn-1',
      reason: 'user',
    })).resolves.toEqual({ status: 'requested', turnId: 'turn-1' });
    expect(operations.cancelTurn).toHaveBeenCalledTimes(1);

    await expect(runtime.updateConfiguration?.({
      mode: { value: null, updatedAtMs: 1 },
      model: { value: 'anthropic/sonnet', updatedAtMs: 1 },
      permissionIntent: { value: 'safe-yolo', updatedAtMs: 1 },
      options: {},
    })).resolves.toEqual({
      status: 'deferred',
      changed: ['model', 'permissionIntent'],
    });
    expect(operations.updateSessionRuntimeConfig).toHaveBeenCalledWith({
      modelId: 'anthropic/sonnet',
      permissionMode: 'safe-yolo',
    });

    await runtime.dispose();
    expect(disposeOperations).toHaveBeenCalledTimes(1);
  });

  it('binds the private active skills reader to the host session and releases it on dispose', async () => {
    let readSkills: (() => Promise<unknown>) | null = null;
    const disposeBinding = vi.fn();
    const bindActiveSkillsReader = vi.fn((sessionId: string, reader: () => Promise<unknown>) => {
      readSkills = reader;
      return { dispose: disposeBinding };
    });
    const { runtime, operations } = createRuntime({ bindActiveSkillsReader });
    operations.listSkills.mockResolvedValueOnce([{
      name: 'reviewer',
      displayName: 'Reviewer',
      enabled: true,
    }]);

    expect(bindActiveSkillsReader).toHaveBeenCalledWith(
      'happier-session-child',
      expect.any(Function),
    );
    await expect(readSkills?.()).resolves.toEqual([{
      name: 'reviewer',
      displayName: 'reviewer',
      enabled: true,
      origin: 'opencode_native',
    }]);

    await runtime.dispose();
    expect(disposeBinding).toHaveBeenCalledTimes(1);
  });

  it('returns a typed rejection instead of claiming an unselectable model was applied', async () => {
    const { runtime, operations } = createRuntime();
    operations.updateSessionRuntimeConfig.mockRejectedValueOnce(
      new Error('OpenCode model is not selectable'),
    );

    await expect(runtime.updateConfiguration?.({
      mode: { value: null, updatedAtMs: 1 },
      model: { value: 'missing/model', updatedAtMs: 1 },
      permissionIntent: { value: 'default', updatedAtMs: 1 },
      options: {},
    })).resolves.toMatchObject({
      status: 'rejected',
      diagnostic: { code: 'opencode_configuration_rejected' },
    });
  });

  it('publishes the effective model only after the provider accepts a prompt using it', async () => {
    let modelSource: {
      read(): Readonly<{
        models: readonly Readonly<{ id: string; name: string }>[];
        currentModelId?: string | null;
      }>;
      subscribe(listener: (snapshot: Readonly<{
        models: readonly Readonly<{ id: string; name: string }>[];
        currentModelId?: string | null;
      }>) => void): Readonly<{ dispose(): void }>;
    } | null = null;
    const disposeModels = vi.fn();
    const models = {
      bind: vi.fn((source) => {
        modelSource = source;
        return { dispose: disposeModels };
      }),
    };
    const { runtime, operations } = createRuntime({ models });
    operations.sendTurnPrompt.mockResolvedValueOnce({
      providerUserMessageId: 'provider-user-message-model',
      effectiveModelId: 'anthropic/sonnet',
    });

    expect(modelSource?.read()).toEqual({ models: [], currentModelId: null });
    await runtime.send({
      inputIds: ['input-model'],
      input: { text: 'Use Sonnet' },
      delivery: { kind: 'newTurn', turnId: 'turn-model' },
    });

    expect(modelSource?.read()).toEqual({
      models: [{ id: 'anthropic/sonnet', name: 'anthropic/sonnet' }],
      currentModelId: 'anthropic/sonnet',
    });
    await runtime.dispose();
    expect(disposeModels).toHaveBeenCalledTimes(1);
  });

  it('fails closed when manual compaction instructions cannot be represented by OpenCode', async () => {
    const { runtime, operations } = createRuntime();

    await expect(runtime.compact?.({
      compactionId: 'compact-1',
      instructions: 'Keep the release evidence.',
    })).resolves.toMatchObject({
      status: 'unsupported',
      retryable: false,
      diagnostic: {
        code: 'opencode_compaction_instructions_unsupported',
      },
    });

    expect(operations.compactContext).not.toHaveBeenCalled();
  });

  it('publishes the prior completed turn checkpoint as the next OpenCode-exclusive message cursor', async () => {
    const { runtime, operations, publish } = createRuntime();
    const events: Array<{
      kind: string;
      turnId?: string;
      providerCheckpoint?: unknown;
    }> = [];
    runtime.watch((event) => events.push(event));

    await runtime.send({
      inputIds: ['input-1'],
      input: { text: 'First' },
      delivery: { kind: 'newTurn', turnId: 'turn-1' },
    });
    publish({
      kind: 'turn-complete',
      sessionId: 'happier-session-child',
      turnId: 'turn-1',
      emittedAtMs: 10,
    });
    operations.sendTurnPrompt.mockResolvedValueOnce({
      providerUserMessageId: 'provider-next-user-message',
    });
    await runtime.send({
      inputIds: ['input-2'],
      input: { text: 'Second' },
      delivery: { kind: 'newTurn', turnId: 'turn-2' },
    });

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'turn-rollback-boundary',
        turnId: 'turn-1',
        providerCheckpoint: {
          kind: 'opencode_exclusive_message_id',
          messageId: 'provider-next-user-message',
        },
      }),
    ]));
  });

  it('does not replace the prior rollback boundary with a synchronously completed current turn', async () => {
    const { runtime, operations, publish } = createRuntime();
    const events: Array<{
      kind: string;
      turnId?: string;
      providerCheckpoint?: unknown;
    }> = [];
    runtime.watch((event) => events.push(event));

    await runtime.send({
      inputIds: ['input-1'],
      input: { text: 'First' },
      delivery: { kind: 'newTurn', turnId: 'turn-1' },
    });
    publish({
      kind: 'turn-complete',
      sessionId: 'happier-session-child',
      turnId: 'turn-1',
      emittedAtMs: 10,
    });
    operations.sendTurnPrompt.mockImplementationOnce(async () => {
      publish({
        kind: 'turn-start',
        sessionId: 'happier-session-child',
        turnId: 'turn-2',
        emittedAtMs: 20,
      });
      publish({
        kind: 'turn-complete',
        sessionId: 'happier-session-child',
        turnId: 'turn-2',
        emittedAtMs: 21,
      });
      return {
        providerUserMessageId: 'provider-next-user-message',
      };
    });

    await expect(runtime.send({
      inputIds: ['input-2'],
      input: { text: 'Second' },
      delivery: { kind: 'newTurn', turnId: 'turn-2' },
    })).resolves.toEqual({ status: 'admitted' });
    operations.sendTurnPrompt.mockResolvedValueOnce({
      providerUserMessageId: 'provider-third-user-message',
    });
    await expect(runtime.send({
      inputIds: ['input-3'],
      input: { text: 'Third' },
      delivery: { kind: 'newTurn', turnId: 'turn-3' },
    })).resolves.toEqual({ status: 'admitted' });

    expect(events.filter((event) => event.kind === 'turn-rollback-boundary')).toEqual([
      expect.objectContaining({
        kind: 'turn-rollback-boundary',
        turnId: 'turn-1',
        providerCheckpoint: {
          kind: 'opencode_exclusive_message_id',
          messageId: 'provider-next-user-message',
        },
      }),
      expect.objectContaining({
        kind: 'turn-rollback-boundary',
        turnId: 'turn-2',
        providerCheckpoint: {
          kind: 'opencode_exclusive_message_id',
          messageId: 'provider-third-user-message',
        },
      }),
    ]);
  });

  it('terminates the exact provider turn when pre-admission buffering fails even if cancellation publication fails', async () => {
    const { runtime, operations, publish } = createRuntime();
    const events: Array<{ kind: string }> = [];
    runtime.watch((event) => events.push(event));
    operations.sendTurnPrompt.mockImplementationOnce(async () => {
      const maxEvents = AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1
        .p0MeasuredCandidates
        .preWatchReplayBufferMaxEvents;
      for (let index = 0; index <= maxEvents; index += 1) {
        publish({
          kind: 'transcript-agent-message-committed',
          sessionId: 'happier-session-child',
          agentId: 'opencode',
          localId: `buffered-message-${index}`,
          body: { type: 'message', message: `Buffered ${index}` },
          emittedAtMs: 30 + index,
        });
      }
      return {
        providerUserMessageId: 'provider-overflow-message',
      };
    });
    operations.cancelTurn.mockImplementationOnce(async () => {
      publish({
        kind: 'turn-cancelled',
        sessionId: 'happier-session-child',
        turnId: 'turn-overflow',
        emittedAtMs: 100,
        reason: 'cancelled',
      });
      publish({
        kind: 'tool-call',
        sessionId: 'happier-session-child',
        turnId: 'turn-overflow',
        toolCallId: 'late-tool',
        toolName: 'bash',
        toolInput: { command: 'pwd' },
        emittedAtMs: 101,
      });
      throw new Error('cancellation publication failed');
    });

    await expect(runtime.send({
      inputIds: ['input-overflow'],
      input: { text: 'Overflow the pre-admission buffer' },
      delivery: { kind: 'newTurn', turnId: 'turn-overflow' },
    })).resolves.toMatchObject({
      status: 'unavailable',
      retryable: false,
      diagnostic: { code: 'opencode_pre_admission_event_buffer_failed' },
    });

    expect(operations.cancelTurn).toHaveBeenCalledTimes(1);
    expect(events.filter((event) => (
      event.kind === 'input-custody-unknown'
      || event.kind === 'input-accepted'
      || event.kind === 'input-rejected'
      || event.kind === 'turn-cancelled'
      || event.kind === 'tool-call'
      || event.kind === 'transcript-message-committed'
    ))).toEqual([
      expect.objectContaining({ kind: 'input-custody-unknown' }),
    ]);
  });

  it('returns unknown custody and releases pending buffered state when disposed during provider acknowledgement', async () => {
    const { runtime, operations, publish, disposeOperations } = createRuntime();
    const events: Array<{ kind: string; inputIds?: readonly string[] }> = [];
    runtime.watch((event) => events.push(event));
    const promptAcknowledgement = createDeferred<Readonly<{
      providerUserMessageId: string;
    }>>();
    operations.sendTurnPrompt.mockReturnValueOnce(promptAcknowledgement.promise);

    const sending = runtime.send({
      inputIds: ['input-disposed'],
      input: { text: 'Wait for provider acknowledgement' },
      delivery: { kind: 'newTurn', turnId: 'turn-disposed' },
    });
    publish({
      kind: 'turn-start',
      sessionId: 'happier-session-child',
      turnId: 'turn-disposed',
      emittedAtMs: 40,
    });

    await runtime.dispose();
    expect(events.filter((event) => event.kind === 'input-custody-unknown')).toEqual([
      expect.objectContaining({
        kind: 'input-custody-unknown',
        inputIds: ['input-disposed'],
      }),
    ]);
    promptAcknowledgement.resolve({
      providerUserMessageId: 'provider-disposed-message',
    });

    await expect(sending).resolves.toMatchObject({
      status: 'unavailable',
      retryable: false,
      diagnostic: { code: 'opencode_input_custody_unknown' },
    });
    expect(disposeOperations).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.kind === 'input-accepted')).toBe(false);
    expect(events.some((event) => event.kind === 'input-rejected')).toBe(false);
    expect(events.some((event) => event.kind === 'turn-start')).toBe(false);
  });

  it('returns unknown custody when a projection listener disposes before input acceptance', async () => {
    let modelSource: {
      read(): Readonly<{
        models: readonly Readonly<{ id: string; name: string }>[];
        currentModelId?: string | null;
      }>;
      subscribe(listener: (snapshot: Readonly<{
        models: readonly Readonly<{ id: string; name: string }>[];
        currentModelId?: string | null;
      }>) => void): Readonly<{ dispose(): void }>;
    } | null = null;
    const models = {
      bind: vi.fn((source) => {
        modelSource = source;
        return { dispose: vi.fn() };
      }),
    };
    const { runtime, operations } = createRuntime({ models });
    const events: Array<{ kind: string; inputIds?: readonly string[] }> = [];
    runtime.watch((event) => events.push(event));
    modelSource?.subscribe((snapshot) => {
      if (snapshot.currentModelId) void runtime.dispose();
    });
    operations.sendTurnPrompt.mockResolvedValueOnce({
      providerUserMessageId: 'provider-projection-dispose-message',
      effectiveModelId: 'anthropic/sonnet',
    });

    await expect(runtime.send({
      inputIds: ['input-projection-dispose'],
      input: { text: 'Dispose from the model projection' },
      delivery: { kind: 'newTurn', turnId: 'turn-projection-dispose' },
    })).resolves.toMatchObject({
      status: 'unavailable',
      retryable: false,
      diagnostic: { code: 'opencode_input_custody_unknown' },
    });
    expect(events.filter((event) => (
      event.kind === 'input-custody-unknown'
      || event.kind === 'input-accepted'
      || event.kind === 'input-rejected'
    ))).toEqual([
      expect.objectContaining({
        kind: 'input-custody-unknown',
        inputIds: ['input-projection-dispose'],
      }),
    ]);
  });

  it('does not misreport a waiting follow-up as rejected when disposal happens before provider work', async () => {
    const { runtime, operations, publish } = createRuntime();
    const events: Array<{ kind: string; inputIds?: readonly string[] }> = [];
    runtime.watch((event) => events.push(event));
    await runtime.send({
      inputIds: ['input-active'],
      input: { text: 'Keep working' },
      delivery: { kind: 'newTurn', turnId: 'turn-active' },
    });
    publish({
      kind: 'turn-start',
      sessionId: 'happier-session-child',
      turnId: 'turn-active',
      emittedAtMs: 50,
    });
    const turnCompletion = createDeferred<void>();
    operations.waitForTurnCompletion.mockReturnValueOnce(turnCompletion.promise);

    const following = runtime.send({
      inputIds: ['input-following'],
      input: { text: 'Afterward' },
      delivery: {
        kind: 'followUp',
        turnId: 'turn-following',
        afterTurnId: 'turn-active',
      },
    });
    publish({
      kind: 'turn-failed',
      sessionId: 'happier-session-child',
      turnId: 'turn-active',
      emittedAtMs: 51,
      issue: {
        v: 1,
        code: 'opencode_prompt_submission_failed',
        source: 'agent_session_error',
        occurredAt: 51,
        agentId: 'opencode',
        sanitizedPreview: 'prior active turn failed',
      },
    });
    expect(events.some((event) => (
      event.kind === 'input-custody-unknown'
      && event.inputIds?.includes('input-following')
    ))).toBe(false);
    await runtime.dispose();
    turnCompletion.resolve();

    await expect(following).resolves.toMatchObject({
      status: 'unavailable',
      retryable: false,
      diagnostic: { code: 'opencode_runtime_disposed' },
    });
    expect(operations.sendTurnPrompt).toHaveBeenCalledTimes(1);
    expect(events.some((event) => (
      (
        event.kind === 'input-accepted'
        || event.kind === 'input-rejected'
        || event.kind === 'input-custody-unknown'
      )
      && event.inputIds?.includes('input-following')
    ))).toBe(false);
  });

  it('rejects competing sends before a second provider write without overwriting first-send custody', async () => {
    const { runtime, operations } = createRuntime();
    const events: Array<{ kind: string; inputIds?: readonly string[] }> = [];
    runtime.watch((event) => events.push(event));
    const promptAcknowledgement = createDeferred<Readonly<{
      providerUserMessageId: string;
    }>>();
    operations.sendTurnPrompt.mockReturnValueOnce(promptAcknowledgement.promise);

    const firstSend = runtime.send({
      inputIds: ['input-first'],
      input: { text: 'First provider write' },
      delivery: { kind: 'newTurn', turnId: 'turn-first' },
    });
    const competingRequests = [
      {
        inputIds: ['input-new-turn'],
        input: { text: 'Competing new turn' },
        delivery: { kind: 'newTurn', turnId: 'turn-new' },
      },
      {
        inputIds: ['input-steer'],
        input: { text: 'Competing steer' },
        delivery: { kind: 'steer', turnId: 'turn-first' },
      },
      {
        inputIds: ['input-follow-up'],
        input: { text: 'Competing follow-up' },
        delivery: {
          kind: 'followUp',
          turnId: 'turn-follow-up',
          afterTurnId: 'turn-first',
        },
      },
    ] as const;

    for (const request of competingRequests) {
      await expect(runtime.send(request)).resolves.toMatchObject({
        status: 'unavailable',
        retryable: true,
        diagnostic: { code: 'opencode_input_submission_in_flight' },
      });
    }
    expect(operations.sendTurnPrompt).toHaveBeenCalledTimes(1);
    expect(operations.steerInFlightTurn).not.toHaveBeenCalled();
    expect(events.some((event) => (
      event.inputIds?.some((inputId) => inputId !== 'input-first')
    ))).toBe(false);

    promptAcknowledgement.resolve({
      providerUserMessageId: 'provider-first-message',
    });
    await expect(firstSend).resolves.toEqual({ status: 'admitted' });
    expect(events.filter((event) => (
      event.kind === 'input-accepted'
      || event.kind === 'input-rejected'
      || event.kind === 'input-custody-unknown'
    ))).toEqual([
      expect.objectContaining({
        kind: 'input-accepted',
        inputIds: ['input-first'],
      }),
    ]);
  });

  it('allows an active-turn steer while a follow-up waits before provider submission', async () => {
    const { runtime, operations, publish } = createRuntime();
    await runtime.send({
      inputIds: ['input-active'],
      input: { text: 'Keep working' },
      delivery: { kind: 'newTurn', turnId: 'turn-active' },
    });
    publish({
      kind: 'turn-start',
      sessionId: 'happier-session-child',
      turnId: 'turn-active',
      emittedAtMs: 60,
    });
    const turnCompletion = createDeferred<void>();
    operations.waitForTurnCompletion.mockReturnValueOnce(turnCompletion.promise);

    const following = runtime.send({
      inputIds: ['input-following'],
      input: { text: 'Afterward' },
      delivery: {
        kind: 'followUp',
        turnId: 'turn-following',
        afterTurnId: 'turn-active',
      },
    });
    await expect(runtime.send({
      inputIds: ['input-steer'],
      input: { text: 'Change direction now' },
      delivery: { kind: 'steer', turnId: 'turn-active' },
    })).resolves.toEqual({ status: 'admitted' });

    publish({
      kind: 'turn-complete',
      sessionId: 'happier-session-child',
      turnId: 'turn-active',
      emittedAtMs: 61,
    });
    turnCompletion.resolve();
    await expect(following).resolves.toEqual({ status: 'admitted' });
    expect(operations.steerInFlightTurn).toHaveBeenCalledTimes(1);
    expect(operations.sendTurnPrompt).toHaveBeenCalledTimes(2);
  });

  it('admits a follow-up only after the active turn reaches provider terminal evidence', async () => {
    const { runtime, operations, publish } = createRuntime();
    const events: Array<{ kind: string; inputIds?: readonly string[] }> = [];
    runtime.watch((event) => events.push(event));
    await runtime.send({
      inputIds: ['input-1'],
      input: { text: 'First' },
      delivery: { kind: 'newTurn', turnId: 'turn-1' },
    });
    publish({
      kind: 'turn-start',
      sessionId: 'happier-session-child',
      turnId: 'turn-1',
      emittedAtMs: 10,
    });
    operations.waitForTurnCompletion.mockImplementationOnce(async () => {
      publish({
        kind: 'turn-complete',
        sessionId: 'happier-session-child',
        turnId: 'turn-1',
        emittedAtMs: 20,
      });
    });

    await expect(runtime.send({
      inputIds: ['input-follow-up'],
      input: { text: 'Continue' },
      delivery: {
        kind: 'followUp',
        turnId: 'turn-2',
        afterTurnId: 'turn-1',
      },
    })).resolves.toEqual({ status: 'admitted' });

    expect(operations.waitForTurnCompletion).toHaveBeenCalled();
    expect(operations.beginTurnLifecycle).toHaveBeenCalled();
    expect(operations.sendTurnPrompt).toHaveBeenCalledWith(
      'Continue',
      expect.objectContaining({ localInputId: 'input-follow-up' }),
    );
    const priorTurnCompleteIndex = events.findIndex((event) => event.kind === 'turn-complete');
    const followUpAcceptedIndex = events.findIndex((event) => (
      event.kind === 'input-accepted' && event.inputIds?.includes('input-follow-up')
    ));
    expect(priorTurnCompleteIndex).toBeGreaterThanOrEqual(0);
    expect(followUpAcceptedIndex).toBeGreaterThan(priorTurnCompleteIndex);
  });

  it('rejects unsupported structured input before beginning a provider turn', async () => {
    const { runtime, operations } = createRuntime();

    await expect(runtime.send({
      inputIds: ['input-unsafe-image'],
      input: {
        text: '',
        structuredInput: {
          v: 1,
          imageInputs: [{
            id: 'image-unsafe',
            kind: 'image',
            url: 'javascript:alert(1)',
          }],
        },
      },
      delivery: { kind: 'newTurn', turnId: 'turn-unsafe-image' },
    })).resolves.toMatchObject({
      status: 'rejected',
      retryable: false,
    });

    expect(operations.beginTurnLifecycle).not.toHaveBeenCalled();
    expect(operations.sendTurnPrompt).not.toHaveBeenCalled();
  });
});
