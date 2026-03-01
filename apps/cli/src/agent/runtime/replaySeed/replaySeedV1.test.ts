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

    expect(calls.map((c) => c.kind)).toEqual(['refresh', 'consume']);
    expect(res.providerPrompt).toBe('SEED\n\nhello');
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

    expect(calls.map((c) => c.kind)).toEqual(['ensure', 'consume']);
    expect(res.providerPrompt).toBe('SEED\n\nhello');
  });
});
