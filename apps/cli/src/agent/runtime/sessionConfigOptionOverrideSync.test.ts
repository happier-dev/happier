import { describe, expect, it, vi } from 'vitest';

import type { RuntimeConfigUpdateOutcomeV1 } from '@happier-dev/agents';

import type { Metadata } from '@/api/types';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createSessionConfigOptionOverrideSynchronizer } from './sessionConfigOptionOverrideSync';

describe('createSessionConfigOptionOverrideSynchronizer', () => {
  it('settles a definitive rejection once, clears its intent and keeps newer edits runnable', async () => {
    // fx 0.0.14 wire capture: E-fx-live-probe.md §3, 2026-10-27, provider=gateway / -32600.
    const reason = 'fx needs access to Vercel AI Gateway. Run fx login to sign in, fx setup to use an API key, or set AI_GATEWAY_API_KEY.';
    let metadata = createTestMetadata({ sessionConfigOptionOverridesV1: { v: 1, updatedAt: 30,
      overrides: { provider: { updatedAt: 30, value: 'gateway' }, effort: { updatedAt: 20, value: 'high' } } } });
    const rejected: string[] = [];
    const applied: Array<readonly [string, string | number | boolean | null]> = [];
    const sync = createSessionConfigOptionOverrideSynchronizer({
      session: { getMetadataSnapshot: () => metadata,
        updateMetadataAsCurrentPublisher: async update => { metadata = update(metadata); } },
      runtime: { setSessionConfigOption: async (id, value) => {
        applied.push([id, value]);
        return id === 'provider' && value === 'gateway' ? { status: 'failed', reason } : { status: 'applied' };
      } },
      isStarted: () => true,
      onConfigOptionRejected: async ({ outcome }) => { rejected.push(outcome.reason ?? ''); },
    });
    sync.syncFromMetadata();
    await sync.flushPendingAfterStart();
    expect(metadata.sessionConfigOptionOverridesV1?.overrides).toEqual({ effort: { updatedAt: 20, value: 'high' } });
    for (let i = 0; i < 3; i += 1) { sync.syncFromMetadata(); await sync.flushPendingAfterStart(); }
    expect(applied.filter(([id]) => id === 'provider')).toEqual([['provider', 'gateway']]);
    expect(rejected).toEqual([reason]);
    metadata = { ...metadata, sessionConfigOptionOverridesV1: { v: 1, updatedAt: 31,
      overrides: { provider: { updatedAt: 31, value: 'codex' } } } };
    sync.syncFromMetadata();
    await sync.flushPendingAfterStart();
    expect(applied.at(-1)).toEqual(['provider', 'codex']);
  });

  it.each([' selected ', '', ' '])('keeps exact opaque config ids and value %j through metadata reconciliation', async value => {
    const setSessionConfigOption = vi.fn(async (_id: string, _value: string | number | boolean | null) => {});
    const sync = createSessionConfigOptionOverrideSynchronizer({
      session: { getMetadataSnapshot: () => createTestMetadata({ sessionConfigOptionOverridesV1: { v: 1, updatedAt: 1,
        overrides: { ' custom ': { updatedAt: 1, value } } } }) },
      runtime: { setSessionConfigOption }, isStarted: () => true,
    });
    sync.syncFromMetadata();
    await sync.flushPendingAfterStart();
    expect(setSessionConfigOption).toHaveBeenCalledWith(' custom ', value);
  });

  it('preserves an edit arriving during a rejected setter and applies the newer value', async () => {
    let metadata = createTestMetadata({ sessionConfigOptionOverridesV1: { v: 1, updatedAt: 1,
      overrides: { provider: { updatedAt: 1, value: 'gateway' } } } });
    let rejectCandidate!: (outcome: RuntimeConfigUpdateOutcomeV1) => void;
    const first = new Promise<RuntimeConfigUpdateOutcomeV1>(resolve => { rejectCandidate = resolve; });
    const values: Array<string | number | boolean | null> = [];
    const sync = createSessionConfigOptionOverrideSynchronizer({
      session: { getMetadataSnapshot: () => metadata,
        updateMetadataAsCurrentPublisher: async update => { metadata = update(metadata); } },
      runtime: { setSessionConfigOption: async (_id, value) => {
        values.push(value);
        return value === 'gateway' ? first : { status: 'applied' };
      } }, isStarted: () => true,
    });
    sync.syncFromMetadata();
    metadata = { ...metadata, sessionConfigOptionOverridesV1: { v: 1, updatedAt: 2,
      overrides: { provider: { updatedAt: 2, value: 'codex' } } } };
    sync.syncFromMetadata();
    rejectCandidate({ status: 'failed', reason: 'Sign in required' });
    await sync.flushPendingAfterStart();
    await sync.flushPendingAfterStart();
    expect(metadata.sessionConfigOptionOverridesV1?.overrides.provider).toEqual({ updatedAt: 2, value: 'codex' });
    expect(values).toEqual(['gateway', 'codex']);
  });

  it.each(['failed', 'unsupported'] as const)('does not retry a %s candidate even when its metadata publication fails', async status => {
    const metadata = createTestMetadata({ sessionConfigOptionOverridesV1: { v: 1, updatedAt: 1,
      overrides: { provider: { updatedAt: 1, value: 'gateway' } } } });
    const attempted: string[] = [];
    const reported: string[] = [];
    const sync = createSessionConfigOptionOverrideSynchronizer({
      session: { getMetadataSnapshot: () => metadata,
        updateMetadataAsCurrentPublisher: async () => { throw new Error('offline'); } },
      runtime: { setSessionConfigOption: async id => {
        attempted.push(id);
        return { status, reason: 'Native configuration refused' };
      } }, isStarted: () => true,
      onConfigOptionRejected: ({ outcome }) => { reported.push(outcome.reason ?? ''); },
    });
    for (let i = 0; i < 3; i += 1) { sync.syncFromMetadata(); await sync.flushPendingAfterStart(); }
    expect(attempted).toEqual(['provider']);
    expect(reported).toEqual(['Native configuration refused']);
  });

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

  it.each<RuntimeConfigUpdateOutcomeV1>([
    { status: 'applied' },
    { status: 'unsupported', timing: 'skipped_already_effective' },
  ])('settles an effective outcome %j without reporting rejection', async outcome => {
    const rejected: string[] = [];
    const setSessionConfigOption = vi
      .fn<(_configId: string, _value: any) => Promise<RuntimeConfigUpdateOutcomeV1 | void>>()
      .mockResolvedValue(outcome);

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
      onConfigOptionRejected: ({ outcome }) => { rejected.push(outcome.status); },
    });

    sync.syncFromMetadata();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(setSessionConfigOption).toHaveBeenCalledTimes(1);

    sync.syncFromMetadata();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(setSessionConfigOption).toHaveBeenCalledTimes(1);
    expect(rejected).toEqual([]);
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
