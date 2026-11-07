import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindApiSessionSocketMock, createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { startConnectedServiceQuotasLoop } from '@/daemon/connectedServices/quotas/startConnectedServiceQuotasLoop';

const io = vi.hoisted(() => vi.fn());
vi.mock('socket.io-client', () => ({ io }));

describe('provider usage refresh wake-up', () => {
  afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });
  it('wakes the quota owner immediately without waiting for its ordinary tick', async () => {
    vi.useFakeTimers();
    const socket = createApiSessionSocketStub();
    bindApiSessionSocketMock(io, socket);
    const { ApiMachineClient } = await import('./apiMachine');
    const client = new ApiMachineClient('test', {
      id: 'machine-1', encryptionKey: new Uint8Array(32).fill(1), encryptionVariant: 'legacy',
      metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0,
    });
    let ticks = 0;
    const loop = startConnectedServiceQuotasLoop({ enabled: true, tickMs: 60_000,
      coordinator: { tickOnce: async () => { ticks += 1; } }, onTickError: (error) => { throw error; } });
    const detach = client.onProviderAccountUsageRefreshRequested(() => loop?.wake());
    client.connect();
    try {
      expect(ticks).toBe(0);
      socket.getHandler('ephemeral')?.({ type: 'provider-account-usage-refresh-requested' });
      await vi.advanceTimersByTimeAsync(0);
      expect(ticks).toBe(1);
      detach();
      socket.getHandler('ephemeral')?.({ type: 'provider-account-usage-refresh-requested' });
      await vi.advanceTimersByTimeAsync(0);
      expect(ticks).toBe(1);
    } finally {
      await loop?.stop();
      await client.shutdown();
    }
  });
});
