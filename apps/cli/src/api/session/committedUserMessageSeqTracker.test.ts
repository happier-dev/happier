import { describe, expect, it } from 'vitest';

import { CommittedUserMessageSeqTracker } from './committedUserMessageSeqTracker';

describe('CommittedUserMessageSeqTracker', () => {
    it('ignores fractional committed message seqs', () => {
        const tracker = new CommittedUserMessageSeqTracker();

        expect(tracker.record('local-1', 55.9)).toBeNull();
        expect(tracker.get('local-1')).toBeNull();
    });
});
