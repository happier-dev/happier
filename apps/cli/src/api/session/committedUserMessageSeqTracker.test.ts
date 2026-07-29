import { describe, expect, it, vi } from 'vitest';

import { CommittedUserMessageSeqTracker } from './committedUserMessageSeqTracker';

describe('CommittedUserMessageSeqTracker', () => {
    it('ignores fractional committed message seqs', () => {
        const tracker = new CommittedUserMessageSeqTracker();

        expect(tracker.record('local-1', 55.9)).toBeNull();
        expect(tracker.get('local-1')).toBeNull();
    });

    it('rejects whitespace-only pending identities while preserving accepted opaque bytes', () => {
        const tracker = new CommittedUserMessageSeqTracker();

        expect(tracker.record('   ', 56)).toBeNull();
        expect(tracker.record(' local-1 ', 57)).toBe(57);
        expect(tracker.get(' local-1 ')).toBe(57);
        expect(tracker.get('local-1')).toBeNull();
    });

    it('notifies first committed sequence once and clears lifecycle subscriptions', () => {
        const tracker = new CommittedUserMessageSeqTracker();
        const listener = vi.fn();
        const unsubscribe = tracker.subscribe(listener);

        expect(tracker.record(' local-recorded ', 58)).toBe(58);
        expect(tracker.record(' local-recorded ', 58)).toBe(58);
        expect(tracker.record(' local-recorded ', 59)).toBe(58);
        expect(listener).toHaveBeenCalledTimes(1);
        expect(listener).toHaveBeenCalledWith({
            localId: ' local-recorded ',
            seq: 58,
        });

        unsubscribe();
        expect(tracker.record('local-after-unsubscribe', 60)).toBe(60);
        expect(listener).toHaveBeenCalledTimes(1);

        tracker.subscribe(listener);
        tracker.clear();
        expect(tracker.record('local-after-clear', 61)).toBe(61);
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('isolates subscribers so one failure cannot corrupt committed settlement', () => {
        const tracker = new CommittedUserMessageSeqTracker();
        const observingListener = vi.fn();
        tracker.subscribe(() => {
            throw new Error('subscriber failed');
        });
        tracker.subscribe(observingListener);

        expect(tracker.record('local-isolated', 62)).toBe(62);
        expect(tracker.get('local-isolated')).toBe(62);
        expect(observingListener).toHaveBeenCalledWith({
            localId: 'local-isolated',
            seq: 62,
        });
    });
});
