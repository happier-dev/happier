import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { StoryDeckFooterActions } from './StoryDeckFooterActions';

describe('StoryDeckFooterActions', () => {
    it('uses the story-deck completion label on the final slide', async () => {
        const screen = await renderScreen(
            <StoryDeckFooterActions isLastSlide onPrimary={vi.fn()} testID="story-footer" />,
        );

        expect(screen.getTextContent()).toContain("Let's go!");
        expect(screen.getTextContent()).not.toContain('Done');
    });
});
