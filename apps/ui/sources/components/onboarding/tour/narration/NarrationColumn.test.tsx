import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { SlideTransitionSwitch } from '@/components/ui/motion/SlideTransitionSwitch';

import { journeyBeatById } from '../state/journeyBeats';
import { NarrationBeat } from './NarrationBeat';
import { NarrationColumn, NARRATION_REVEAL_SETTLE_MS } from './NarrationColumn';

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

    it('opens the reveal gate immediately when reduced motion is enabled', async () => {
        const beat = journeyBeatById.get('A2');
        const screen = await renderScreen(
            <NarrationColumn beat={beat!} reducedMotion testID="journey-narration" />,
        );

        expect(screen.findByType(NarrationBeat).props.revealGate).toBe(true);
    });

    it('holds the reveal gate closed until the beat pane transition settles', async () => {
        vi.useFakeTimers();
        try {
            const beat = journeyBeatById.get('A2');
            const screen = await renderScreen(
                <NarrationColumn beat={beat!} testID="journey-narration" />,
            );

            expect(screen.findByType(NarrationBeat).props.revealGate).toBe(false);

            await act(async () => {
                vi.advanceTimersByTime(NARRATION_REVEAL_SETTLE_MS);
            });

            expect(screen.findByType(NarrationBeat).props.revealGate).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });
});
