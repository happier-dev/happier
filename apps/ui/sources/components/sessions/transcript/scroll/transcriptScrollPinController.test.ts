import { describe, expect, it } from 'vitest';

import { reduceTranscriptScrollPinState, type TranscriptScrollPinState } from './transcriptScrollPinController';

describe('reduceTranscriptScrollPinState', () => {
    it('tracks pinned/unpinned based on offset threshold', () => {
        const initial: TranscriptScrollPinState = {
            isPinned: true,
            newActivityCount: 0,
            lastActivityKey: null,
        };

        const s1 = reduceTranscriptScrollPinState(initial, {
            type: 'scroll',
            offsetY: 80,
            pinnedOffsetThresholdPx: 72,
            enabled: true,
        });
        expect(s1.isPinned).toBe(false);

        const s2 = reduceTranscriptScrollPinState(s1, {
            type: 'scroll',
            offsetY: 10,
            pinnedOffsetThresholdPx: 72,
            enabled: true,
        });
        expect(s2.isPinned).toBe(true);
    });

    it('increments newActivityCount when unpinned and new activity arrives', () => {
        const initial: TranscriptScrollPinState = {
            isPinned: false,
            newActivityCount: 0,
            lastActivityKey: null,
        };

        const s1 = reduceTranscriptScrollPinState(initial, {
            type: 'newActivity',
            activityKey: 'm1',
            enabled: true,
        });
        expect(s1.newActivityCount).toBe(1);

        const s2 = reduceTranscriptScrollPinState(s1, {
            type: 'newActivity',
            activityKey: 'm2',
            enabled: true,
        });
        expect(s2.newActivityCount).toBe(2);
    });

    it('does not increment when activity key is unchanged', () => {
        const initial: TranscriptScrollPinState = {
            isPinned: false,
            newActivityCount: 1,
            lastActivityKey: 'm1',
        };

        const s1 = reduceTranscriptScrollPinState(initial, {
            type: 'newActivity',
            activityKey: 'm1',
            enabled: true,
        });
        expect(s1.newActivityCount).toBe(1);
    });

    it('resets newActivityCount when pinned again', () => {
        const initial: TranscriptScrollPinState = {
            isPinned: false,
            newActivityCount: 3,
            lastActivityKey: 'm3',
        };

        const pinned = reduceTranscriptScrollPinState(initial, {
            type: 'scroll',
            offsetY: 0,
            pinnedOffsetThresholdPx: 72,
            enabled: true,
        });
        expect(pinned.isPinned).toBe(true);
        expect(pinned.newActivityCount).toBe(0);
    });
});
