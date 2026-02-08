import { describe, expect, it, vi } from 'vitest';

import { createAcpConfigOptionOverrideSynchronizer } from './acpConfigOptionOverrideSync';

describe('createAcpConfigOptionOverrideSynchronizer', () => {
  it('queues pending overrides before runtime start and applies after start', async () => {
    let started = false;
    const setSessionConfigOption = vi.fn(async (_configId: string, _value: any) => {});

    const sync = createAcpConfigOptionOverrideSynchronizer({
      session: {
        getMetadataSnapshot: () =>
          ({
            acpConfigOptionOverridesV1: {
              v: 1,
              updatedAt: 20,
              overrides: {
                telemetry: { updatedAt: 10, value: true },
                mode: { updatedAt: 20, value: 'ask' },
              },
            },
          }) as any,
      },
      runtime: { setSessionConfigOption },
      isStarted: () => started,
    });

    sync.syncFromMetadata();
    expect(setSessionConfigOption).not.toHaveBeenCalled();

    started = true;
    await sync.flushPendingAfterStart();

    expect(setSessionConfigOption).toHaveBeenCalledWith('telemetry', 'true');
    expect(setSessionConfigOption).toHaveBeenCalledWith('mode', 'ask');
  });

  it('applies overrides immediately once started', async () => {
    const setSessionConfigOption = vi.fn(async (_configId: string, _value: any) => {});

    const sync = createAcpConfigOptionOverrideSynchronizer({
      session: {
        getMetadataSnapshot: () =>
          ({
            acpConfigOptionOverridesV1: {
              v: 1,
              updatedAt: 21,
              overrides: {
                telemetry: { updatedAt: 21, value: false },
              },
            },
          }) as any,
      },
      runtime: { setSessionConfigOption },
      isStarted: () => true,
    });

    sync.syncFromMetadata();
    expect(setSessionConfigOption).toHaveBeenCalledWith('telemetry', 'false');
  });

  it('retries immediate apply on next sync when setSessionConfigOption fails', async () => {
    const setSessionConfigOption = vi
      .fn<(_configId: string, _value: any) => Promise<void>>()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValue(undefined);

    const sync = createAcpConfigOptionOverrideSynchronizer({
      session: {
        getMetadataSnapshot: () =>
          ({
            acpConfigOptionOverridesV1: {
              v: 1,
              updatedAt: 30,
              overrides: {
                telemetry: { updatedAt: 30, value: true },
              },
            },
          }) as any,
      },
      runtime: { setSessionConfigOption },
      isStarted: () => true,
    });

    sync.syncFromMetadata();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(setSessionConfigOption).toHaveBeenCalledTimes(1);

    sync.syncFromMetadata();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(setSessionConfigOption).toHaveBeenCalledTimes(2);
    expect(setSessionConfigOption).toHaveBeenNthCalledWith(2, 'telemetry', 'true');
  });
});
