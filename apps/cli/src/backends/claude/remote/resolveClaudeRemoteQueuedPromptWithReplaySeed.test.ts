import { describe, expect, it } from 'vitest';

import { resolveClaudeRemoteQueuedPromptWithReplaySeed } from './resolveClaudeRemoteQueuedPromptWithReplaySeed';

describe('resolveClaudeRemoteQueuedPromptWithReplaySeed', () => {
  it('prefixes replaySeedV1 and consumes it (refreshing metadata once on first use)', async () => {
    const calls: string[] = [];
    let metadata: any = {};

    const sessionClient = {
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

    const res = await resolveClaudeRemoteQueuedPromptWithReplaySeed({
      sessionClient,
      batch: {
        message: 'hello',
        mode: { localId: 'local-1', replaySeedAllowed: true },
      },
      didBootstrap: false,
    });

    expect(res.didBootstrap).toBe(true);
    expect(res.message).toBe('SEED\n\nhello');
    expect(calls).toEqual(['refresh', 'consume']);
  });
});
