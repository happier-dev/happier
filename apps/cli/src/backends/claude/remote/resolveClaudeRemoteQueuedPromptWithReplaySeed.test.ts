import { describe, expect, it } from 'vitest';

import { resolveClaudeRemoteQueuedPromptWithReplaySeed } from './resolveClaudeRemoteQueuedPromptWithReplaySeed';

describe('resolveClaudeRemoteQueuedPromptWithReplaySeed', () => {
  it('prefixes replaySeedV1 and retires it only once Claude accepted the prompt', async () => {
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
    expect(res.seedApplied).toBe(true);
    expect(calls).toEqual(['refresh']);

    await res.settleReplaySeedOnProviderAcceptance();
    expect(calls).toEqual(['refresh', 'consume']);
  });
});
