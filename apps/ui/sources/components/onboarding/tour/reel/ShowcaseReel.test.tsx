import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SlideTransitionSwitch } from '@/components/ui/motion/SlideTransitionSwitch';
import {
    collectUnexpectedRawTextNodes,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';

import { ShowcaseReel } from './ShowcaseReel';
import { journeyReelItems } from './reelItems';

afterEach(() => {
    standardCleanup();
});

describe('ShowcaseReel', () => {
    it('renders the reel feature set and crossfades the selected active card', async () => {
        const screen = await renderScreen(
            <ShowcaseReel
                activeIndex={1}
                onSetUpHappier={() => {}}
                testID="journey-reel"
            />,
        );

        expect(screen.findAllByTestId('journey-reel-feature-card')).toHaveLength(journeyReelItems.length);
        expect(screen.getTextContent()).toContain('Search everything.');
        expect(screen.getTextContent()).toContain('Semantic memory search across your sessions');
        expect(screen.findByType(SlideTransitionSwitch).props).toMatchObject({
            contentKey: 'memorySearch',
            preset: 'soft',
            blur: true,
            direction: 'replace',
        });
        expect(collectUnexpectedRawTextNodes(screen.tree.toJSON())).toEqual([]);
    });

    it('keeps the setup CTA available so the montage never blocks setup', async () => {
        const onSetUpHappier = vi.fn();
        const screen = await renderScreen(
            <ShowcaseReel
                activeIndex={journeyReelItems.length - 1}
                onSetUpHappier={onSetUpHappier}
                testID="journey-reel"
            />,
        );

        expect(screen.findByTestId('journey-reel-setup')).not.toBeNull();

        screen.pressByTestId('journey-reel-setup');

        expect(onSetUpHappier).toHaveBeenCalledTimes(1);
    });
});
