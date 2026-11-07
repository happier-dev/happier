import { describe, expect, it, vi } from 'vitest';

import type { ExecutionRunHostRuntime } from '../executionRunHostRuntime';
import { createLazyExecutionRunHostRuntime } from './lazy';
import { createTestExecutionRunHostRuntime } from '../testkit';
import type { AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';

describe('createLazyExecutionRunHostRuntime', () => {
  it('retains an early runtime-event observation through lazy opening and releases it with its owner', async () => {
    const listeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
    const resolveRuntime = vi.fn(async () => ({
      ...createTestExecutionRunHostRuntime(),
      subscribeRuntimeEvents(listener: (event: AgentSessionRuntimeEvent) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    }));
    const runtime = createLazyExecutionRunHostRuntime({ resolveRuntime });
    const seen: unknown[] = [];
    const release = runtime.subscribeRuntimeEvents?.(event => seen.push(event));
    expect(resolveRuntime).not.toHaveBeenCalled();
    await runtime.provisionRuntime();
    const ended: AgentSessionRuntimeEvent = { kind: 'runtime-ended', sessionId: 'session-1', sequence: 1,
      emittedAtMs: 1, cause: 'processExited', retryable: true };
    for (const listener of listeners) listener(ended);
    expect(seen).toEqual([ended]);
    release?.();
    for (const listener of listeners) listener(ended);
    expect(seen).toEqual([ended]);
    runtime.subscribeRuntimeEvents?.(event => seen.push(event));
    await runtime.dispose();
    expect(listeners.size).toBe(0);
  });

  it('preserves resolved optional capability presence without fabricating steering', async () => {
    const probeTurnLiveness = vi.fn(async () => ({ active: true, reason: 'busy' }));
    const runtime = createLazyExecutionRunHostRuntime({
      resolveRuntime: async () => ({
        readResumeSupport: async () => false,
        provisionRuntime: async () => ({ runtimeId: 'lazy-runtime-1' }),
        deliverInput: async () => ({ status: 'admitted' as const }),
        getRuntimeLifetimeSignal: () => new AbortController().signal,
        cancel: async () => {},
        subscribeMessages: vi.fn(() => () => {}),
        probeTurnLiveness,
        dispose: async () => {},
      }),
    });

    await expect(runtime.provisionRuntime()).resolves.toEqual({ runtimeId: 'lazy-runtime-1' });

    expect(runtime.steerInput).toBeUndefined();
    expect(runtime.probeTurnLiveness).toEqual(expect.any(Function));
    await expect(runtime.probeTurnLiveness?.('lazy-runtime-1')).resolves.toEqual({
      active: true,
      reason: 'busy',
    });
    expect(probeTurnLiveness).toHaveBeenCalledWith('lazy-runtime-1');
  });

  it('does not resolve the lazy runtime for a cancel-before-start request', async () => {
    const resolveRuntime = vi.fn(async () => ({
      readResumeSupport: async () => false,
      provisionRuntime: async () => ({ runtimeId: 'lazy-runtime-1' }),
      deliverInput: async () => ({ status: 'admitted' as const }),
      getRuntimeLifetimeSignal: () => new AbortController().signal,
      cancel: async () => {},
      subscribeMessages: vi.fn(() => () => {}),
      dispose: async () => {},
    }));
    const runtime = createLazyExecutionRunHostRuntime({
      resolveRuntime,
    });

    await expect(runtime.cancel('lazy-runtime-1')).resolves.toBeUndefined();

    expect(resolveRuntime).not.toHaveBeenCalled();
  });

  it('cancels the resolved runtime when cancel is requested during runtime provisioning', async () => {
    let resolveProvision!: () => void;
    const provisionRuntime = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProvision = resolve;
      });
      return { runtimeId: 'lazy-runtime-1' };
    });
    const cancel = vi.fn(async () => {});
    const resolveRuntime = vi.fn(async () => ({
      readResumeSupport: async () => false,
      provisionRuntime,
      deliverInput: async () => ({ status: 'admitted' as const }),
      getRuntimeLifetimeSignal: () => new AbortController().signal,
      cancel,
      subscribeMessages: vi.fn(() => () => {}),
      dispose: async () => {},
    }));
    const runtime = createLazyExecutionRunHostRuntime({
      resolveRuntime,
    });

    const provision = runtime.provisionRuntime();
    await vi.waitFor(() => {
      expect(provisionRuntime).toHaveBeenCalledTimes(1);
    });
    const cancelled = runtime.cancel('lazy-runtime-1');

    await Promise.resolve();
    expect(cancel).not.toHaveBeenCalled();
    resolveProvision();

    await expect(cancelled).resolves.toBeUndefined();
    await expect(provision).resolves.toEqual({ runtimeId: 'lazy-runtime-1' });
    expect(resolveRuntime).toHaveBeenCalledTimes(1);
    expect(provisionRuntime).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith('lazy-runtime-1');
  });

  it('disposes the resolved lazy runtime idempotently for concurrent and repeated disposal', async () => {
    const unsubscribe = vi.fn();
    const dispose = vi.fn(async () => {});
    const runtime = createLazyExecutionRunHostRuntime({
      resolveRuntime: async () => ({
        readResumeSupport: async () => false,
        provisionRuntime: async () => ({ runtimeId: 'lazy-runtime-1' }),
        deliverInput: async () => ({ status: 'admitted' as const }),
        getRuntimeLifetimeSignal: () => new AbortController().signal,
        cancel: async () => {},
        subscribeMessages: vi.fn(() => unsubscribe),
        dispose,
      }),
    });

    const handler = vi.fn();
    runtime.subscribeMessages(handler);
    await runtime.provisionRuntime();
    await expect(Promise.all([runtime.dispose(), runtime.dispose()])).resolves.toEqual([undefined, undefined]);
    await expect(runtime.dispose()).resolves.toBeUndefined();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('settles disposal without awaiting unresolved provisioning and disposes a late runtime', async () => {
    let resolveRuntime!: (runtime: ExecutionRunHostRuntime) => void;
    const runtimePromise = new Promise<ExecutionRunHostRuntime>((resolve) => {
      resolveRuntime = resolve;
    });
    const lateDispose = vi.fn(async () => {});
    const runtime = createLazyExecutionRunHostRuntime({
      resolveRuntime: async () => await runtimePromise,
    });

    const provisioning = runtime.provisionRuntime();
    const lifetime = runtime.getRuntimeLifetimeSignal();
    const disposed = runtime.dispose();

    await expect(disposed).resolves.toBeUndefined();
    expect(lifetime.aborted).toBe(true);

    resolveRuntime({
      readResumeSupport: async () => false,
      provisionRuntime: async () => ({ runtimeId: 'late-runtime' }),
      deliverInput: async () => ({ status: 'admitted' as const }),
      getRuntimeLifetimeSignal: () => new AbortController().signal,
      cancel: async () => {},
      subscribeMessages: vi.fn(() => () => {}),
      dispose: lateDispose,
    });

    await expect(provisioning).rejects.toThrow('disposed');
    await vi.waitFor(() => expect(lateDispose).toHaveBeenCalledTimes(1));
  });

  it('does not advertise a permission responder before the runtime declares one', async () => {
    const resolveRuntime = vi.fn(async () => ({
      readResumeSupport: async () => false,
      provisionRuntime: async () => ({ runtimeId: 'lazy-runtime-1' }),
      deliverInput: async () => ({ status: 'admitted' as const }),
      getRuntimeLifetimeSignal: () => new AbortController().signal,
      cancel: async () => {},
      subscribeMessages: vi.fn(() => () => {}),
      respondToPermission: async () => ({ delivered: true as const }),
      dispose: async () => {},
    }));
    const runtime = createLazyExecutionRunHostRuntime({
      resolveRuntime,
    });

    expect(runtime.respondToPermission).toBeUndefined();
    expect(resolveRuntime).not.toHaveBeenCalled();
  });

  it('does not attach a late subscription after the caller already unsubscribed', async () => {
    let resolveRuntime!: (value: {
      readResumeSupport: () => Promise<boolean>;
      provisionRuntime: () => Promise<{ runtimeId: string }>;
      deliverInput: ExecutionRunHostRuntime['deliverInput'];
      getRuntimeLifetimeSignal: ExecutionRunHostRuntime['getRuntimeLifetimeSignal'];
      cancel: () => Promise<void>;
      subscribeMessages: ReturnType<typeof vi.fn>;
      dispose: () => Promise<void>;
    }) => void;

    const runtimePromise = new Promise<{
      readResumeSupport: () => Promise<boolean>;
      provisionRuntime: () => Promise<{ runtimeId: string }>;
      deliverInput: ExecutionRunHostRuntime['deliverInput'];
      getRuntimeLifetimeSignal: ExecutionRunHostRuntime['getRuntimeLifetimeSignal'];
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

    const runtimeProvision = runtime.provisionRuntime();
    const unsubscribe = runtime.subscribeMessages(() => {});
    unsubscribe();

    resolveRuntime({
      readResumeSupport: async () => false,
      provisionRuntime: async () => ({ runtimeId: 'lazy-runtime-1' }),
      deliverInput: async () => ({ status: 'admitted' as const }),
      getRuntimeLifetimeSignal: () => new AbortController().signal,
      cancel: async () => {},
      subscribeMessages,
      dispose: async () => {},
    });

    await expect(runtimeProvision).resolves.toEqual({ runtimeId: 'lazy-runtime-1' });
    expect(subscribeMessages).not.toHaveBeenCalled();
  });

  it('forwards runtime identity only from the resolved runtime owner', async () => {
    let resolveRuntime!: (value: {
      readResumeSupport: () => Promise<boolean>;
      provisionRuntime: () => Promise<{ runtimeId: string }>;
      deliverInput: ExecutionRunHostRuntime['deliverInput'];
      getRuntimeLifetimeSignal: ExecutionRunHostRuntime['getRuntimeLifetimeSignal'];
      cancel: () => Promise<void>;
      subscribeMessages: ReturnType<typeof vi.fn>;
      dispose: () => Promise<void>;
    }) => void;

    const runtimePromise = new Promise<{
      readResumeSupport: () => Promise<boolean>;
      provisionRuntime: () => Promise<{ runtimeId: string }>;
      deliverInput: ExecutionRunHostRuntime['deliverInput'];
      getRuntimeLifetimeSignal: ExecutionRunHostRuntime['getRuntimeLifetimeSignal'];
      cancel: () => Promise<void>;
      subscribeMessages: ReturnType<typeof vi.fn>;
      dispose: () => Promise<void>;
    }>((resolve) => {
      resolveRuntime = resolve;
    });

    const runtimeParams = {
      resolveRuntime: async () => await runtimePromise,
    };
    const runtime = createLazyExecutionRunHostRuntime(runtimeParams);
    const messages: unknown[] = [];
    runtime.subscribeMessages((message) => {
      messages.push(message);
    });

    const runtimeProvision = runtime.provisionRuntime();

    resolveRuntime({
      readResumeSupport: async () => false,
      provisionRuntime: async () => ({ runtimeId: 'lazy-runtime-1' }),
      deliverInput: async () => ({ status: 'admitted' as const }),
      getRuntimeLifetimeSignal: () => new AbortController().signal,
      cancel: async () => {},
      subscribeMessages: vi.fn((handler) => {
        handler({
          type: 'event',
          name: 'runtime.descriptor',
          payload: { v: 1, agentId: 'canonical.runtime' },
        });
        handler({
          type: 'event',
          name: 'runtime.capabilities',
          payload: { executionRun: { supported: true } },
        });
        handler({
          type: 'event',
          name: 'runtime.facets',
          payload: { v: 1, transcriptSource: { supported: true } },
        });
        return () => {};
      }),
      dispose: async () => {},
    });

    await expect(runtimeProvision).resolves.toEqual({ runtimeId: 'lazy-runtime-1' });
    expect(messages).toEqual([
      {
        type: 'event',
        name: 'runtime.descriptor',
        payload: {
          v: 1,
          agentId: 'canonical.runtime',
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

  it('preserves an established permission responder when runtime capabilities omit permission data', async () => {
    const respondToPermission = vi.fn(async () => ({ delivered: true as const }));
    const eventSource: { emit?: Parameters<ExecutionRunHostRuntime['subscribeMessages']>[0] } = {};
    const runtime = createLazyExecutionRunHostRuntime({
      resolveRuntime: async () => ({
        readResumeSupport: async () => false,
        provisionRuntime: async () => ({ runtimeId: 'lazy-runtime-1' }),
        deliverInput: async () => ({ status: 'admitted' as const }),
        getRuntimeLifetimeSignal: () => new AbortController().signal,
        cancel: async () => {},
        subscribeMessages: vi.fn((handler) => {
          eventSource.emit = handler;
          return () => {};
        }),
        permissionCapability: 'responds',
        respondToPermission,
        dispose: async () => {},
      }),
    });
    runtime.subscribeMessages(() => {});
    await runtime.provisionRuntime();

    eventSource.emit?.({
      type: 'event',
      name: 'runtime.capabilities',
      payload: { executionRun: { supported: true } },
    });

    expect(runtime.permissionCapability).toBe('responds');
    await expect(runtime.respondToPermission?.('permission-1', true)).resolves.toEqual({ delivered: true });
  });

  it('fails closed when a capability refresh explicitly contains malformed permission data', async () => {
    const respondToPermission = vi.fn(async () => ({ delivered: true as const }));
    const eventSource: { emit?: Parameters<ExecutionRunHostRuntime['subscribeMessages']>[0] } = {};
    const runtime = createLazyExecutionRunHostRuntime({
      resolveRuntime: async () => ({
        readResumeSupport: async () => false,
        provisionRuntime: async () => ({ runtimeId: 'runtime-1' }),
        deliverInput: async () => ({ status: 'admitted' as const }),
        cancel: async () => {},
        subscribeMessages: (handler) => {
          eventSource.emit = handler;
          return () => {};
        },
        getRuntimeLifetimeSignal: () => new AbortController().signal,
        permissionCapability: 'responds',
        respondToPermission,
        dispose: async () => {},
      }),
    });
    runtime.subscribeMessages(() => {});
    await runtime.provisionRuntime();

    eventSource.emit?.({
      type: 'event',
      name: 'runtime.capabilities',
      payload: { permissions: { capability: 'unexpected' } },
    });

    expect(runtime.permissionCapability).toBe('static');
    expect(runtime.respondToPermission).toBeUndefined();
    expect(respondToPermission).not.toHaveBeenCalled();
  });
});
