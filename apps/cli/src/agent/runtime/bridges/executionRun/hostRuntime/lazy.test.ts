import { describe, expect, it, vi } from 'vitest';

import { createLazyExecutionRunHostRuntime } from './lazy';

describe('createLazyExecutionRunHostRuntime', () => {
  it('preserves resolved optional capability presence without fabricating steering', async () => {
    const probeTurnLiveness = vi.fn(async () => ({ active: true, reason: 'busy' }));
    const runtime = createLazyExecutionRunHostRuntime({
      resolveRuntime: async () => ({
        readResumeSupport: async () => false,
        provisionSession: async () => ({ sessionId: 'lazy-runtime-session-1' }),
        sendPrompt: async () => {},
        cancel: async () => {},
        subscribeMessages: vi.fn(() => () => {}),
        probeTurnLiveness,
        dispose: async () => {},
      }),
    });

    await expect(runtime.provisionSession()).resolves.toEqual({ sessionId: 'lazy-runtime-session-1' });

    expect(runtime.sendSteerPrompt).toBeUndefined();
    expect(runtime.probeTurnLiveness).toEqual(expect.any(Function));
    await expect(runtime.probeTurnLiveness?.('lazy-runtime-session-1')).resolves.toEqual({
      active: true,
      reason: 'busy',
    });
    expect(probeTurnLiveness).toHaveBeenCalledWith('lazy-runtime-session-1');
  });

  it('does not resolve the lazy runtime for a cancel-before-start request', async () => {
    const resolveRuntime = vi.fn(async () => ({
      readResumeSupport: async () => false,
      provisionSession: async () => ({ sessionId: 'lazy-runtime-session-1' }),
      sendPrompt: async () => {},
      cancel: async () => {},
      subscribeMessages: vi.fn(() => () => {}),
      dispose: async () => {},
    }));
    const runtime = createLazyExecutionRunHostRuntime({
      resolveRuntime,
    });

    await expect(runtime.cancel('lazy-runtime-session-1')).resolves.toBeUndefined();

    expect(resolveRuntime).not.toHaveBeenCalled();
  });

  it('cancels the resolved runtime when cancel is requested during session provisioning', async () => {
    let resolveProvision!: () => void;
    const provisionSession = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProvision = resolve;
      });
      return { sessionId: 'lazy-runtime-session-1' };
    });
    const cancel = vi.fn(async () => {});
    const resolveRuntime = vi.fn(async () => ({
      readResumeSupport: async () => false,
      provisionSession,
      sendPrompt: async () => {},
      cancel,
      subscribeMessages: vi.fn(() => () => {}),
      dispose: async () => {},
    }));
    const runtime = createLazyExecutionRunHostRuntime({
      resolveRuntime,
    });

    const provision = runtime.provisionSession();
    await vi.waitFor(() => {
      expect(provisionSession).toHaveBeenCalledTimes(1);
    });
    const cancelled = runtime.cancel('lazy-runtime-session-1');

    await Promise.resolve();
    expect(cancel).not.toHaveBeenCalled();
    resolveProvision();

    await expect(cancelled).resolves.toBeUndefined();
    await expect(provision).resolves.toEqual({ sessionId: 'lazy-runtime-session-1' });
    expect(resolveRuntime).toHaveBeenCalledTimes(1);
    expect(provisionSession).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith('lazy-runtime-session-1');
  });

  it('disposes the resolved lazy runtime idempotently for concurrent and repeated disposal', async () => {
    const unsubscribe = vi.fn();
    const dispose = vi.fn(async () => {});
    const runtime = createLazyExecutionRunHostRuntime({
      resolveRuntime: async () => ({
        readResumeSupport: async () => false,
        provisionSession: async () => ({ sessionId: 'lazy-runtime-session-1' }),
        sendPrompt: async () => {},
        cancel: async () => {},
        subscribeMessages: vi.fn(() => unsubscribe),
        dispose,
      }),
    });

    const handler = vi.fn();
    runtime.subscribeMessages(handler);
    await runtime.provisionSession();
    await expect(Promise.all([runtime.dispose(), runtime.dispose()])).resolves.toEqual([undefined, undefined]);
    await expect(runtime.dispose()).resolves.toBeUndefined();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('does not resolve the lazy runtime for a permission response before session start', async () => {
    const resolveRuntime = vi.fn(async () => ({
      readResumeSupport: async () => false,
      provisionSession: async () => ({ sessionId: 'lazy-runtime-session-1' }),
      sendPrompt: async () => {},
      cancel: async () => {},
      subscribeMessages: vi.fn(() => () => {}),
      respondToPermission: async () => ({ delivered: true as const }),
      dispose: async () => {},
    }));
    const runtime = createLazyExecutionRunHostRuntime({
      resolveRuntime,
      runtimeCapabilities: {
        permissions: { capability: 'responds' },
      },
    });

    await expect(runtime.respondToPermission?.('permission-1', false)).resolves.toEqual({
      delivered: false,
      reason: 'no_active_session',
    });

    expect(resolveRuntime).not.toHaveBeenCalled();
  });

  it('does not attach a late subscription after the caller already unsubscribed', async () => {
    let resolveRuntime!: (value: {
      readResumeSupport: () => Promise<boolean>;
      provisionSession: () => Promise<{ sessionId: string }>;
      sendPrompt: () => Promise<void>;
      cancel: () => Promise<void>;
      subscribeMessages: ReturnType<typeof vi.fn>;
      dispose: () => Promise<void>;
    }) => void;

    const runtimePromise = new Promise<{
      readResumeSupport: () => Promise<boolean>;
      provisionSession: () => Promise<{ sessionId: string }>;
      sendPrompt: () => Promise<void>;
      cancel: () => Promise<void>;
      subscribeMessages: ReturnType<typeof vi.fn>;
      dispose: () => Promise<void>;
    }>((resolve) => {
      resolveRuntime = resolve;
    });

    const subscribeMessages = vi.fn(() => () => {});
    const runtime = createLazyExecutionRunHostRuntime({
      resolveRuntime: async () => await runtimePromise,
    });

    const sessionPromise = runtime.provisionSession();
    const unsubscribe = runtime.subscribeMessages(() => {});
    unsubscribe();

    resolveRuntime({
      readResumeSupport: async () => false,
      provisionSession: async () => ({ sessionId: 'lazy-runtime-session-1' }),
      sendPrompt: async () => {},
      cancel: async () => {},
      subscribeMessages,
      dispose: async () => {},
    });

    await expect(sessionPromise).resolves.toEqual({ sessionId: 'lazy-runtime-session-1' });
    expect(subscribeMessages).not.toHaveBeenCalled();
  });

  it('publishes runtime facets once after the lazy runtime resolves', async () => {
    let resolveRuntime!: (value: {
      readResumeSupport: () => Promise<boolean>;
      provisionSession: () => Promise<{ sessionId: string }>;
      sendPrompt: () => Promise<void>;
      cancel: () => Promise<void>;
      subscribeMessages: ReturnType<typeof vi.fn>;
      dispose: () => Promise<void>;
    }) => void;

    const runtimePromise = new Promise<{
      readResumeSupport: () => Promise<boolean>;
      provisionSession: () => Promise<{ sessionId: string }>;
      sendPrompt: () => Promise<void>;
      cancel: () => Promise<void>;
      subscribeMessages: ReturnType<typeof vi.fn>;
      dispose: () => Promise<void>;
    }>((resolve) => {
      resolveRuntime = resolve;
    });

    const runtimeParams = {
      resolveRuntime: async () => await runtimePromise,
      runtimeDescriptor: {
        v: 1,
        agentId: 'acme.provider',
        provider: {
          backendMode: 'native',
        },
      },
      runtimeCapabilities: {
        executionRun: { supported: true },
      },
      runtimeFacets: {
        v: 1,
        transcriptSource: {
          supported: true,
        },
      },
    };
    const runtime = createLazyExecutionRunHostRuntime(runtimeParams);
    const messages: unknown[] = [];
    runtime.subscribeMessages((message) => {
      messages.push(message);
    });

    const sessionPromise = runtime.provisionSession();

    resolveRuntime({
      readResumeSupport: async () => false,
      provisionSession: async () => ({ sessionId: 'lazy-runtime-session-1' }),
      sendPrompt: async () => {},
      cancel: async () => {},
      subscribeMessages: vi.fn(() => () => {}),
      dispose: async () => {},
    });

    await expect(sessionPromise).resolves.toEqual({ sessionId: 'lazy-runtime-session-1' });
    expect(messages).toEqual([
      {
        type: 'event',
        name: 'runtime.descriptor',
        payload: {
          v: 1,
          agentId: 'acme.provider',
          provider: {
            backendMode: 'native',
          },
        },
      },
      {
        type: 'event',
        name: 'runtime.capabilities',
        payload: {
          executionRun: { supported: true },
        },
      },
      {
        type: 'event',
        name: 'runtime.facets',
        payload: {
          v: 1,
          transcriptSource: {
            supported: true,
          },
        },
      },
    ]);
  });
});
