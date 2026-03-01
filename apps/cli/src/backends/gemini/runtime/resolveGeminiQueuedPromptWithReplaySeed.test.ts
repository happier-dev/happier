import { describe, expect, it } from 'vitest';

import { resolveGeminiQueuedPromptWithReplaySeed } from './resolveGeminiQueuedPromptWithReplaySeed';

describe('resolveGeminiQueuedPromptWithReplaySeed', () => {
  it('prefixes replaySeedV1 and consumes it (refreshing metadata once on first use)', async () => {
    const calls: string[] = [];
    let metadata: any = {};

    const session = {
      getMetadataSnapshot: () => metadata,
      refreshSessionSnapshotFromServerBestEffort: async () => {
        calls.push('refresh');
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
      updateMetadata: async () => {
        calls.push('consume');
      },
    };

    const res = await resolveGeminiQueuedPromptWithReplaySeed({
      sessionClient: session,
      text: 'hello',
      localId: 'local-1',
      replaySeedAllowed: true,
      didBootstrap: false,
    });

    expect(res.didBootstrap).toBe(true);
    expect(res.text).toBe('SEED\n\nhello');
    expect(calls).toEqual(['refresh', 'consume']);
  });
});

