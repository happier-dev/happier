import { describe, expect, it } from 'vitest';

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

    expect(calls.map((c) => c.kind)).toEqual(['refresh']);
    expect(res.providerPrompt).toBe('SEED\n\nhello');

    await res.settleReplaySeedOnProviderAcceptance();
    expect(calls.map((c) => c.kind)).toEqual(['refresh', 'consume']);
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
    expect(res.providerPrompt).toBe('SEED\n\nhello');

    await res.settleReplaySeedOnProviderAcceptance();
    expect(calls.map((c) => c.kind)).toEqual(['ensure', 'consume']);
  });
});

/**
 * The seed is the target runtime's only carry-over context. Retiring it at prompt
 * composition destroys it whenever the provider never accepts that prompt, so the
 * seed is scoped to provider acceptance instead.
 */
describe('replaySeedV1 provider-acceptance settlement', () => {
  function createSeededSession() {
    let metadata: any = {
      replaySeedV1: {
        v: 1,
        seedText: 'SEED',
        sourceSessionId: 'parent',
        sourceCutoffSeqInclusive: 3,
        createdAtMs: 123,
      },
    };
    let updateMetadataError: unknown = null;
    return {
      session: {
        getMetadataSnapshot: () => metadata,
        updateMetadata: async (updater: (current: any) => any) => {
          if (updateMetadataError) throw updateMetadataError;
          metadata = updater(metadata);
        },
      },
      readSeed: () => readReplaySeedV1FromMetadata(metadata),
      failNextUpdates: (error: unknown) => {
        updateMetadataError = error;
      },
    };
  }

  const resolveOnce = async (session: any, localId: string) => await resolveProviderPromptWithReplaySeed({
    session,
    userText: 'hello',
    allowSeed: true,
    localId,
    nowMs: 999,
    refreshMetadataBeforeRead: false,
  });

  it('does not retire the seed at prompt composition', async () => {
    const harness = createSeededSession();

    const res = await resolveOnce(harness.session, 'local-1');

    expect(res.providerPrompt).toBe('SEED\n\nhello');
    expect(res.seedApplied).toBe(true);
    expect(harness.readSeed()?.seedText).toBe('SEED');
    expect(harness.readSeed()?.appliedToLocalId).toBeUndefined();
  });

  it('retires the seed once the provider accepted the prompt it was prefixed to', async () => {
    const harness = createSeededSession();

    const res = await resolveOnce(harness.session, 'local-1');
    expect(await res.settleReplaySeedOnProviderAcceptance()).toEqual({ status: 'retired' });

    expect(harness.readSeed()?.seedText).toBe('');
    expect(harness.readSeed()?.appliedToLocalId).toBe('local-1');
    expect(harness.readSeed()?.appliedAtMs).toBe(999);
  });

  it('keeps the seed available for the next attempt when the prompt was rejected before effect', async () => {
    const harness = createSeededSession();

    const rejected = await resolveOnce(harness.session, 'local-1');
    expect(rejected.seedApplied).toBe(true);
    // No settlement: the provider never accepted this prompt.

    const retried = await resolveOnce(harness.session, 'local-2');
    expect(retried.providerPrompt).toBe('SEED\n\nhello');
    expect(retried.seedApplied).toBe(true);

    expect(await retried.settleReplaySeedOnProviderAcceptance()).toEqual({ status: 'retired' });
    expect(harness.readSeed()?.appliedToLocalId).toBe('local-2');
  });

  it('settles at most once for one accepted prompt', async () => {
    const harness = createSeededSession();

    const res = await resolveOnce(harness.session, 'local-1');
    expect(await res.settleReplaySeedOnProviderAcceptance()).toEqual({ status: 'retired' });
    expect(await res.settleReplaySeedOnProviderAcceptance()).toEqual({ status: 'not_applicable' });
  });

  it('reports a settlement that never happened instead of swallowing it', async () => {
    const harness = createSeededSession();
    const failure = new Error('metadata write unavailable');

    const res = await resolveOnce(harness.session, 'local-1');
    harness.failNextUpdates(failure);

    expect(await res.settleReplaySeedOnProviderAcceptance()).toEqual({ status: 'failed', error: failure });
    // The seed is still live, so the next prompt still carries the context.
    expect(harness.readSeed()?.seedText).toBe('SEED');
  });

  it('is not applicable when no seed was applied', async () => {
    const session = {
      getMetadataSnapshot: () => ({}),
      updateMetadata: async () => {
        throw new Error('must not write metadata when no seed applied');
      },
    };

    const res = await resolveOnce(session, 'local-1');

    expect(res.seedApplied).toBe(false);
    expect(await res.settleReplaySeedOnProviderAcceptance()).toEqual({ status: 'not_applicable' });
  });
});
