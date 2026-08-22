import { describe, expect, it, vi } from 'vitest';
import { AgentSessionRuntimeEventSchema } from '@happier-dev/protocol';

import { createAcpRuntime } from '../createAcpRuntime';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { isRuntimeTurnOperations } from '@/agent/runtime/turns/runtimeTurnOperations';
import { createFakeAcpRuntimeBackend } from '@/testkit/backends/acpRuntimeBackend';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createBasicSessionClient } from '@/testkit/backends/sessionFixtures';

describe('createAcpRuntime (native lower-operation surface)', () => {
  it('keeps a fresh configured ACP backend lazy until the first prompt', async () => {
    const startSession = vi.fn(async () => ({ sessionId: 'fresh-session' }));
    const sendPrompt = vi.fn(async () => undefined);
    const ensureBackend = vi.fn(async () => createFakeAcpRuntimeBackend({
      startSession,
      sendPrompt,
    }));
    const runtime = createAcpRuntime({
      provider: 'account-configured-acp',
      directory: '/tmp',
      session: createBasicSessionClient(),
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend,
      sessionOpenIntent: { kind: 'create' },
    });

    expect(ensureBackend).not.toHaveBeenCalled();
    await runtime.sendTurnPrompt('hello');

    expect(ensureBackend).toHaveBeenCalledOnce();
    expect(startSession).toHaveBeenCalledOnce();
    expect(sendPrompt).toHaveBeenCalledWith('fresh-session', 'hello');
  });

  it('loads a configured ACP resume intent strictly without falling back to create', async () => {
    const startSession = vi.fn(async () => ({ sessionId: 'unexpected-fresh-session' }));
    const loadSession = vi.fn(async () => {
      throw new Error('configured resume failed');
    });
    const backend = createFakeAcpRuntimeBackend({ startSession });
    backend.loadSession = loadSession;
    const runtime = createAcpRuntime({
      provider: 'account-configured-acp',
      directory: '/tmp',
      session: createBasicSessionClient(),
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
      sessionOpenIntent: {
        kind: 'resume',
        providerSessionId: 'configured-session-1',
        importHistory: false,
      },
    });

    await expect(runtime.sendTurnPrompt('hello')).rejects.toThrow('configured resume failed');
    expect(loadSession).toHaveBeenCalledWith('configured-session-1');
    expect(startSession).not.toHaveBeenCalled();
  });

  it('uses the reset successor intent on the next prompt with a new backend', async () => {
    const firstBackend = createFakeAcpRuntimeBackend({ sessionId: 'resumed-session' });
    firstBackend.loadSession = vi.fn(async () => ({ sessionId: 'resumed-session' }));
    const secondStartSession = vi.fn(async () => ({ sessionId: 'fresh-successor' }));
    const secondSendPrompt = vi.fn(async () => undefined);
    const secondBackend = createFakeAcpRuntimeBackend({
      startSession: secondStartSession,
      sendPrompt: secondSendPrompt,
    });
    const ensureBackend = vi.fn()
      .mockResolvedValueOnce(firstBackend)
      .mockResolvedValueOnce(secondBackend);
    const runtime = createAcpRuntime({
      provider: 'account-configured-acp',
      directory: '/tmp',
      session: createBasicSessionClient(),
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend,
      sessionOpenIntent: {
        kind: 'resume',
        providerSessionId: 'configured-session-1',
        importHistory: false,
      },
    });

    await runtime.sendTurnPrompt('before reset');
    await runtime.resetOrDisposeRuntime(undefined, { kind: 'create' });
    expect(ensureBackend).toHaveBeenCalledOnce();

    await runtime.sendTurnPrompt('after reset');

    expect(ensureBackend).toHaveBeenCalledTimes(2);
    expect(secondStartSession).toHaveBeenCalledOnce();
    expect(secondSendPrompt).toHaveBeenCalledWith('fresh-successor', 'after reset');
  });

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

    expect(runtime).not.toHaveProperty('startOrLoadSession');
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

    await runtime.sendTurnPrompt('session setup');
    if (!backend) {
      throw new Error('Expected ACP runtime backend to be initialized');
    }
    const activeBackend = backend;
    runtime.beginTurnLifecycle();
    activeBackend.emit({ type: 'status', status: 'running' });
    activeBackend.emit({ type: 'model-output', fullText: 'hello' });
    await runtime.sendTurnPrompt('hello');
    await runtime.waitForTurnCompletion();

    const runtimeEvents = messages.map((message) => AgentSessionRuntimeEventSchema.parse(message));
    const turnStart = runtimeEvents.find((event) => event.kind === 'turn-start');
    const turnComplete = runtimeEvents.find((event) => event.kind === 'turn-complete');
    expect(turnStart).toEqual(expect.objectContaining({
      kind: 'turn-start',
      turnId: expect.any(String),
      agentTurnId: expect.any(String),
    }));
    expect(turnComplete).toEqual(expect.objectContaining({
      kind: 'turn-complete',
      turnId: turnStart?.turnId,
      agentTurnId: turnStart?.agentTurnId,
    }));
    expect(turnStart?.turnId).not.toBe(turnStart?.agentTurnId);
    expect(runtimeEvents.map((event) => event.sequence)).toEqual(
      runtimeEvents.map((_, index) => index + 1),
    );
    expect(sendAgentMessage).not.toHaveBeenCalled();
  });

  it('does not smuggle transcript-provider identity into canonical Agent runtime events', async () => {
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
      provider: 'acme.plugin-backed-acp.backend',
      transcriptProvider: 'acp:acme.plugin-backed-acp.backend',
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

    await runtime.sendTurnPrompt('session setup');
    runtime.beginTurnLifecycle();
    backend.emit({ type: 'status', status: 'running' });
    backend.emit({ type: 'model-output', fullText: 'configured response' });
    await runtime.sendTurnPrompt('hello');
    await runtime.waitForTurnCompletion();

    const runtimeEvents = messages.map((message) => AgentSessionRuntimeEventSchema.parse(message));
    expect(runtimeEvents.some((event) => JSON.stringify(event).includes('acp:acme.plugin-backed-acp.backend')))
      .toBe(false);
    expect(sendAgentMessage).not.toHaveBeenCalled();
  });
});
