import { describe, expect, it } from 'vitest';

import { HttpStatusError } from '@/api/client/httpStatusError';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { createAcpRuntime } from '../createAcpRuntime';
import type { AcpRuntimeBackend } from '../createAcpRuntime';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createSessionClientWithMetadata } from '@/testkit/backends/sessionFixtures';

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('createAcpRuntime pending queue pump', () => {
  it('drains pending messages once after loading a resumable session when opted in', async () => {
    const { session } = createSessionClientWithMetadata();

    const calls: string[] = [];
    let popCalls = 0;
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
        waitForMetadataUpdate: async () => false,
        popPendingMessage: async () => {
          popCalls += 1;
          calls.push('pop');
          return false;
        },
      },
    });

    await runtime.startOrLoad({ resumeId: 'resume-1', importHistory: false });

    expect(popCalls).toBe(1);
    expect(calls).toEqual(['load:resume-1', 'pop']);

    await runtime.reset();
  });

  it('does not drain pending messages by default when a steer-capable turn begins', async () => {
    const { session } = createSessionClientWithMetadata();

    let popCalls = 0;
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
        waitForMetadataUpdate: async (abortSignal?: AbortSignal) =>
          await new Promise<boolean>((resolve) => {
            if (abortSignal?.aborted) return resolve(false);
            abortSignal?.addEventListener('abort', () => resolve(false), { once: true });
          }),
        popPendingMessage: async () => {
          popCalls += 1;
          return false;
        },
      },
    });

    runtime.beginTurn();
    await nextTick();

    expect(popCalls).toBe(0);

    await runtime.reset();
  });

  it('drains existing pending messages immediately when a steer-capable turn begins', async () => {
    const { session } = createSessionClientWithMetadata();

    let pending = 1;
    let popCalls = 0;
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
        waitForMetadataUpdate: async (abortSignal?: AbortSignal) =>
          await new Promise<boolean>((resolve) => {
            if (abortSignal?.aborted) return resolve(false);
            abortSignal?.addEventListener('abort', () => resolve(false), { once: true });
          }),
        popPendingMessage: async () => {
          popCalls += 1;
          if (pending > 0) {
            pending -= 1;
            return true;
          }
          return false;
        },
      },
    });

    runtime.beginTurn();
    await nextTick();

    // If the pump waits only on metadata updates, pre-existing pending messages can be stranded
    // until a later update event arrives (which breaks in-flight steer). We should drain at least once.
    expect(popCalls).toBeGreaterThan(0);

    await runtime.reset();
  });

  it('drains newly enqueued pending messages even when there are no metadata wakeups', async () => {
    const { session } = createSessionClientWithMetadata();

    let pending = 0;
    let popCalls = 0;
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
        pollIntervalMs: 5,
        // Simulate a server that never publishes metadata wakeups for pending queue changes.
        waitForMetadataUpdate: async (abortSignal?: AbortSignal) =>
          await new Promise<boolean>((resolve) => {
            if (abortSignal?.aborted) return resolve(false);
            abortSignal?.addEventListener('abort', () => resolve(false), { once: true });
          }),
        popPendingMessage: async () => {
          popCalls += 1;
          if (pending > 0) {
            pending -= 1;
            return true;
          }
          return false;
        },
      },
    });

    runtime.beginTurn();
    await nextTick();

    // No pending at beginTurn, so the initial drain sees nothing.
    expect(popCalls).toBeGreaterThan(0);

    // Enqueue a pending message after the pump is already waiting. Without a polling fallback,
    // this would be stranded until some unrelated metadata event.
    pending = 1;
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(pending).toBe(0);

    await runtime.reset();
  });

  it('stops the pending pump after a terminal auth failure instead of retrying forever', async () => {
    const { session } = createSessionClientWithMetadata();

    let popCalls = 0;
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
        pollIntervalMs: 5,
        waitForMetadataUpdate: async (abortSignal?: AbortSignal) =>
          await new Promise<boolean>((resolve) => {
            if (abortSignal?.aborted) return resolve(false);
            abortSignal?.addEventListener('abort', () => resolve(false), { once: true });
          }),
        popPendingMessage: async () => {
          popCalls += 1;
          throw new HttpStatusError(401, 'Authentication failed');
        },
      },
    });

    runtime.beginTurn();
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(popCalls).toBe(1);

    await runtime.reset();
  });
});
