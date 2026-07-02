import { describe, expect, it, vi } from 'vitest';
import { RuntimeEventV1Schema } from '@happier-dev/protocol';

import { createAcpRuntime } from '../createAcpRuntime';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { isRuntimeTurnOperations } from '@/agent/runtime/turns/runtimeTurnOperations';
import { createFakeAcpRuntimeBackend } from '@/testkit/backends/acpRuntimeBackend';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createBasicSessionClient } from '@/testkit/backends/sessionFixtures';

describe('createAcpRuntime (native lower-operation surface)', () => {
  it('implements RuntimeTurnOperations directly on the ACP runtime leaf', async () => {
    const startSession = vi.fn(async () => ({ sessionId: 'acp-session-1' }));
    const sendPrompt = vi.fn(async () => undefined);
    const setSessionMode = vi.fn(async () => undefined);
    const setSessionModel = vi.fn(async () => undefined);
    const setSessionConfigOption = vi.fn(async () => undefined);
    const cancel = vi.fn(async () => undefined);
    const dispose = vi.fn(async () => undefined);
    const waitForResponseComplete = vi.fn(async (_timeoutMs?: number | null) => undefined);

    const runtime = createAcpRuntime({
      provider: 'gemini',
      directory: '/tmp',
      session: createBasicSessionClient(),
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => createFakeAcpRuntimeBackend({
        startSession,
        sendPrompt,
        setSessionMode,
        setSessionModel,
        setSessionConfigOption,
        cancel,
        dispose,
        waitForResponseComplete,
      }),
    });

    expect(isRuntimeTurnOperations(runtime)).toBe(true);
    if (!isRuntimeTurnOperations(runtime)) {
      throw new Error('Expected ACP runtime to satisfy RuntimeTurnOperations');
    }

    await runtime.startOrLoadSession();
    runtime.beginTurnLifecycle();
    await runtime.sendTurnPrompt('hello');
    await runtime.updateSessionRuntimeConfig({
      modeId: 'plan',
      modelId: 'gemini-2.5-pro',
      configOption: { id: 'reasoning_effort', value: 'high' },
    });
    await runtime.cancelTurn();
    await runtime.resetOrDisposeRuntime();

    expect(runtime.readSessionIdentity()).toEqual({ sessionId: null });
    expect(startSession).toHaveBeenCalledTimes(1);
    expect(sendPrompt).toHaveBeenCalledWith('acp-session-1', 'hello');
    expect(waitForResponseComplete).toHaveBeenCalledTimes(1);
    expect(waitForResponseComplete).toHaveBeenCalledWith(undefined);
    expect(setSessionMode).toHaveBeenCalledWith('acp-session-1', 'plan');
    expect(setSessionModel).toHaveBeenCalledWith('acp-session-1', 'gemini-2.5-pro');
    expect(setSessionConfigOption).toHaveBeenCalledWith('acp-session-1', 'reasoning_effort', 'high');
    expect(cancel).toHaveBeenCalledWith('acp-session-1');
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('adapts ACP task markers to typed runtime turn events without reusing provider ids as canonical turn ids', async () => {
    const backend = createFakeAcpRuntimeBackend({
      sessionId: 'acp-session-1',
      waitForResponseComplete: vi.fn(async () => ({ kind: 'completed', stopReason: 'end_turn' } as const)),
    });
    const sendAgentMessage = vi.fn();
    const session = {
      ...createBasicSessionClient(),
      sendAgentMessage,
    };
    const runtime = createAcpRuntime({
      provider: 'gemini',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });
    const messages: unknown[] = [];
    runtime.subscribeRuntimeEvents((message) => {
      messages.push(message);
    });

    await runtime.startOrLoadSession();
    if (!backend) {
      throw new Error('Expected ACP runtime backend to be initialized');
    }
    const activeBackend = backend;
    runtime.beginTurnLifecycle();
    activeBackend.emit({ type: 'status', status: 'running' });
    activeBackend.emit({ type: 'model-output', fullText: 'hello' });
    await runtime.sendTurnPrompt('hello');
    await runtime.waitForTurnCompletion();

    const runtimeEvents = messages.map((message) => RuntimeEventV1Schema.parse(message));
    const turnStart = runtimeEvents.find((event) => event.kind === 'turn-start');
    const turnComplete = runtimeEvents.find((event) => event.kind === 'turn-complete');
    expect(turnStart).toEqual(expect.objectContaining({
      kind: 'turn-start',
      turnId: expect.any(String),
      providerTurnId: expect.any(String),
    }));
    expect(turnComplete).toEqual(expect.objectContaining({
      kind: 'turn-complete',
      turnId: turnStart?.turnId,
      providerTurnId: turnStart?.providerTurnId,
    }));
    expect(turnStart?.turnId).not.toBe(turnStart?.providerTurnId);
    expect(sendAgentMessage).toHaveBeenCalledWith('gemini', {
      type: 'task_started',
      id: turnStart?.providerTurnId,
    });
    expect(sendAgentMessage).toHaveBeenCalledWith('gemini', {
      type: 'task_complete',
      id: turnStart?.providerTurnId,
    });
  });
});
