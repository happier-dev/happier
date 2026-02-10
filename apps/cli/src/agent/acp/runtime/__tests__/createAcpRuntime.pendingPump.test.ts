import { describe, expect, it } from 'vitest';

import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { createAcpRuntime } from '../createAcpRuntime';
import { createApprovedPermissionHandler, createSessionClientWithMetadata } from '../createAcpRuntime.testkit';

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('createAcpRuntime pending queue pump', () => {
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
});
