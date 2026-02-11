import { describe, expect, it, vi } from 'vitest';

import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { createAcpRuntime } from '../createAcpRuntime';
import { createApprovedPermissionHandler, createBasicSessionClient, createFakeAcpRuntimeBackend } from '../createAcpRuntime.testkit';

describe('createAcpRuntime (in-flight steer)', () => {
  it('exposes turn-in-flight state and steerPrompt when enabled', async () => {
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_1' }) as any;
    backend.sendSteerPrompt = vi.fn(async () => {});

    const runtime = createAcpRuntime({
      provider: 'codex',
      directory: '/tmp',
      session: createBasicSessionClient(),
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
      inFlightSteer: { enabled: true },
    } as any);

    expect(typeof (runtime as any).supportsInFlightSteer).toBe('function');
    expect((runtime as any).supportsInFlightSteer()).toBe(true);

    expect(typeof (runtime as any).isTurnInFlight).toBe('function');
    expect((runtime as any).isTurnInFlight()).toBe(false);

    runtime.beginTurn();
    expect((runtime as any).isTurnInFlight()).toBe(true);

    await (runtime as any).startOrLoad({});
    await (runtime as any).steerPrompt('steer text');

    expect(backend.sendSteerPrompt).toHaveBeenCalledWith('sess_1', 'steer text');

    runtime.flushTurn();
    expect((runtime as any).isTurnInFlight()).toBe(false);
  });

  it('does not leak pendingQueue metadata listeners when poll wake wins', async () => {
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_1' }) as any;
    backend.sendSteerPrompt = vi.fn(async () => {});

    let activeMetadataWaits = 0;
    const runtime = createAcpRuntime({
      provider: 'codex',
      directory: '/tmp',
      session: createBasicSessionClient(),
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
      inFlightSteer: { enabled: true },
      pendingQueue: {
        drainDuringTurn: true,
        pollIntervalMs: 5,
        waitForMetadataUpdate: async (signal?: AbortSignal) => {
          activeMetadataWaits += 1;
          return await new Promise<boolean>((resolve) => {
            const onAbort = () => {
              activeMetadataWaits -= 1;
              resolve(false);
            };
            signal?.addEventListener('abort', onAbort, { once: true });
          });
        },
        popPendingMessage: async () => false,
      },
    } as any);

    runtime.beginTurn();
    await (runtime as any).startOrLoad({});

    // Let the pump spin a few times. If poll wake does not cancel the metadata wait,
    // this counter will grow quickly and trip the assertion.
    await vi.waitFor(
      () => {
        expect(activeMetadataWaits).toBeLessThanOrEqual(1);
      },
      { timeout: 250 },
    );

    runtime.flushTurn();
    await vi.waitFor(() => {
      expect(activeMetadataWaits).toBe(0);
    });
  });

  it('throws when sendSteerPrompt is unavailable', async () => {
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_1' }) as any;
    backend.sendPrompt = vi.fn(async () => {});

    const runtime = createAcpRuntime({
      provider: 'codex',
      directory: '/tmp',
      session: createBasicSessionClient(),
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
      inFlightSteer: { enabled: true },
    } as any);

    runtime.beginTurn();
    await (runtime as any).startOrLoad({});
    await expect((runtime as any).steerPrompt('steer fallback')).rejects.toThrow(
      /does not support in-flight steer/i,
    );

    expect(backend.sendPrompt).not.toHaveBeenCalled();

    runtime.flushTurn();
  });
});
