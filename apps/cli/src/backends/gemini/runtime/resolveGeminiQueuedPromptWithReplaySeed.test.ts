import { describe, expect, it } from 'vitest';

import { resolveGeminiQueuedPromptWithReplaySeed } from './resolveGeminiQueuedPromptWithReplaySeed';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';

describe('resolveGeminiQueuedPromptWithReplaySeed', () => {
  it('delivers queued sender identity and message through the real shared finalizer', async () => {
    const queue = new MessageQueue2<string>(mode => mode);
    queue.push('review the change', 'remote', {
      providerPromptMeta: { happierProvenanceV1: { v: 1, kind: 'happierSession', sourceSessionId: 'gemini-sender', via: 'action' } },
    });
    const batch = await queue.waitForMessagesAndGetAsString();
    expect(batch).not.toBeNull();
    const result = await resolveGeminiQueuedPromptWithReplaySeed({
      sessionClient: { getMetadataSnapshot: () => ({}), updateMetadata: () => {} },
      text: batch!.message, meta: batch!.providerPromptMeta,
      localId: 'agent-message', replaySeedAllowed: false, didBootstrap: true,
    });
    expect(result.text).toContain('source_session_id="gemini-sender"');
    expect(result.text).toContain('message="review the change"');
  });

  it('prefixes replaySeedV1 and retires it only once Gemini accepted the prompt', async () => {
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
    expect(calls).toEqual(['refresh']);

    await res.settleReplaySeedOnProviderAcceptance();
    expect(calls).toEqual(['refresh', 'consume']);
  });
});

