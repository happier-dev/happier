import { describe, expect, it } from 'vitest';

import { resolveClaudeQueuedPromptForDispatch } from './resolveClaudeQueuedPromptForDispatch';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';

describe('resolveClaudeQueuedPromptForDispatch', () => {
  it.each(['/clear', '/checkpoints', '/rewind --confirm'])('preserves attributed local command %s without model context', async command => {
    const result = await resolveClaudeQueuedPromptForDispatch({
      sessionClient: {
        getMetadataSnapshot: () => ({ replaySeedV1: {
          v: 1, seedText: 'prior history', sourceSessionId: 'parent', sourceCutoffSeqInclusive: 3, createdAtMs: 123,
        } }),
        updateMetadata: () => { throw new Error('Local commands must not retire replay context'); },
      },
      batch: {
        message: command, mode: { localId: 'local-command', replaySeedAllowed: true },
        providerPromptMeta: { happierProvenanceV1: { v: 1, kind: 'happierSession', sourceSessionId: 'sender', via: 'mcp' } },
      },
      didBootstrap: true,
    });
    expect(result.message).toBe(command);
    expect(result.seedApplied).toBe(false);
  });

  it('delivers queued sender identity and message through the real shared finalizer', async () => {
    const queue = new MessageQueue2<{ localId: string }>(mode => mode.localId);
    queue.push('review the change', { localId: 'agent-message' }, {
      providerPromptMeta: { happierProvenanceV1: { v: 1, kind: 'happierSession', sourceSessionId: 'claude-sender', via: 'mcp' } },
    });
    const batch = await queue.waitForMessagesAndGetAsString();
    expect(batch).not.toBeNull();
    const result = await resolveClaudeQueuedPromptForDispatch({
      sessionClient: { getMetadataSnapshot: () => ({}), updateMetadata: () => {} },
      batch: batch!, didBootstrap: true,
    });
    expect(result.message).toContain('source_session_id="claude-sender"');
    expect(result.message).toContain('message="review the change"');
  });

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

    const res = await resolveClaudeQueuedPromptForDispatch({
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
