import type { StoryDeckMediaSurface } from '@/changelog/releaseNotes/types';

export type StoryDeckCardLayout = 'stacked' | 'wide';

export type StoryDeckPresentation = Readonly<{
    mediaSurface: StoryDeckMediaSurface;
    cardLayout: StoryDeckCardLayout;
    frameMaxWidth: number;
    frameMaxHeight: number;
}>;

const WIDE_LAYOUT_MIN_WIDTH = 720;
const WIDE_FRAME_MAX_WIDTH = 860;
const WIDE_FRAME_MAX_HEIGHT = 530;

export function resolveStoryDeckPresentation(viewportWidth: number): StoryDeckPresentation {
    if (viewportWidth >= WIDE_LAYOUT_MIN_WIDTH) {
        return {
            mediaSurface: 'desktop',
            cardLayout: 'wide',
            frameMaxWidth: WIDE_FRAME_MAX_WIDTH,
            frameMaxHeight: WIDE_FRAME_MAX_HEIGHT,
        };
    }

    return {
        mediaSurface: 'mobile',
        cardLayout: 'stacked',
        frameMaxWidth: viewportWidth,
        frameMaxHeight: viewportWidth,
    };
}
