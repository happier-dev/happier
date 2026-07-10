import { describe, expect, it, vi } from 'vitest';

import type { AgentMessage } from '@/agent/core/AgentMessage';
import type { RuntimeTurnOperations } from '@/agent/runtime/turns/runtimeTurnOperations';

import { createTerminalRuntimeExecutionRunBackend } from './terminal';

function createPluginBackendFixture(capabilities?: Record<string, unknown>) {
  return {
    id: 'acme.sample.backend',
    agentId: 'acme.sample.provider',
    provenance: 'external',
    source: { kind: 'path' },
    runtimeKind: 'native',
    ...(capabilities ? { capabilities } : {}),
    definition: { id: 'acme.sample.backend', agentId: 'acme.sample.provider' },
  };
}

describe('createTerminalRuntimeExecutionRunBackend', () => {
  it('preserves launched runtime optional capability presence without fabricating steering', async () => {
    const probeTurnLiveness = vi.fn(async () => ({ active: true, reason: 'terminal-busy' }));
    const runtime = createTerminalRuntimeExecutionRunBackend({
      cwd: '/tmp/plugin-backend',
      backendId: 'acme.sample.backend',
      backend: createPluginBackendFixture() as never,
      launch: vi.fn(async () => ({
        runtime: {
          readResumeSupport: async () => false,
          provisionSession: async () => ({ sessionId: 'plugin-session-1' }),
          sendPrompt: async () => {},
          cancel: async () => {},
          subscribeMessages: vi.fn(() => () => undefined),
          probeTurnLiveness,
          dispose: async () => {},
        },
      })) as never,
      permissionMode: 'read_only',
    });

    await expect(runtime.provisionSession()).resolves.toEqual({ sessionId: 'plugin-session-1' });

    expect(runtime.sendSteerPrompt).toBeUndefined();
    expect(runtime.probeTurnLiveness).toEqual(expect.any(Function));
    await expect(runtime.probeTurnLiveness?.('plugin-session-1')).resolves.toEqual({
      active: true,
      reason: 'terminal-busy',
    });
    expect(probeTurnLiveness).toHaveBeenCalledWith('plugin-session-1');
  });

  it('does not launch the terminal runtime for a cancel-before-start request', async () => {
    const launch = vi.fn(async () => ({
      runtime: {
        readResumeSupport: async () => false,
        provisionSession: async () => ({ sessionId: 'plugin-session-1' }),
        sendPrompt: async () => {},
        cancel: async () => {},
        subscribeMessages: vi.fn(() => () => undefined),
        dispose: async () => {},
      },
    }));
    const runtime = createTerminalRuntimeExecutionRunBackend({
      cwd: '/tmp/plugin-backend',
      backendId: 'acme.sample.backend',
      backend: createPluginBackendFixture() as never,
      launch: launch as never,
      permissionMode: 'read_only',
    });

    await expect(runtime.cancel('plugin-session-1')).resolves.toBeUndefined();

    expect(launch).not.toHaveBeenCalled();
  });

  it('cancels the launched terminal runtime when cancel is requested during session provisioning', async () => {
    let resolveProvision!: () => void;
    const provisionSession = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProvision = resolve;
      });
      return { sessionId: 'plugin-session-1' };
    });
    const cancel = vi.fn(async () => {});
    const launch = vi.fn(async () => ({
      runtime: {
        readResumeSupport: async () => false,
        provisionSession,
        sendPrompt: async () => {},
        cancel,
        subscribeMessages: vi.fn(() => () => undefined),
        dispose: async () => {},
      },
    }));
    const runtime = createTerminalRuntimeExecutionRunBackend({
      cwd: '/tmp/plugin-backend',
      backendId: 'acme.sample.backend',
      backend: createPluginBackendFixture() as never,
      launch: launch as never,
      permissionMode: 'read_only',
    });

    const provision = runtime.provisionSession();
    await vi.waitFor(() => {
      expect(provisionSession).toHaveBeenCalledTimes(1);
    });
    const cancelled = runtime.cancel('plugin-session-1');

    await Promise.resolve();
    expect(cancel).not.toHaveBeenCalled();
    resolveProvision();

    await expect(cancelled).resolves.toBeUndefined();
    await expect(provision).resolves.toEqual({ sessionId: 'plugin-session-1' });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(provisionSession).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith('plugin-session-1');
  });

  it('disposes the launched terminal runtime idempotently for concurrent and repeated disposal', async () => {
    const unsubscribe = vi.fn();
    const dispose = vi.fn(async () => {});
    const runtime = createTerminalRuntimeExecutionRunBackend({
      cwd: '/tmp/plugin-backend',
      backendId: 'acme.sample.backend',
      backend: createPluginBackendFixture() as never,
      launch: vi.fn(async () => ({
        runtime: {
          readResumeSupport: async () => false,
          provisionSession: async () => ({ sessionId: 'plugin-session-1' }),
          sendPrompt: async () => {},
          cancel: async () => {},
          subscribeMessages: vi.fn(() => unsubscribe),
          dispose,
        },
      })) as never,
      permissionMode: 'read_only',
    });

    runtime.subscribeMessages(vi.fn());
    await runtime.provisionSession();
    await expect(Promise.all([runtime.dispose(), runtime.dispose()])).resolves.toEqual([undefined, undefined]);
    await expect(runtime.dispose()).resolves.toBeUndefined();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('does not launch the terminal runtime for a permission response before session start', async () => {
    const launch = vi.fn(async () => ({
      runtime: {
        readResumeSupport: async () => false,
        provisionSession: async () => ({ sessionId: 'plugin-session-1' }),
        sendPrompt: async () => {},
        cancel: async () => {},
        subscribeMessages: vi.fn(() => () => undefined),
        permissionCapability: 'responds',
        respondToPermission: async () => ({ delivered: true as const }),
        dispose: async () => {},
      },
    }));
    const runtime = createTerminalRuntimeExecutionRunBackend({
      cwd: '/tmp/plugin-backend',
      backendId: 'acme.sample.backend',
      backend: createPluginBackendFixture({
        permissions: { capability: 'responds' },
      }) as never,
      launch: launch as never,
      permissionMode: 'read_only',
    });

    await expect(runtime.respondToPermission?.('permission-1', false)).resolves.toEqual({
      delivered: false,
      reason: 'no_active_session',
    });

    expect(launch).not.toHaveBeenCalled();
  });

  it('preserves permission capability that becomes available after terminal session startup', async () => {
    let started = false;
    const respondToPermission = vi.fn(async () => ({ delivered: true as const }));
    const operations: RuntimeTurnOperations = {
      get permissionCapability() {
        return started ? 'responds' : undefined;
      },
      beginTurnLifecycle: vi.fn(),
      startOrLoadSession: vi.fn(async () => {
        started = true;
        return { sessionId: 'plugin-session-1' };
      }),
      sendTurnPrompt: vi.fn(async () => undefined),
      steerInFlightTurn: vi.fn(async () => undefined),
      waitForTurnCompletion: vi.fn(async () => undefined),
      subscribeRuntimeEvents: vi.fn(() => () => undefined),
      respondToPermission,
      cancelTurn: vi.fn(async () => undefined),
      readSessionIdentity: () => ({ sessionId: started ? 'plugin-session-1' : null }),
      updateSessionRuntimeConfig: vi.fn(async () => undefined),
      resetOrDisposeRuntime: vi.fn(async () => undefined),
    };
    const runtime = createTerminalRuntimeExecutionRunBackend({
      cwd: '/tmp/plugin-backend',
      backendId: 'acme.sample.backend',
      backend: createPluginBackendFixture() as never,
      launch: vi.fn(async () => ({ runtime: operations })) as never,
      permissionMode: 'read_only',
    });

    expect(runtime.permissionCapability).toBeUndefined();
    expect(runtime.respondToPermission).toBeUndefined();
    await expect(runtime.provisionSession()).resolves.toEqual({ sessionId: 'plugin-session-1' });
    expect(runtime.permissionCapability).toBe('responds');
    await expect(runtime.respondToPermission?.('permission-1', true)).resolves.toEqual({
      delivered: true,
    });
    expect(respondToPermission).toHaveBeenCalledWith('permission-1', true);
  });

  it('does not attach a late subscription after the caller already unsubscribed', async () => {
    type RuntimeMessage = {
      type: 'message';
      message: {
        type: 'message';
        message: string;
      };
    };

    let resolveLaunch!: (value: unknown) => void;
    const launchPromise = new Promise((resolve: (value: unknown) => void) => {
      resolveLaunch = resolve;
    });

    let runtimeHandler: ((message: RuntimeMessage) => void) | null = null;
    const subscribeMessages = vi.fn((handler: (message: RuntimeMessage) => void) => {
      runtimeHandler = handler;
      return () => {
        runtimeHandler = null;
      };
    });
    const runtime = createTerminalRuntimeExecutionRunBackend({
      cwd: '/tmp/plugin-backend',
      backendId: 'acme.sample.backend',
      backend: createPluginBackendFixture() as never,
      launch: vi.fn(async () => await launchPromise) as never,
      permissionMode: 'read_only',
    });

    const sessionPromise = runtime.provisionSession({ initialPrompt: 'boot' });
    const handler = vi.fn();
    const unsubscribe = runtime.subscribeMessages(handler);
    unsubscribe();

    resolveLaunch({
      runtime: {
        readResumeSupport: async () => false,
        provisionSession: async () => ({ sessionId: 'plugin-session-1' }),
        sendPrompt: async () => {},
        cancel: async () => {},
        subscribeMessages,
        dispose: async () => {},
      },
    });

    await expect(sessionPromise).resolves.toEqual({ sessionId: 'plugin-session-1' });
    const emitLateMessage = runtimeHandler;
    if (emitLateMessage) {
      (emitLateMessage as (message: RuntimeMessage) => void)({
        type: 'message',
        message: {
          type: 'message',
          message: 'late message',
        },
      });
    }

    expect(subscribeMessages).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();
  });

  it('fails closed to the generic plugin descriptor when launch returns a malformed runtimeDescriptor payload', async () => {
    const subscribeMessages = vi.fn(() => () => undefined);
    const runtime = createTerminalRuntimeExecutionRunBackend({
      cwd: '/tmp/plugin-backend',
      backendId: 'acme.sample.backend',
      backend: createPluginBackendFixture() as never,
      launch: vi.fn(async () => ({
        runtime: {
          readResumeSupport: async () => false,
          provisionSession: async () => ({ sessionId: 'plugin-session-1' }),
          sendPrompt: async () => {},
          cancel: async () => {},
          subscribeMessages,
          dispose: async () => {},
        },
        runtimeDescriptor: {
          backendId: 'acme.sample.backend',
          runtimeKind: 'native',
        },
      })) as never,
      permissionMode: 'read_only',
    });

    const messages: AgentMessage[] = [];
    const unsubscribe = runtime.subscribeMessages((message) => {
      messages.push(message);
    });

    await expect(runtime.provisionSession({ initialPrompt: 'boot' })).resolves.toEqual({ sessionId: 'plugin-session-1' });
    unsubscribe();

    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'event',
        name: 'runtime.descriptor',
        payload: expect.objectContaining({
          v: 1,
          agentId: 'acme.sample.provider',
          agent: expect.objectContaining({
            backendMode: 'native',
            agentExtra: expect.objectContaining({
              owner: 'happier',
              schemaId: 'happier.pluginRuntimeDescriptorExtra',
              v: 1,
              runtimeHandle: expect.objectContaining({
                backendId: 'acme.sample.backend',
                agentId: 'acme.sample.provider',
                provenance: 'external',
                source: { kind: 'path' },
              }),
            }),
          }),
        }),
      }),
    ]));
    expect(messages.filter((message) => message.type === 'event' && message.name === 'runtime.descriptor')).toHaveLength(1);
  });

  it('rejects execution-run launch payloads that still use bindings instead of runtime', async () => {
    const runtime = createTerminalRuntimeExecutionRunBackend({
      cwd: '/tmp/plugin-backend',
      backendId: 'acme.sample.backend',
      backend: createPluginBackendFixture() as never,
      launch: vi.fn(async () => ({
        bindings: {
          readResumeSupport: async () => false,
          provisionSession: async () => ({ sessionId: 'plugin-session-1' }),
          sendPrompt: async () => {},
          cancel: async () => {},
          subscribeMessages: vi.fn(() => () => undefined),
          dispose: async () => {},
        },
      })) as never,
      permissionMode: 'read_only',
    });

    await expect(runtime.provisionSession({ initialPrompt: 'boot' })).rejects.toThrow(
      /must include an execution-run runtime surface/i,
    );
  });
});
