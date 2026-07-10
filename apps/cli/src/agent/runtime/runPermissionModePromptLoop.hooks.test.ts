import { describe, expect, it, vi } from 'vitest';

import type { Metadata } from '@/api/types';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { combinePermissionModeQueuedPrompts, type PermissionModeQueuedPrompt } from '@/agent/runtime/permissions/queuedPrompt';
import type { RuntimeTurnOperations } from '@/agent/runtime/turns/runtimeTurnOperations';

import { runPermissionModePromptLoop } from './runPermissionModePromptLoop';

function createModeQueue() {
  return new MessageQueue2<{
    permissionMode: any;
    appendSystemPrompt?: string | null;
    model?: string;
    suppressUserEcho?: boolean;
    providerPromptAlreadyResolved?: boolean;
  }, PermissionModeQueuedPrompt>(
    (mode) => JSON.stringify(mode),
    {
      batcher: (messages) => combinePermissionModeQueuedPrompts(messages),
    },
  );
}

function createRuntime() {
  return {
    beginTurnLifecycle: vi.fn(),
    startOrLoadSession: vi.fn(async () => undefined),
    sendTurnPrompt: vi.fn(async () => undefined),
    steerInFlightTurn: vi.fn(async () => undefined),
    waitForTurnCompletion: vi.fn(async () => undefined),
    subscribeRuntimeEvents: vi.fn(() => () => undefined),
    respondToPermission: vi.fn(async () => undefined),
    cancelTurn: vi.fn(async () => undefined),
    readSessionIdentity: vi.fn(() => ({ sessionId: 'provider-session-1' })),
    updateSessionRuntimeConfig: vi.fn<RuntimeTurnOperations['updateSessionRuntimeConfig']>(async () => undefined),
    resetOrDisposeRuntime: vi.fn(async () => undefined),
    shouldResumeAfterPermissionModeChange: vi.fn(() => true),
  };
}

describe('runPermissionModePromptLoop hook dispatch', () => {
  it('applies agent.context.before to the finalized outgoing provider prompt before dispatch', async () => {
    const session = createMutableApiSessionClientFixture<Metadata>({
      overrides: {
        sessionId: 'session-1',
      } as Partial<Parameters<typeof runPermissionModePromptLoop>[0]['session']>,
    });
    session.__setMetadata(createTestMetadata({
      permissionMode: 'default',
      permissionModeUpdatedAt: 0,
    }));
    const queue = createModeQueue();
    queue.push({ text: 'hello', localId: 'local-1' }, { permissionMode: 'default' });
    const runtime = createRuntime();
    const messageBuffer = new MessageBuffer();
    let shouldExit = false;
    const transformAgentContextBeforeDispatch = vi.fn(async (payload: Record<string, unknown>) => ({
      ...payload,
      prompt: `${payload.prompt} [context]`,
      messages: [
        ...(payload.messages as readonly unknown[]),
        { role: 'system', content: 'fixture context' },
      ],
    }));

    await runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      permissionHandler: {
        setPermissionMode: vi.fn(),
        reset: vi.fn(),
      },
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
      createOverrideSynchronizer: () => ({
        syncFromMetadata: () => undefined,
        flushPendingAfterStart: async () => undefined,
      }),
      messageBuffer,
      shouldExit: () => shouldExit,
      getAbortSignal: () => new AbortController().signal,
      keepAlive: () => undefined,
      setThinking: () => undefined,
      sendReady: () => {
        shouldExit = true;
      },
      currentPermissionModeUpdatedAt: 0,
      setCurrentPermissionMode: () => undefined,
      setCurrentPermissionModeUpdatedAt: () => undefined,
      resolveFreshSessionSystemPrompt: async () => 'SYSTEM',
      transformAgentContextBeforeDispatch,
      formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
    } as Parameters<typeof runPermissionModePromptLoop>[0]);

    expect(transformAgentContextBeforeDispatch).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: session.sessionId,
      runtimeFamily: 'hostSession',
      prompt: 'SYSTEM\n\nhello',
      messages: [{ role: 'user', content: 'SYSTEM\n\nhello' }],
    }));
    expect(runtime.sendTurnPrompt).toHaveBeenCalledWith('SYSTEM\n\nhello [context]', {
      localId: 'local-1',
      localIds: ['local-1'],
    });
  });

  it('applies agent.context.before message-list replacements even when prompt is unchanged', async () => {
    const session = createMutableApiSessionClientFixture<Metadata>({
      overrides: {
        sessionId: 'session-1',
      } as Partial<Parameters<typeof runPermissionModePromptLoop>[0]['session']>,
    });
    session.__setMetadata(createTestMetadata({
      permissionMode: 'default',
      permissionModeUpdatedAt: 0,
    }));
    const queue = createModeQueue();
    queue.push({ text: 'hello', localId: 'local-1' }, { permissionMode: 'default' });
    const runtime = createRuntime();
    const messageBuffer = new MessageBuffer();
    let shouldExit = false;
    const transformAgentContextBeforeDispatch = vi.fn(async (payload: Record<string, unknown>) => ({
      ...payload,
      messages: [
        ...(payload.messages as readonly unknown[]),
        { role: 'system', content: 'fixture context' },
      ],
    }));

    await runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      permissionHandler: {
        setPermissionMode: vi.fn(),
        reset: vi.fn(),
      },
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
      createOverrideSynchronizer: () => ({
        syncFromMetadata: () => undefined,
        flushPendingAfterStart: async () => undefined,
      }),
      messageBuffer,
      shouldExit: () => shouldExit,
      getAbortSignal: () => new AbortController().signal,
      keepAlive: () => undefined,
      setThinking: () => undefined,
      sendReady: () => {
        shouldExit = true;
      },
      currentPermissionModeUpdatedAt: 0,
      setCurrentPermissionMode: () => undefined,
      setCurrentPermissionModeUpdatedAt: () => undefined,
      resolveFreshSessionSystemPrompt: async () => 'SYSTEM',
      transformAgentContextBeforeDispatch,
      formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
    } as Parameters<typeof runPermissionModePromptLoop>[0]);

    expect(transformAgentContextBeforeDispatch).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'SYSTEM\n\nhello',
      messages: [{ role: 'user', content: 'SYSTEM\n\nhello' }],
    }));
    expect(runtime.sendTurnPrompt).toHaveBeenCalledWith('SYSTEM\n\nhello\n\nfixture context', {
      localId: 'local-1',
      localIds: ['local-1'],
    });
  });
});
