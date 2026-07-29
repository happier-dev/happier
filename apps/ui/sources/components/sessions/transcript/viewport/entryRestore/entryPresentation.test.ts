import { describe, expect, it } from 'vitest';

import {
    createEntryPresentationKey,
    createEntryPresentationState,
    reduceEntryPresentationState,
} from './entryPresentation';

describe('entry presentation join', () => {
    /**
     * P-5 (ported from remote-dev, re-authored for this repo).
     *
     * The join releases on an AFFIRMATIVE landing signal, and `entry-confirmed` is one:
     * the entry restore transaction only closes `confirmed` on an ALIGNED reading of the live
     * viewport against its target (`entryRestoreTransaction.onObservation`) or when there was no
     * target to restore at all. Either way the frame the reader would see is already where they
     * asked for it, so nothing the renderer does afterwards can move it somewhere they did not.
     *
     * Requiring the renderer's finish ON TOP of that made a signal the app had already measured as
     * correct load-bearing on a signal the renderer may never emit. When it does not, the only
     * remaining terminal is the first-paint cover's own deadline, so the transcript is held behind
     * a placeholder over content that is already correctly positioned.
     *
     * `entry-fallback` is NOT interchangeable with it and still waits: it means the owner closed
     * WITHOUT observing alignment (deadline, preemption), so the renderer's finish is the only
     * affirmative landing signal left. That asymmetry is what the next two cases pin.
     */
    it('releases on an affirmative entry confirmation even while renderer placement is unfinished', () => {
        const key = createEntryPresentationKey({
            platform: 'web',
            sessionId: 'session-a',
        });
        const pending = createEntryPresentationState(key);
        const rendererStarted = reduceEntryPresentationState(pending, { type: 'renderer-started' });
        const ownerConfirmed = reduceEntryPresentationState(rendererStarted, { type: 'entry-confirmed' });

        expect(rendererStarted.released).toBe(false);
        // The live web sequence: renderer-started -> entry-confirmed -> the renderer never emits a
        // finish. This must already be the terminal.
        expect(ownerConfirmed.entryPhase).toBe('terminal');
        expect(ownerConfirmed.released).toBe(true);

        // A later renderer finish is a no-op on an already released join.
        expect(reduceEntryPresentationState(ownerConfirmed, { type: 'renderer-settled' })).toBe(ownerConfirmed);

        // Reverse order is unchanged: the renderer finishing first still waits for the owner.
        const rendererSettledFirst = reduceEntryPresentationState(rendererStarted, { type: 'renderer-settled' });
        expect(rendererSettledFirst.released).toBe(false);
        expect(reduceEntryPresentationState(rendererSettledFirst, { type: 'entry-confirmed' }).released).toBe(true);
    });

    it('ignores a stale finish and waits for the app owner after renderer fallback', () => {
        const pending = createEntryPresentationState('web\0session-a');
        expect(reduceEntryPresentationState(pending, { type: 'renderer-settled' })).toEqual(pending);

        const rendererStarted = reduceEntryPresentationState(pending, { type: 'renderer-started' });
        const rendererFallback = reduceEntryPresentationState(rendererStarted, { type: 'renderer-fallback' });

        expect(rendererFallback.released).toBe(false);
        expect(reduceEntryPresentationState(rendererFallback, { type: 'entry-fallback' }).released).toBe(true);
    });

    it('waits for renderer terminal settlement after the app owner falls back from a started placement', () => {
        const pending = createEntryPresentationState('web\0session-a');
        const rendererStarted = reduceEntryPresentationState(pending, { type: 'renderer-started' });
        const ownerFallback = reduceEntryPresentationState(rendererStarted, { type: 'entry-fallback' });

        expect(ownerFallback.released).toBe(false);
        expect(reduceEntryPresentationState(ownerFallback, { type: 'renderer-settled' }).released).toBe(true);
    });

    it('fails open when the terminal entry never needed a renderer placement', () => {
        const pending = createEntryPresentationState('native\0session-a');

        expect(reduceEntryPresentationState(pending, { type: 'entry-confirmed' }).released).toBe(true);
        expect(reduceEntryPresentationState(pending, { type: 'entry-fallback' }).released).toBe(true);
    });
});
