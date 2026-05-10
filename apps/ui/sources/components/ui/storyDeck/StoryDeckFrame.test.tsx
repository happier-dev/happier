import React from 'react';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { StoryDeckFrame } from './StoryDeckFrame';

describe('StoryDeckFrame', () => {
    it('keeps dot indicators by default for long story decks', async () => {
        const screen = await renderScreen(
            <StoryDeckFrame currentIndex={0} totalCount={8} footer={<></>}>
                <></>
            </StoryDeckFrame>,
        );

        expect(screen.getTextContent()).not.toContain('1 / 8');
    });

    it('ignores compact dot requests and keeps dot indicators', async () => {
        const screen = await renderScreen(
            <StoryDeckFrame currentIndex={0} totalCount={8} footer={<></>}>
                <></>
            </StoryDeckFrame>,
        );

        expect(screen.getTextContent()).not.toContain('1 / 8');
    });
});
