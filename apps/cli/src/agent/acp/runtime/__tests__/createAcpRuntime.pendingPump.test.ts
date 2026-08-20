import { describe, expect, it, vi } from 'vitest';

import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { createTestAcpRuntime as createAcpRuntime } from '@/testkit/backends/acpRuntime';
import type { AcpRuntimeBackend } from '../createAcpRuntime';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createSessionClientWithMetadata } from '@/testkit/backends/sessionFixtures';
import type { DrainPendingOptions, DrainPendingResult } from '@/agent/runtime/sessionInput/types';

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('createAcpRuntime pending queue pump', () => {
  it('drains pending messages once after loading a resumable session when opted in', async () => {
    const { session } = createSessionClientWithMetadata();

    const calls: string[] = [];
    const drainPending = vi.fn(async (_opts?: DrainPendingOptions): Promise<DrainPendingResult> => {
      calls.push('drain');
      return { materialized: 0, stoppedReason: 'no_pending' };
    });
    const backend = {
      startSession: async () => ({ sessionId: 'fresh-1' }),
      loadSession: async (sessionId: string) => {
        calls.push(`load:${sessionId}`);
        return { sessionId };
      },
      sendPrompt: async () => {},
      cancel: async () => {},
      onMessage: () => {},
      dispose: async () => {},
    } satisfies AcpRuntimeBackend;
    const runtime = createAcpRuntime({
      provider: 'codex',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
      pendingQueue: {
        drainAfterStartOrLoad: true,
        inputConsumer: { drainPending },
      },
    });

    await runtime.startOrLoad({ resumeId: ' resume-1 ', importHistory: false });

    expect(drainPending).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['load:resume-1', 'drain']);

    await runtime.reset();
  });

  it('defers the post-start pending drain until explicitly requested', async () => {
    const { session } = createSessionClientWithMetadata();

    const calls: string[] = [];
    const drainPending = vi.fn(async (_opts?: DrainPendingOptions): Promise<DrainPendingResult> => {
      calls.push('drain');
      return { materialized: 0, stoppedReason: 'no_pending' };
    });
    const backend = {
      startSession: async () => {
        calls.push('start');
        return { sessionId: 'fresh-1' };
      },
      sendPrompt: async () => {},
      cancel: async () => {},
      onMessage: () => {},
      dispose: async () => {},
    } satisfies AcpRuntimeBackend;
    const runtime = createAcpRuntime({
      provider: 'cursor',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
      pendingQueue: {
        drainAfterStartOrLoad: true,
        inputConsumer: { drainPending },
      },
    });

    await runtime.startOrLoad({ deferPendingDrain: true });

    expect(drainPending).not.toHaveBeenCalled();
    expect(calls).toEqual(['start']);

    await runtime.drainPendingAfterStartOrLoad();

    expect(drainPending).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['start', 'drain']);

    await runtime.reset();
  });

  it('does not fail startOrLoad when the post-load pending drain rejects', async () => {
    const { session } = createSessionClientWithMetadata();

    const calls: string[] = [];
    const drainPending = vi.fn(async (): Promise<DrainPendingResult> => {
      calls.push('drain');
      throw new Error('post-load drain failed');
    });
    const backend = {
      startSession: async () => ({ sessionId: 'fresh-1' }),
      loadSession: async (sessionId: string) => {
        calls.push(`load:${sessionId}`);
        return { sessionId };
      },
      sendPrompt: async () => {},
      cancel: async () => {},
      onMessage: () => {},
      dispose: async () => {},
    } satisfies AcpRuntimeBackend;
    const runtime = createAcpRuntime({
      provider: 'codex',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
      pendingQueue: {
        drainAfterStartOrLoad: true,
        inputConsumer: { drainPending },
      },
    });

    await expect(runtime.startOrLoad({ resumeId: 'resume-1', importHistory: false })).resolves.toBe('resume-1');
    expect(calls).toEqual(['load:resume-1', 'drain']);

    await runtime.reset();
  });

  it('starts the active-turn pending pump for send-now interrupt when in-flight steer is disabled', async () => {
    const { session } = createSessionClientWithMetadata();

    const drainPending = vi.fn(async (): Promise<DrainPendingResult> => ({
      materialized: 0,
      stoppedReason: 'no_pending',
    }));
    const pumpPendingWhileActive = vi.fn(async (opts: { abortSignal: AbortSignal }) => {
      await new Promise<void>((resolve) => {
        if (opts.abortSignal.aborted) return resolve();
        opts.abortSignal.addEventListener('abort', () => resolve(), { once: true });
      });
    });
    const runtime = createAcpRuntime({
      provider: 'grok',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => {
        throw new Error('backend should not be created for pending pump test');
      },
      pendingQueue: {
        drainDuringTurn: true,
        inputConsumer: { drainPending, pumpPendingWhileActive },
      },
    });

    runtime.beginTurn();
    await nextTick();

    expect(runtime.supportsInFlightSteer()).toBe(false);
    expect(pumpPendingWhileActive).toHaveBeenCalledTimes(1);

    await runtime.reset();
  });

  it('does not drain pending messages by default when a steer-capable turn begins', async () => {
    const { session } = createSessionClientWithMetadata();

    const drainPending = vi.fn(async (): Promise<DrainPendingResult> => ({
      materialized: 0,
      stoppedReason: 'no_pending',
    }));
    const runtime = createAcpRuntime({
      provider: 'codex',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => {
        throw new Error('backend should not be created for pending pump test');
      },
      inFlightSteer: { enabled: true },
      pendingQueue: {
        inputConsumer: { drainPending },
      },
    });

    runtime.beginTurn();
    await nextTick();

    expect(drainPending).not.toHaveBeenCalled();

    await runtime.reset();
  });

  it('drains existing pending messages immediately when a steer-capable turn begins', async () => {
    const { session } = createSessionClientWithMetadata();

    let pending = 1;
    const drainPending = vi.fn(async (): Promise<DrainPendingResult> => {
      if (pending > 0) {
        pending -= 1;
        return { materialized: 1, stoppedReason: 'no_pending' };
      }
      return { materialized: 0, stoppedReason: 'no_pending' };
    });
    const pumpPendingWhileActive = vi.fn(async (opts: { abortSignal: AbortSignal }) => {
      await drainPending();
      await new Promise<void>((resolve) => {
        if (opts.abortSignal.aborted) return resolve();
        opts.abortSignal.addEventListener('abort', () => resolve(), { once: true });
      });
    });
    const runtime = createAcpRuntime({
      provider: 'codex',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => {
        throw new Error('backend should not be created for pending pump test');
      },
      inFlightSteer: { enabled: true },
      pendingQueue: {
        drainDuringTurn: true,
        inputConsumer: { drainPending, pumpPendingWhileActive },
      },
    });

    runtime.beginTurn();
    await nextTick();

    // If the pump waits only on metadata updates, pre-existing pending messages can be stranded
    // until a later update event arrives (which breaks in-flight steer). We should drain at least once.
    expect(drainPending).toHaveBeenCalled();
    expect(pending).toBe(0);

    await runtime.reset();
  });

  it('delegates one active-turn lifecycle to the shared pump and elapsed time starts no poll', async () => {
    vi.useFakeTimers();
    const { session } = createSessionClientWithMetadata();

    const drainPending = vi.fn(async (): Promise<DrainPendingResult> => ({
      materialized: 0,
      stoppedReason: 'no_pending',
    }));
    const pumpPendingWhileActive = vi.fn(async (opts: { abortSignal: AbortSignal }) => {
      await new Promise<void>((resolve) => {
        if (opts.abortSignal.aborted) return resolve();
        opts.abortSignal.addEventListener('abort', () => resolve(), { once: true });
      });
    });
    const runtime = createAcpRuntime({
      provider: 'codex',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => {
        throw new Error('backend should not be created for pending pump test');
      },
      inFlightSteer: { enabled: true },
      pendingQueue: {
        drainDuringTurn: true,
        inputConsumer: { drainPending, pumpPendingWhileActive },
      },
    });

    runtime.beginTurn();
    await vi.advanceTimersByTimeAsync(0);

    expect(pumpPendingWhileActive).toHaveBeenCalledTimes(1);
    expect(drainPending).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(pumpPendingWhileActive).toHaveBeenCalledTimes(1);
    expect(drainPending).not.toHaveBeenCalled();

    await runtime.reset();
    vi.useRealTimers();
  });

  it('does not replace a completed shared pump with a timer-driven ACP pump', async () => {
    const { session } = createSessionClientWithMetadata();

    const drainPending = vi.fn(async (): Promise<DrainPendingResult> => ({
      materialized: 0,
      stoppedReason: 'no_pending',
    }));
    const pumpPendingWhileActive = vi.fn(async () => undefined);
    const runtime = createAcpRuntime({
      provider: 'codex',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => {
        throw new Error('backend should not be created for pending pump test');
      },
      inFlightSteer: { enabled: true },
      pendingQueue: {
        drainDuringTurn: true,
        inputConsumer: { drainPending, pumpPendingWhileActive },
      },
    });

    runtime.beginTurn();
    await nextTick();

    expect(pumpPendingWhileActive).toHaveBeenCalledTimes(1);
    expect(drainPending).not.toHaveBeenCalled();

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(pumpPendingWhileActive).toHaveBeenCalledTimes(1);

    await runtime.reset();
  });

  it('stops the pending pump after a terminal auth failure instead of retrying forever', async () => {
    const { session } = createSessionClientWithMetadata();

    const drainPending = vi.fn(async (): Promise<DrainPendingResult> => ({
      materialized: 0,
      stoppedReason: 'auth_failure',
    }));
    const pumpPendingWhileActive = vi.fn(async () => undefined);
    const runtime = createAcpRuntime({
      provider: 'codex',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => {
        throw new Error('backend should not be created for pending pump test');
      },
      inFlightSteer: { enabled: true },
      pendingQueue: {
        drainDuringTurn: true,
        inputConsumer: { drainPending, pumpPendingWhileActive },
      },
    });

    runtime.beginTurn();
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(pumpPendingWhileActive).toHaveBeenCalledTimes(1);
    expect(drainPending).not.toHaveBeenCalled();

    await runtime.reset();
  });

  it('contains pending pump drain errors without surfacing unhandled rejections', async () => {
    const { session } = createSessionClientWithMetadata();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    const drainPending = vi
      .fn<() => Promise<DrainPendingResult>>()
      .mockRejectedValueOnce(new Error('drain failed'))
      .mockResolvedValue({ materialized: 0, stoppedReason: 'no_pending' });
    const pumpPendingWhileActive = vi.fn(async () => {
      throw new Error('drain failed');
    });
    const runtime = createAcpRuntime({
      provider: 'codex',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => {
        throw new Error('backend should not be created for pending pump test');
      },
      inFlightSteer: { enabled: true },
      pendingQueue: {
        drainDuringTurn: true,
        inputConsumer: { drainPending, pumpPendingWhileActive },
      },
    });

    try {
      runtime.beginTurn();
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(pumpPendingWhileActive).toHaveBeenCalledTimes(1);
      expect(drainPending).not.toHaveBeenCalled();
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      await runtime.reset();
    }
  });
});
