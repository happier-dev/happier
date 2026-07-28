import { describe, expect, it } from 'vitest';

import { createFakeAcpRuntimeBackend } from '@/testkit/backends/acpRuntimeBackend';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createBasicSessionClient, createBasicSessionClientWithOverrides } from '@/testkit/backends/sessionFixtures';
import { createTestAcpRuntime as createAcpRuntime } from '@/testkit/backends/acpRuntime';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import type { SessionTurnMutationV1 } from '@/api/session/mutations/sessionMutationTypes';
import { createSessionTurnLifecycle } from '@/agent/runtime/session/turn/lifecycle';

describe('createAcpRuntime (turn hooks)', () => {
  async function waitForFlushBoundaryProbe(params: {
    hasCompletedProjection: () => boolean;
    didFlushResolve: () => boolean;
  }): Promise<void> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (params.hasCompletedProjection() || params.didFlushResolve()) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  async function waitForRuntimeSideEffect(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (predicate()) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  it('invokes turn hooks and allows emitting additional tool calls before task_complete', async () => {
    const backend = createFakeAcpRuntimeBackend();
    const sent: any[] = [];

    const session = createBasicSessionClientWithOverrides({
      sendAgentMessage: (_provider, body) => {
        sent.push(body);
      },
    });

    const runtime = createAcpRuntime({
      provider: 'opencode',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
      hooks: {
        onBeginTurn: () => {
          sent.push({ type: 'hook', name: 'begin' });
        },
        onToolResult: ({ toolName }: any) => {
          sent.push({ type: 'hook', name: 'tool-result', toolName });
        },
        onBeforeFlushTurn: ({ sendToolCall, sendToolResult }: any) => {
          const callId = sendToolCall({ toolName: 'Diff', input: { files: [] } });
          sendToolResult({ callId, output: { status: 'completed' } });
        },
      },
    });

    await runtime.startOrLoad({ resumeId: null });

    runtime.beginTurn();

    backend.emit({ type: 'tool-call', toolName: 'Edit', args: { file_path: 'a.txt' }, callId: 't1' });
    backend.emit({ type: 'tool-result', toolName: 'Edit', callId: 't1', result: { ok: true } });

    await runtime.flushTurn();

    const taskCompleteIdx = sent.findIndex((m) => m?.type === 'task_complete');
    expect(taskCompleteIdx).toBeGreaterThan(-1);

    const hookBeginIdx = sent.findIndex((m) => m?.type === 'hook' && m?.name === 'begin');
    expect(hookBeginIdx).toBeGreaterThan(-1);

    const hookToolResultIdx = sent.findIndex((m) => m?.type === 'hook' && m?.name === 'tool-result' && m?.toolName === 'Edit');
    expect(hookToolResultIdx).toBeGreaterThan(-1);

    const diffToolCallIdx = sent.findIndex((m) => m?.type === 'tool-call' && m?.name === 'Diff');
    const diffToolResultIdx = sent.findIndex((m) => m?.type === 'tool-result' && m?.callId && m?.output?.status === 'completed');
    expect(diffToolCallIdx).toBeGreaterThan(-1);
    expect(diffToolResultIdx).toBeGreaterThan(-1);

    expect(diffToolCallIdx).toBeLessThan(taskCompleteIdx);
    expect(diffToolResultIdx).toBeLessThan(taskCompleteIdx);
  });

  it('uses one provider turn id for task start, task completion, and completed projection', async () => {
    const backend = createFakeAcpRuntimeBackend();
    const sent: any[] = [];
    const completedTurns: any[] = [];

    const session = createBasicSessionClientWithOverrides({
      sendAgentMessage: (_provider, body) => {
        sent.push(body);
      },
      sessionTurnLifecycle: {
        beginTurn: async () => ({ turnId: 'session-turn-1' }),
        attachProviderTurnId: async () => {},
        appendTranscriptAnchors: async () => {},
        completeTurn: async (record) => {
          completedTurns.push(record);
        },
        failTurn: async () => {},
        cancelTurn: async () => {},
        endSession: async () => {},
        markRollbackEligible: async () => {},
        markRolledBack: async () => {},
        touchActiveTurn: async () => {},
        hasActiveTurn: () => false,
      },
    });

    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({ resumeId: null });
    runtime.beginTurn();
    backend.emit({ type: 'status', status: 'running' });
    await runtime.flushTurn();

    const taskStarted = sent.find((message) => message?.type === 'task_started');
    const taskComplete = sent.find((message) => message?.type === 'task_complete');
    expect(taskStarted?.id).toEqual(expect.any(String));
    expect(taskComplete?.id).toBe(taskStarted.id);
    expect(completedTurns).toContainEqual(expect.objectContaining({
      provider: 'pi',
      providerTurnId: taskStarted.id,
    }));
  });

  it('emits a session-owned failure marker when status:error happens before task_started', async () => {
    const backend = createFakeAcpRuntimeBackend();
    const sent: any[] = [];
    const failedTurns: any[] = [];

    const session = createBasicSessionClientWithOverrides({
      sendAgentMessage: (_provider, body) => {
        sent.push(body);
      },
      sessionTurnLifecycle: {
        beginTurn: async () => ({ turnId: 'session-turn-1' }),
        attachProviderTurnId: async () => {},
        appendTranscriptAnchors: async () => {},
        completeTurn: async () => {},
        failTurn: async (record) => {
          failedTurns.push(record);
        },
        cancelTurn: async () => {},
        endSession: async () => {},
        markRollbackEligible: async () => {},
        markRolledBack: async () => {},
        touchActiveTurn: async () => {},
        hasActiveTurn: () => false,
      },
    });

    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({ resumeId: null });
    runtime.beginTurn();
    backend.emit({ type: 'status', status: 'error', detail: 'Model not found.' });

    await waitForRuntimeSideEffect(() => (
      sent.some((message) => message?.type === 'turn_failed')
      && failedTurns.length > 0
    ));

    const turnFailed = sent.find((message) => message?.type === 'turn_failed');
    const failedProjection = failedTurns[0];
    expect(sent.some((message) => message?.type === 'task_started')).toBe(false);
    expect(turnFailed?.id).toBe('session-turn-1');
    expect(failedProjection?.providerTurnId).toEqual(expect.any(String));
    expect(failedProjection?.providerTurnId).not.toBe(turnFailed.id);
  });

  it('waits for completed primary-turn projection before flushTurn resolves', async () => {
    const backend = createFakeAcpRuntimeBackend();
    const sent: any[] = [];
    const completedTurns: any[] = [];
    let resolveCompletedProjection!: () => void;
    const completedProjection = new Promise<void>((resolve) => {
      resolveCompletedProjection = resolve;
    });
    let didFlushResolve = false;

    const session = createBasicSessionClientWithOverrides({
      sendAgentMessage: (_provider, body) => {
        sent.push(body);
      },
      sessionTurnLifecycle: {
        beginTurn: async () => ({ turnId: 'session-turn-1' }),
        attachProviderTurnId: async () => {},
        appendTranscriptAnchors: async () => {},
        completeTurn: async (record) => {
          completedTurns.push(record);
          await completedProjection;
        },
        failTurn: async () => {},
        cancelTurn: async () => {},
        endSession: async () => {},
        markRollbackEligible: async () => {},
        markRolledBack: async () => {},
        touchActiveTurn: async () => {},
        hasActiveTurn: () => false,
      },
    });

    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({ resumeId: null });
    runtime.beginTurn();

    const flushPromise = runtime.flushTurn().then(() => {
      didFlushResolve = true;
    });
    await waitForFlushBoundaryProbe({
      hasCompletedProjection: () => completedTurns.length > 0,
      didFlushResolve: () => didFlushResolve,
    });

    expect(sent.some((m) => m?.type === 'task_complete')).toBe(true);
    expect(completedTurns).toContainEqual(expect.objectContaining({
      provider: 'pi',
    }));
    expect(didFlushResolve).toBe(false);

    resolveCompletedProjection();
    await flushPromise;

    expect(didFlushResolve).toBe(true);
  });

  it('opens and completes a lifecycle turn when flush happens before task_started', async () => {
    const backend = createFakeAcpRuntimeBackend();
    const mutations: SessionTurnMutationV1[] = [];
    const sessionTurnLifecycle = createSessionTurnLifecycle({
      sessionId: 'happy-session-1',
      createId: () => 'turn-1',
      now: () => 123,
      enqueueSessionTurn: async (mutation) => {
        mutations.push(mutation);
      },
    });

    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session: {
        ...createBasicSessionClient(),
        sessionTurnLifecycle,
      },
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({ resumeId: null });
    runtime.beginTurn();
    await runtime.sendPrompt('hi');
    await runtime.flushTurn();

    expect(mutations).toEqual([
      expect.objectContaining({
        action: 'begin',
        turnId: 'session-turn:turn-1',
        provider: 'pi',
      }),
      expect.objectContaining({
        action: 'complete',
        turnId: 'session-turn:turn-1',
        provider: 'pi',
      }),
    ]);
  });

  it('records a cancelled lifecycle turn when ACP reports a cancelled stop reason', async () => {
    const backend = createFakeAcpRuntimeBackend({
      waitForResponseComplete: async () => ({ kind: 'aborted', stopReason: 'cancelled' }),
    });
    const mutations: SessionTurnMutationV1[] = [];
    const sent: any[] = [];
    const sessionTurnLifecycle = createSessionTurnLifecycle({
      sessionId: 'happy-session-1',
      createId: () => 'turn-1',
      now: () => 123,
      enqueueSessionTurn: async (mutation) => {
        mutations.push(mutation);
      },
    });

    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session: {
        ...createBasicSessionClient(),
        sendAgentMessage: (_provider, body) => {
          sent.push(body);
        },
        sessionTurnLifecycle,
      },
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({ resumeId: null });
    runtime.beginTurn();
    await runtime.sendPrompt('hi');
    await runtime.flushTurn();

    expect(sent.some((message) => message?.type === 'task_complete')).toBe(false);
    expect(sent).toContainEqual(expect.objectContaining({
      type: 'turn_cancelled',
      id: expect.any(String),
    }));
    expect(mutations).toEqual([
      expect.objectContaining({ action: 'begin' }),
      expect.objectContaining({ action: 'cancel' }),
    ]);
  });

  it('records an aborted lifecycle turn when ACP reports a refusal stop reason', async () => {
    const backend = createFakeAcpRuntimeBackend({
      waitForResponseComplete: async () => ({ kind: 'refused', stopReason: 'refusal' }),
    });
    const mutations: SessionTurnMutationV1[] = [];
    const sent: any[] = [];
    const sessionTurnLifecycle = createSessionTurnLifecycle({
      sessionId: 'happy-session-1',
      createId: () => 'turn-1',
      now: () => 123,
      enqueueSessionTurn: async (mutation) => {
        mutations.push(mutation);
      },
    });

    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session: {
        ...createBasicSessionClient(),
        sendAgentMessage: (_provider, body) => {
          sent.push(body);
        },
        sessionTurnLifecycle,
      },
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({ resumeId: null });
    runtime.beginTurn();
    await runtime.sendPrompt('hi');
    await runtime.flushTurn();

    expect(sent.some((message) => message?.type === 'task_complete')).toBe(false);
    expect(sent).toContainEqual(expect.objectContaining({
      type: 'turn_aborted',
      id: expect.any(String),
    }));
    expect(mutations).toEqual([
      expect.objectContaining({ action: 'begin' }),
      expect.objectContaining({ action: 'cancel' }),
    ]);
  });

  it('treats think tool calls as thinking (does not invoke onToolResult)', async () => {
    const backend = createFakeAcpRuntimeBackend();
    const sent: any[] = [];

    const session = createBasicSessionClientWithOverrides({
      sendAgentMessage: (_provider, body) => {
        sent.push(body);
      },
    });

    const runtime = createAcpRuntime({
      provider: 'opencode',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
      hooks: {
        onToolResult: ({ toolName }: any) => {
          sent.push({ type: 'hook', name: 'tool-result', toolName });
        },
      },
    });

    await runtime.startOrLoad({ resumeId: null });

    runtime.beginTurn();
    backend.emit({ type: 'tool-call', toolName: 'think', args: { thinking: 'Hello' }, callId: 't1' });
    backend.emit({ type: 'tool-result', toolName: 'think', callId: 't1', result: { ok: true } });
    await runtime.flushTurn();

    expect(sent.some((m) => m?.type === 'tool-call' && String(m?.name ?? '').toLowerCase() === 'think')).toBe(false);
    expect(sent.some((m) => m?.type === 'tool-result' && m?.callId === 't1')).toBe(false);
    expect(sent).toContainEqual({ type: 'thinking', text: 'Hello' });
    expect(sent.some((m) => m?.type === 'hook' && m?.name === 'tool-result' && m?.toolName === 'think')).toBe(false);
  });

  it('clears in-flight turn state on cancel', async () => {
    const backend = createFakeAcpRuntimeBackend();

    const runtime = createAcpRuntime({
      provider: 'opencode',
      directory: '/tmp',
      session: createBasicSessionClient(),
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({ resumeId: null });

    runtime.beginTurn();
    expect(runtime.isTurnInFlight()).toBe(true);

    await runtime.cancel();
    expect(runtime.isTurnInFlight()).toBe(false);
  });

  it('cancels a lifecycle turn when cancel happens before task_started', async () => {
    const backend = createFakeAcpRuntimeBackend();
    const mutations: SessionTurnMutationV1[] = [];
    const sessionTurnLifecycle = createSessionTurnLifecycle({
      sessionId: 'happy-session-1',
      createId: () => 'turn-1',
      now: () => 123,
      enqueueSessionTurn: async (mutation) => {
        mutations.push(mutation);
      },
    });

    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session: {
        ...createBasicSessionClient(),
        sessionTurnLifecycle,
      },
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({ resumeId: null });
    runtime.beginTurn();
    await runtime.cancel();

    expect(mutations).toEqual([
      expect.objectContaining({
        action: 'begin',
        turnId: 'session-turn:turn-1',
        provider: 'pi',
      }),
      expect.objectContaining({
        action: 'cancel',
        turnId: 'session-turn:turn-1',
        provider: 'pi',
      }),
    ]);
  });
});
