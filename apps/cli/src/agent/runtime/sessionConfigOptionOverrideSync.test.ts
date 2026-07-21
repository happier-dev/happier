import { describe, expect, it, vi } from 'vitest';

import { createSessionConfigOptionOverrideSynchronizer } from './sessionConfigOptionOverrideSync';
import { SessionControlApplyError } from './sessionControlApplyError';

describe('createSessionConfigOptionOverrideSynchronizer', () => {
  it('queues pending overrides before runtime start and applies after start', async () => {
    let started = false;
    const setSessionConfigOption = vi.fn(async (_configId: string, _value: any) => {});

    const sync = createSessionConfigOptionOverrideSynchronizer({
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

    const sync = createSessionConfigOptionOverrideSynchronizer({
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

  it('reads generic sessionConfigOptionOverridesV1 metadata', async () => {
    const setSessionConfigOption = vi.fn(async (_configId: string, _value: any) => {});

    const sync = createSessionConfigOptionOverrideSynchronizer({
      session: {
        getMetadataSnapshot: () =>
          ({
            sessionConfigOptionOverridesV1: {
              v: 1,
              updatedAt: 22,
              overrides: {
                speed: { updatedAt: 22, value: 'fast' },
              },
            },
          }) as any,
      },
      runtime: { setSessionConfigOption },
      isStarted: () => true,
    });

    sync.syncFromMetadata();
    expect(setSessionConfigOption).toHaveBeenCalledWith('speed', 'fast');
  });

  it('uses a newer valid legacy alias over an older canonical command root', async () => {
    const setSessionConfigOption = vi.fn(async () => undefined);
    const sync = createSessionConfigOptionOverrideSynchronizer({
      session: {
        getMetadataSnapshot: () => ({
          sessionConfigOptionOverridesV1: {
            v: 1, updatedAt: 20, overrides: { speed: { updatedAt: 20, value: 'slow' } },
          },
          acpConfigOptionOverridesV1: {
            v: 1, updatedAt: 21, overrides: { speed: { updatedAt: 21, value: 'fast' } },
          },
        }) as any,
      },
      runtime: { setSessionConfigOption },
      isStarted: () => true,
    });
    sync.syncFromMetadata();
    await sync.flushPendingAfterStart();
    expect(setSessionConfigOption).toHaveBeenCalledWith('speed', 'fast');
    expect(setSessionConfigOption).not.toHaveBeenCalledWith('speed', 'slow');
  });

  it('uses an older valid legacy command root when canonical is newer but malformed', async () => {
    const setSessionConfigOption = vi.fn(async () => undefined);
    const sync = createSessionConfigOptionOverrideSynchronizer({
      session: {
        getMetadataSnapshot: () => ({
          sessionConfigOptionOverridesV1: {
            v: 1,
            updatedAt: 30,
            overrides: { speed: { updatedAt: 'invalid', value: 'slow' } },
          },
          acpConfigOptionOverridesV1: {
            v: 1,
            updatedAt: 20,
            overrides: { speed: { updatedAt: 20, value: 'fast' } },
          },
        }) as any,
      },
      runtime: { setSessionConfigOption },
      isStarted: () => true,
    });

    sync.syncFromMetadata();
    await sync.flushPendingAfterStart();

    expect(setSessionConfigOption).toHaveBeenCalledWith('speed', 'fast');
    expect(setSessionConfigOption).not.toHaveBeenCalledWith('speed', 'slow');
  });

  it('retries immediate apply on next sync when setSessionConfigOption fails', async () => {
    const setSessionConfigOption = vi
      .fn<(_configId: string, _value: any) => Promise<void>>()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValue(undefined);

    const sync = createSessionConfigOptionOverrideSynchronizer({
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

  it('ignores nullable clears and terminalizes a definitive rejection once', async () => {
    let metadata: any = {
      sessionConfigOptionOverridesV1: {
        v: 1,
        updatedAt: 30,
        overrides: { reasoning_effort: { updatedAt: 30, value: 'high' } },
      },
    };
    const report = vi.fn();
    const setSessionConfigOption = vi.fn(async () => {
      throw SessionControlApplyError.definitive(new Error('unsupported effort'));
    });
    const sync = createSessionConfigOptionOverrideSynchronizer({
      session: {
        getMetadataSnapshot: () => metadata,
        updateMetadata: async (updater) => { metadata = updater(metadata); },
      },
      runtime: { setSessionConfigOption },
      isStarted: () => true,
      reportTerminalFailure: report,
    });

    sync.syncFromMetadata();
    await sync.flushPendingAfterStart();
    await sync.flushPendingAfterStart();

    expect(metadata.sessionConfigOptionOverridesV1.overrides.reasoning_effort.value).toBeNull();
    expect(setSessionConfigOption).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledTimes(1);
  });

  it('does not clear a newer effort choice after an older rejection settles', async () => {
    let metadata: any = {
      sessionConfigOptionOverridesV1: {
        v: 1,
        updatedAt: 30,
        overrides: { reasoning_effort: { updatedAt: 30, value: 'high' } },
      },
    };
    let reject!: (error: unknown) => void;
    const applying = new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; });
    const sync = createSessionConfigOptionOverrideSynchronizer({
      session: {
        getMetadataSnapshot: () => metadata,
        updateMetadata: async (updater) => { metadata = updater(metadata); },
      },
      runtime: { setSessionConfigOption: vi.fn(() => applying) },
      isStarted: () => true,
      reportTerminalFailure: vi.fn(),
    });

    sync.syncFromMetadata();
    metadata = {
      sessionConfigOptionOverridesV1: {
        v: 1,
        updatedAt: 31,
        overrides: { reasoning_effort: { updatedAt: 31, value: 'low' } },
      },
    };
    reject(SessionControlApplyError.definitive(new Error('unsupported')));
    await sync.flushPendingAfterStart();

    expect(metadata.sessionConfigOptionOverridesV1.overrides.reasoning_effort).toEqual({ updatedAt: 31, value: 'low' });
  });

  it('retries cleanup without reissuing a definitively rejected config command', async () => {
    let metadata: any = {
      sessionConfigOptionOverridesV1: {
        v: 1,
        updatedAt: 30,
        overrides: { reasoning_effort: { updatedAt: 30, value: 'high' } },
      },
    };
    let cleanupAttempts = 0;
    const setSessionConfigOption = vi.fn(async () => {
      throw SessionControlApplyError.definitive(new Error('unsupported'));
    });
    const sync = createSessionConfigOptionOverrideSynchronizer({
      session: {
        getMetadataSnapshot: () => metadata,
        updateMetadata: async (updater) => {
          cleanupAttempts += 1;
          if (cleanupAttempts === 1) throw new Error('offline');
          metadata = updater(metadata);
        },
      },
      runtime: { setSessionConfigOption },
      isStarted: () => true,
    });

    sync.syncFromMetadata();
    await sync.flushPendingAfterStart();
    await sync.flushPendingAfterStart();

    expect(setSessionConfigOption).toHaveBeenCalledTimes(1);
    expect(cleanupAttempts).toBe(2);
    expect(metadata.sessionConfigOptionOverridesV1.overrides.reasoning_effort).toEqual({
      updatedAt: 31,
      value: null,
    });
  });

  it('applies a same-timestamp different config value that replaces a rejected in-flight command', async () => {
    let metadata: any = {
      sessionConfigOptionOverridesV1: {
        v: 1,
        updatedAt: 30,
        overrides: { reasoning_effort: { updatedAt: 30, value: 'high' } },
      },
    };
    let rejectFirst!: (error: unknown) => void;
    const firstApply = new Promise<void>((_resolve, reject) => { rejectFirst = reject; });
    const setSessionConfigOption = vi.fn()
      .mockImplementationOnce(() => firstApply)
      .mockResolvedValue(undefined);
    const sync = createSessionConfigOptionOverrideSynchronizer({
      session: {
        getMetadataSnapshot: () => metadata,
        updateMetadata: async (updater) => { metadata = updater(metadata); },
      },
      runtime: { setSessionConfigOption },
      isStarted: () => true,
    });

    sync.syncFromMetadata();
    metadata = {
      sessionConfigOptionOverridesV1: {
        v: 1,
        updatedAt: 30,
        overrides: { reasoning_effort: { updatedAt: 30, value: 'low' } },
      },
    };
    sync.syncFromMetadata();
    rejectFirst(SessionControlApplyError.definitive(new Error('unsupported')));
    await sync.flushPendingAfterStart();
    await sync.flushPendingAfterStart();

    expect(setSessionConfigOption.mock.calls).toEqual([
      ['reasoning_effort', 'high'],
      ['reasoning_effort', 'low'],
    ]);
  });
});
