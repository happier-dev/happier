import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { StoryDeckFooterActions } from './StoryDeckFooterActions';

describe('StoryDeckFooterActions', () => {
    it('keeps the optional skip action available before the final slide', async () => {
        const onSkip = vi.fn();
        const screen = await renderScreen(
            <StoryDeckFooterActions
                isLastSlide={false}
                onPrimary={vi.fn()}
                onSkip={onSkip}
                skipLabel="Skip tour"
                testID="story-footer"
            />,
        );

        expect(screen.getTextContent()).toContain('Skip tour');
        await screen.pressByTestIdAsync('story-footer-skip');
        expect(onSkip).toHaveBeenCalledTimes(1);
    });

    it('uses the story-deck completion label on the final slide', async () => {
        const screen = await renderScreen(
            <StoryDeckFooterActions isLastSlide onPrimary={vi.fn()} testID="story-footer" />,
        );

        expect(screen.getTextContent()).toContain("Let's go!");
        expect(screen.getTextContent()).not.toContain('Done');
    });
});
