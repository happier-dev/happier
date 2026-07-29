import { describe, expect, it } from 'vitest';

import {
    buildJourneyPresentationModel,
    resolveJourneyProgressTransition,
} from './journeyPresentationModel';

describe('journeyPresentationModel', () => {
    it('builds per-surface beat sequences with act boundaries', () => {
        const desktop = buildJourneyPresentationModel({ surface: 'desktop', currentBeatId: 'A1' });
        expect(desktop.visibleBeats.map((beat) => beat.id)).toEqual([
            'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'A10',
            'A11', 'A12', 'A13', 'A14', 'S1', 'S2', 'S3', 'S4', 'S5',
        ]);
        expect(desktop.actBoundaries).toEqual({
            dream: { startIndex: 0, endIndex: 13 },
            setup: { startIndex: 14, endIndex: 18 },
        });

        const native = buildJourneyPresentationModel({ surface: 'native', currentBeatId: 'A1' });
        expect(native.visibleBeats.map((beat) => beat.id)).toEqual([
            'A1', 'A2', 'A4', 'A6', 'A7', 'A12', 'A14', 'S1', 'S2', 'S3', 'S4', 'S5',
        ]);
        expect(native.actBoundaries).toEqual({
            dream: { startIndex: 0, endIndex: 6 },
            setup: { startIndex: 7, endIndex: 11 },
        });
    });

    it('normalizes hidden or missing current beats to the first visible beat', () => {
        // A8 is not on the native surface, so it normalizes to the first visible beat.
        expect(buildJourneyPresentationModel({ surface: 'native', currentBeatId: 'A8' }).currentBeat.id).toBe('A1');
        expect(buildJourneyPresentationModel({ surface: 'web' }).currentBeat.id).toBe('A1');
    });

    it('exposes navigation affordances for the active beat', () => {
        expect(buildJourneyPresentationModel({ surface: 'desktop', currentBeatId: 'A1' })).toMatchObject({
            currentIndex: 0,
            currentNumber: 1,
            totalCount: 19,
            previousBeatId: null,
            nextBeatId: 'A2',
            showSkipToSetup: true,
            skipTargetBeatId: 'S1',
        });

        expect(buildJourneyPresentationModel({ surface: 'desktop', currentBeatId: 'S1' })).toMatchObject({
            currentIndex: 14,
            currentNumber: 15,
            previousBeatId: 'A14',
            nextBeatId: 'S2',
            showSkipToSetup: false,
            skipTargetBeatId: null,
        });
    });

    it('resolves advance, back, skip, and completion transitions', () => {
        expect(resolveJourneyProgressTransition({
            surface: 'desktop',
            currentBeatId: 'A2',
            action: 'advance',
        })).toEqual({ type: 'beat', beatId: 'A3' });

        expect(resolveJourneyProgressTransition({
            surface: 'desktop',
            currentBeatId: 'A13',
            action: 'advance',
        })).toEqual({ type: 'beat', beatId: 'A14' });

        expect(resolveJourneyProgressTransition({
            surface: 'desktop',
            currentBeatId: 'A2',
            action: 'back',
        })).toEqual({ type: 'beat', beatId: 'A1' });

        expect(resolveJourneyProgressTransition({
            surface: 'desktop',
            currentBeatId: 'A7',
            action: 'skipToSetup',
        })).toEqual({ type: 'beat', beatId: 'S1' });

        // The last dream beat (A14) advances into the setup act at S1.
        expect(resolveJourneyProgressTransition({
            surface: 'desktop',
            currentBeatId: 'A14',
            action: 'advance',
        })).toEqual({ type: 'beat', beatId: 'S1' });

        expect(resolveJourneyProgressTransition({
            surface: 'desktop',
            currentBeatId: 'S5',
            action: 'advance',
        })).toEqual({ type: 'complete' });

        expect(resolveJourneyProgressTransition({
            surface: 'desktop',
            currentBeatId: 'S5',
            action: 'skipToSetup',
        })).toEqual({ type: 'none' });
    });
});
