import { describe, expect, it, vi } from 'vitest';

import {
  buildProviderPromptWithReplaySeed,
  createReplaySeedV1ConsumeUpdater,
  readReplaySeedV1FromMetadata,
  resolveProviderPromptWithReplaySeed,
} from './replaySeedV1';

describe('replaySeedV1', () => {
  it('builds a provider prompt by prefixing the seed and marks it consumable', () => {
    const metadata = {
      replaySeedV1: {
        v: 1,
        seedText: 'SEED',
        sourceSessionId: 'parent',
        sourceCutoffSeqInclusive: 3,
        createdAtMs: 123,
      },
    };

    const res = buildProviderPromptWithReplaySeed({ metadata, userText: 'hello', allowSeed: true });
    expect(res.providerPrompt).toBe('SEED\n\nhello');
    expect(res.shouldConsumeSeed).toBe(true);
  });

  it('does not apply when seed consumption is disallowed', () => {
    const metadata = {
      replaySeedV1: {
        v: 1,
        seedText: 'SEED',
        sourceSessionId: 'parent',
        sourceCutoffSeqInclusive: 3,
        createdAtMs: 123,
      },
    };

    const res = buildProviderPromptWithReplaySeed({ metadata, userText: 'hello', allowSeed: false });
    expect(res.providerPrompt).toBe('hello');
    expect(res.shouldConsumeSeed).toBe(false);
  });

  it('does not apply when the seed has already been consumed', () => {
    const metadata = {
      replaySeedV1: {
        v: 1,
        seedText: 'SEED',
        sourceSessionId: 'parent',
        sourceCutoffSeqInclusive: 3,
        createdAtMs: 123,
        appliedToLocalId: 'local-1',
      },
    };

    const res = buildProviderPromptWithReplaySeed({ metadata, userText: 'hello', allowSeed: true });
    expect(res.providerPrompt).toBe('hello');
    expect(res.shouldConsumeSeed).toBe(false);
  });

  it('consume updater clears the seed text and records the applied localId', () => {
    const nowMs = 456;
    const metadata = {
      replaySeedV1: {
        v: 1,
        seedText: 'SEED',
        sourceSessionId: 'parent',
        sourceCutoffSeqInclusive: 3,
        createdAtMs: 123,
      },
    };

    const updater = createReplaySeedV1ConsumeUpdater({ localId: 'local-1', nowMs });
    const next = updater(metadata);
    const seed = readReplaySeedV1FromMetadata(next);
    expect(seed?.seedText).toBe('');
    expect(seed?.appliedToLocalId).toBe('local-1');
    expect(seed?.appliedAtMs).toBe(nowMs);
  });

  it('consume updater records a non-empty appliedToLocalId even when localId is missing', () => {
    const nowMs = 456;
    const metadata = {
      replaySeedV1: {
        v: 1,
        seedText: 'SEED',
        sourceSessionId: 'parent',
        sourceCutoffSeqInclusive: 3,
        createdAtMs: 123,
      },
    };

    const updater = createReplaySeedV1ConsumeUpdater({ localId: null, nowMs });
    const next = updater(metadata);
    const seed = readReplaySeedV1FromMetadata(next);
    expect(typeof seed?.appliedToLocalId).toBe('string');
    expect(String(seed?.appliedToLocalId ?? '')).not.toBe('');
  });

  it('resolveProviderPromptWithReplaySeed can refresh metadata before applying the seed', async () => {
    const calls: Array<{ kind: string }> = [];
    let metadata: any = {};
    const session = {
      getMetadataSnapshot: () => metadata,
      refreshSessionSnapshotFromServerBestEffort: async () => {
        calls.push({ kind: 'refresh' });
        metadata = {
          replaySeedV1: {
            v: 1,
            seedText: 'SEED',
            sourceSessionId: 'parent',
            sourceCutoffSeqInclusive: 3,
            createdAtMs: 123,
          },
        };
      },
      updateMetadata: async (_updater: any) => {
        calls.push({ kind: 'consume' });
      },
    };

    const res = await resolveProviderPromptWithReplaySeed({
      session,
      userText: 'hello',
      allowSeed: true,
      localId: 'local-1',
      nowMs: 999,
      refreshMetadataBeforeRead: true,
    });

    // Composition must not retire the seed: the provider call is several awaited steps away.
    expect(calls.map((c) => c.kind)).toEqual(['refresh']);
    expect(res.providerPrompt).toBe('SEED\n\nhello');

    await expect(res.settleOnProviderAcceptance()).resolves.toBe('settled');
    expect(calls.map((c) => c.kind)).toEqual(['refresh', 'consume']);
  });

  it('does not strand prompt delivery when metadata refresh never resolves', async () => {
    vi.useFakeTimers();
    try {
      let metadata: any = {};
      const session = {
        getMetadataSnapshot: () => metadata,
        refreshSessionSnapshotFromServerBestEffort: vi.fn(() => new Promise<void>(() => {})),
        updateMetadata: vi.fn(async (_updater: any) => {
          throw new Error('should not consume a missing seed');
        }),
      };

      const resultPromise = resolveProviderPromptWithReplaySeed({
        session,
        userText: 'hello',
        allowSeed: true,
        localId: 'local-1',
        nowMs: 999,
        refreshMetadataBeforeRead: true,
      });

      await Promise.resolve();
      expect(session.refreshSessionSnapshotFromServerBestEffort).toHaveBeenCalledWith({
        reason: 'waitForMetadataUpdate',
      });

      await vi.advanceTimersByTimeAsync(3_000);
      const result = await Promise.race([
        resultPromise,
        Promise.resolve('still-pending' as const),
      ]);

      expect(result).toMatchObject({
        providerPrompt: 'hello',
        seedApplied: false,
        seedText: '',
      });
      expect(session.updateMetadata).not.toHaveBeenCalled();
      metadata = {
        replaySeedV1: {
          v: 1,
          seedText: 'LATE_SEED',
          sourceSessionId: 'parent',
          sourceCutoffSeqInclusive: 3,
          createdAtMs: 123,
        },
      };
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses a non-empty local metadata snapshot without refreshing before reading replay seed', async () => {
    const calls: Array<{ kind: string }> = [];
    const session = {
      getMetadataSnapshot: () => ({ flavor: 'claude', claudeSessionId: 'resume-1' }),
      refreshSessionSnapshotFromServerBestEffort: async () => {
        calls.push({ kind: 'refresh' });
      },
      updateMetadata: async () => {
        calls.push({ kind: 'consume' });
      },
    };

    const res = await resolveProviderPromptWithReplaySeed({
      session,
      userText: 'hello',
      allowSeed: true,
      localId: 'local-1',
      nowMs: 999,
      refreshMetadataBeforeRead: true,
    });

    expect(calls).toEqual([]);
    expect(res.providerPrompt).toBe('hello');
  });

  it('resolveProviderPromptWithReplaySeed can ensure a metadata snapshot before applying the seed', async () => {
    const calls: Array<{ kind: string }> = [];
    let metadata: any = {};
    const session = {
      getMetadataSnapshot: () => metadata,
      ensureMetadataSnapshot: async () => {
        calls.push({ kind: 'ensure' });
        metadata = {
          replaySeedV1: {
            v: 1,
            seedText: 'SEED',
            sourceSessionId: 'parent',
            sourceCutoffSeqInclusive: 3,
            createdAtMs: 123,
          },
        };
        return metadata;
      },
      updateMetadata: async (_updater: any) => {
        calls.push({ kind: 'consume' });
      },
    };

    const res = await resolveProviderPromptWithReplaySeed({
      session,
      userText: 'hello',
      allowSeed: true,
      localId: 'local-1',
      nowMs: 999,
      refreshMetadataBeforeRead: true,
    });

    expect(calls.map((c) => c.kind)).toEqual(['ensure']);
    await expect(res.settleOnProviderAcceptance()).resolves.toBe('settled');
    expect(calls.map((c) => c.kind)).toEqual(['ensure', 'consume']);
    expect(res.providerPrompt).toBe('SEED\n\nhello');
  });

  it('keeps the seed reusable when the prompt never reaches the provider', async () => {
    const metadata = {
      replaySeedV1: {
        v: 1,
        seedText: 'SEED',
        sourceSessionId: 'parent',
        sourceCutoffSeqInclusive: 3,
        createdAtMs: 123,
      },
    };
    const updateMetadata = vi.fn(async () => {});
    const session = { getMetadataSnapshot: () => metadata, updateMetadata };

    const first = await resolveProviderPromptWithReplaySeed({
      session,
      userText: 'hello',
      allowSeed: true,
      localId: 'local-1',
      nowMs: 999,
      refreshMetadataBeforeRead: false,
    });
    expect(first.providerPrompt).toBe('SEED\n\nhello');
    // Composition happened but the dispatch threw before provider acceptance: no settlement.
    expect(updateMetadata).not.toHaveBeenCalled();

    // The retry still gets the full replay context rather than a bare user prompt.
    const retry = await resolveProviderPromptWithReplaySeed({
      session,
      userText: 'hello',
      allowSeed: true,
      localId: 'local-1',
      nowMs: 1_000,
      refreshMetadataBeforeRead: false,
    });
    expect(retry.providerPrompt).toBe('SEED\n\nhello');
  });

  it('retires an accepted seed exactly once', async () => {
    const updateMetadata = vi.fn(async () => {});
    const session = {
      getMetadataSnapshot: () => ({
        replaySeedV1: {
          v: 1,
          seedText: 'SEED',
          sourceSessionId: 'parent',
          sourceCutoffSeqInclusive: 3,
          createdAtMs: 123,
        },
      }),
      updateMetadata,
    };

    const res = await resolveProviderPromptWithReplaySeed({
      session,
      userText: 'hello',
      allowSeed: true,
      localId: 'local-1',
      nowMs: 999,
      refreshMetadataBeforeRead: false,
    });

    await expect(res.settleOnProviderAcceptance()).resolves.toBe('settled');
    await expect(res.settleOnProviderAcceptance()).resolves.toBe('settled');
    expect(updateMetadata).toHaveBeenCalledTimes(1);
  });

  it('reports a failed settlement instead of silently swallowing it', async () => {
    const session = {
      getMetadataSnapshot: () => ({
        replaySeedV1: {
          v: 1,
          seedText: 'SEED',
          sourceSessionId: 'parent',
          sourceCutoffSeqInclusive: 3,
          createdAtMs: 123,
        },
      }),
      updateMetadata: vi.fn(async () => {
        throw new Error('metadata unavailable');
      }),
    };

    const res = await resolveProviderPromptWithReplaySeed({
      session,
      userText: 'hello',
      allowSeed: true,
      localId: 'local-1',
      nowMs: 999,
      refreshMetadataBeforeRead: false,
    });

    // A swallowed failure is how the same seed silently gets prefixed twice.
    await expect(res.settleOnProviderAcceptance()).resolves.toBe('failed');
  });

  it('reports no settlement work when no seed was applied', async () => {
    const updateMetadata = vi.fn(async () => {});
    const res = await resolveProviderPromptWithReplaySeed({
      session: { getMetadataSnapshot: () => ({ flavor: 'claude' }), updateMetadata },
      userText: 'hello',
      allowSeed: true,
      localId: 'local-1',
      nowMs: 999,
      refreshMetadataBeforeRead: false,
    });

    expect(res.seedApplied).toBe(false);
    await expect(res.settleOnProviderAcceptance()).resolves.toBe('not_applied');
    expect(updateMetadata).not.toHaveBeenCalled();
  });
});
