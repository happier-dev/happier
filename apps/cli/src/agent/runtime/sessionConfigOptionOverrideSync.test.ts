import { describe, expect, it, vi } from 'vitest';

import type { RuntimeConfigUpdateOutcomeV1 } from '@happier-dev/agents';

import type { Metadata } from '@/api/types';
import { createSessionConfigOptionOverrideSynchronizer } from './sessionConfigOptionOverrideSync';

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

    expect(setSessionConfigOption).toHaveBeenCalledWith('telemetry', true);
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
    expect(setSessionConfigOption).toHaveBeenCalledWith('telemetry', false);
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
    expect(setSessionConfigOption).toHaveBeenNthCalledWith(2, 'telemetry', true);
  });

  it('keeps an override pending (re-attempts) when the runtime reports a non-applied outcome', async () => {
    // gap 27: a plugin that swallows/defers the override (e.g. unified terminal already running)
    // returns a non-applied outcome. The synchronizer must NOT mark it applied, so a later sync
    // re-attempts it at the next safe boundary instead of swallowing it forever.
    const setSessionConfigOption = vi
      .fn<(_configId: string, _value: any) => Promise<RuntimeConfigUpdateOutcomeV1 | void>>()
      .mockResolvedValue({ status: 'requires_interactive_control' });

    const sync = createSessionConfigOptionOverrideSynchronizer({
      session: {
        getMetadataSnapshot: () =>
          ({
            sessionConfigOptionOverridesV1: {
              v: 1,
              updatedAt: 40,
              overrides: {
                reasoning_effort: { updatedAt: 40, value: 'high' },
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
    expect(setSessionConfigOption).toHaveBeenLastCalledWith('reasoning_effort', 'high');
  });

  it('marks an override applied (no re-attempt) when the runtime reports an applied outcome', async () => {
    const setSessionConfigOption = vi
      .fn<(_configId: string, _value: any) => Promise<RuntimeConfigUpdateOutcomeV1 | void>>()
      .mockResolvedValue({ status: 'applied' });

    const sync = createSessionConfigOptionOverrideSynchronizer({
      session: {
        getMetadataSnapshot: () =>
          ({
            sessionConfigOptionOverridesV1: {
              v: 1,
              updatedAt: 41,
              overrides: {
                reasoning_effort: { updatedAt: 41, value: 'medium' },
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
    expect(setSessionConfigOption).toHaveBeenCalledTimes(1);
  });

  it('applies the newest config option value across canonical and legacy aliases', async () => {
    const setSessionConfigOption = vi.fn(async (_configId: string, _value: any) => {});

    const sync = createSessionConfigOptionOverrideSynchronizer({
      session: {
        getMetadataSnapshot: () =>
          ({
            sessionConfigOptionOverridesV1: {
              v: 1,
              updatedAt: 10,
              overrides: {
                effort: { updatedAt: 10, value: 'medium' },
              },
            },
            acpConfigOptionOverridesV1: {
              v: 1,
              updatedAt: 20,
              overrides: {
                effort: { updatedAt: 20, value: 'high' },
              },
            },
          }) as any,
      },
      runtime: { setSessionConfigOption },
      isStarted: () => true,
    });

    sync.syncFromMetadata();
    expect(setSessionConfigOption).toHaveBeenCalledWith('effort', 'high');
  });

  it('applies canonical alias tie values after legacy value was applied at the same timestamp', async () => {
    let started = false;
    let metadata: Metadata = {
      path: '/tmp/session',
      host: 'localhost',
      homeDir: '/tmp',
      happyHomeDir: '/tmp/.happier',
      happyLibDir: '/tmp/.happier/lib',
      happyToolsDir: '/tmp/.happier/tools',
      acpConfigOptionOverridesV1: {
        v: 1,
        updatedAt: 20,
        overrides: {
          effort: { updatedAt: 20, value: 'legacy' },
        },
      },
    };
    const setSessionConfigOption = vi.fn(async (_configId: string, _value: string | number | boolean | null) => {});

    const sync = createSessionConfigOptionOverrideSynchronizer({
      session: {
        getMetadataSnapshot: () => metadata,
      },
      runtime: { setSessionConfigOption },
      isStarted: () => started,
    });

    sync.syncFromMetadata();
    expect(setSessionConfigOption).not.toHaveBeenCalled();

    started = true;
    await sync.flushPendingAfterStart();
    expect(setSessionConfigOption).toHaveBeenCalledTimes(1);
    expect(setSessionConfigOption).toHaveBeenLastCalledWith('effort', 'legacy');

    metadata = {
      ...metadata,
      sessionConfigOptionOverridesV1: {
        v: 1,
        updatedAt: 20,
        overrides: {
          effort: { updatedAt: 20, value: 'canonical' },
        },
      },
    };

    sync.syncFromMetadata();
    await Promise.resolve();
    expect(setSessionConfigOption).toHaveBeenCalledTimes(2);
    expect(setSessionConfigOption).toHaveBeenLastCalledWith('effort', 'canonical');

    sync.syncFromMetadata();
    await Promise.resolve();
    expect(setSessionConfigOption).toHaveBeenCalledTimes(2);
  });

  it('applies config option entries that exist only in one alias root', async () => {
    const setSessionConfigOption = vi.fn(async (_configId: string, _value: any) => {});

    const sync = createSessionConfigOptionOverrideSynchronizer({
      session: {
        getMetadataSnapshot: () =>
          ({
            sessionConfigOptionOverridesV1: {
              v: 1,
              updatedAt: 10,
              overrides: {
                effort: { updatedAt: 10, value: 'medium' },
              },
            },
            acpConfigOptionOverridesV1: {
              v: 1,
              updatedAt: 20,
              overrides: {
                speed: { updatedAt: 20, value: 'fast' },
              },
            },
          }) as any,
      },
      runtime: { setSessionConfigOption },
      isStarted: () => true,
    });

    sync.syncFromMetadata();
    expect(setSessionConfigOption).toHaveBeenCalledWith('effort', 'medium');
    expect(setSessionConfigOption).toHaveBeenCalledWith('speed', 'fast');
  });

  it('applies null config option tombstones instead of dropping them', async () => {
    const setSessionConfigOption = vi.fn(async (_configId: string, _value: any) => {});

    const sync = createSessionConfigOptionOverrideSynchronizer({
      session: {
        getMetadataSnapshot: () =>
          ({
            sessionConfigOptionOverridesV1: {
              v: 1,
              updatedAt: 10,
              overrides: {
                effort: { updatedAt: 10, value: null },
              },
            },
          }) as any,
      },
      runtime: { setSessionConfigOption },
      isStarted: () => true,
    });

    sync.syncFromMetadata();
    expect(setSessionConfigOption).toHaveBeenCalledWith('effort', null);
  });
});
