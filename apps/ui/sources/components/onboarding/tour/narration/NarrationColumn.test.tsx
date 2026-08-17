import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { SlideTransitionSwitch } from '@/components/ui/motion/SlideTransitionSwitch';

import { journeyBeatById } from '../state/journeyBeats';
import { NarrationBeat } from './NarrationBeat';
import { NarrationColumn } from './NarrationColumn';

afterEach(() => {
    standardCleanup();
});

describe('NarrationColumn', () => {
    it('wraps the current beat in the shared soft blur transition', async () => {
        const beat = journeyBeatById.get('A2');
        expect(beat).toBeDefined();

        const screen = await renderScreen(
            <NarrationColumn
                beat={beat!}
                direction="forward"
                reducedMotion
                testID="journey-narration"
            />,
        );

        expect(screen.findByTestId('journey-narration')).toBeTruthy();

        const transition = screen.findByType(SlideTransitionSwitch);
        expect(transition.props).toMatchObject({
            contentKey: 'A2',
            direction: 'forward',
            preset: 'soft',
            blur: true,
            reducedMotion: true,
            testID: 'journey-narration-transition',
        });
        expect(screen.findByType(NarrationBeat).props.reducedMotion).toBe(true);
    });

    it('leaves the reveal timing to the beat instead of holding a JS visibility flag', async () => {
        const beat = journeyBeatById.get('A2');
        const screen = await renderScreen(
            <NarrationColumn beat={beat!} testID="journey-narration" />,
        );

        // The settle hold used to be a `setTimeout`-driven boolean here; while it
        // was closed every headline word sat at opacity 0 with no animation
        // scheduled, so a gate that never opened rendered the headline absent.
        // The column now owns only the pane transition.
        expect(screen.findByType(NarrationBeat).props).not.toHaveProperty('revealGate');
    });
});
