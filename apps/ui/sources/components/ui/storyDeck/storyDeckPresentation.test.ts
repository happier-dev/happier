import { describe, expect, it } from 'vitest';

import { resolveStoryDeckPresentation } from './storyDeckPresentation';

describe('resolveStoryDeckPresentation', () => {
    it('keeps phone-width decks stacked and mobile-media based', () => {
        expect(resolveStoryDeckPresentation(390)).toEqual({
            mediaSurface: 'mobile',
            cardLayout: 'stacked',
            frameMaxWidth: 390,
            frameMaxHeight: 390,
        });
    });

    it('uses desktop media and wide cards when tablet or desktop width is available', () => {
        expect(resolveStoryDeckPresentation(900)).toEqual({
            mediaSurface: 'desktop',
            cardLayout: 'wide',
            frameMaxWidth: 860,
            frameMaxHeight: 530,
        });
    });
});
