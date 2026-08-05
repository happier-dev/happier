import { describe, expect, it } from 'vitest';

import { createTranscriptFreshnessGate, resolveTranscriptUtteranceIdentity } from './transcriptFreshnessGate';

describe('transcript freshness painted identities', () => {
    it('does not animate a committed row for an utterance already painted while pending', () => {
        const gate = createTranscriptFreshnessGate({ freshnessMs: 5_000, getNowMs: () => 2_000 });
        const utteranceIdentity = resolveTranscriptUtteranceIdentity('local-user-1');
        expect(utteranceIdentity).toBe('utterance:local-user-1');

        gate.markPainted([utteranceIdentity!]);

        expect(gate.isFresh({
            id: 'message:server-user-1',
            createdAt: 1_900,
            paintedIds: [utteranceIdentity!],
        })).toBe(false);
    });
});
