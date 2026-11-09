import { describe, expect, it } from 'vitest';
import { SessionFollowInputV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import { prepareSessionInputForProviderDispatch } from './prepareSessionInputForProviderDispatch';

describe('Follow at the final provider input boundary', () => {
  it.each(['execution_run', 'workflow_run'] as const)('keeps %s delivery informational without inviting an unauthorized read', async kind => {
    const delivery = SessionFollowInputV1Schema.parse({ v: 1, delivery: 'wake', event: { kind: 'failed_or_stopped' },
      original: kind === 'execution_run'
        ? { source: { kind, sessionId: 'source', runId: 'failed-run' }, terminalEventId: 'terminal' }
        : { source: { kind, runId: 'failed-run' }, revision: 2 } });
    const followDeliveries = [{ delivery, localInputId: 'follow-input', userMessageSeq: 1 }];
    const prepared = await prepareSessionInputForProviderDispatch({
      prompt: { text: 'Followed source changed.', localId: 'follow-input', followDeliveries }, transformedUserText: 'Followed source changed.',
      providerNativeCommand: false, signal: new AbortController().signal, localId: 'follow-input',
    });
    const prompt = prepared.renderPrompt({ runFollowDeliveries: followDeliveries });
    expect(prompt).toContain('failed-run');
    expect(prompt).toContain('failed_or_stopped');
    expect(prompt).not.toContain('Read the original Run result.');
    expect(prompt).toContain('Use the delivered context.');
    expect(prompt).toContain('only through an independently authorized read');
    expect(prompt).toContain('following grants no access');
  });
});
