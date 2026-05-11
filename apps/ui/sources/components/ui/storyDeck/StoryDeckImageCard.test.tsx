import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { invokeTestInstanceHandler, renderScreen } from '@/dev/testkit';
import type { StoryDeckImageCard as ImageCardData } from '@/changelog/releaseNotes/types';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        useWindowDimensions: () => ({ width: 360, height: 640 }),
    });
});

vi.mock('expo-image', () => ({
    Image: (props: Record<string, unknown>) => React.createElement('Image', props, null),
}));

vi.mock('expo-video', () => ({
    useVideoPlayer: () => ({
        play: vi.fn(),
        pause: vi.fn(),
        addListener: vi.fn(() => ({ remove: vi.fn() })),
    }),
    VideoView: (props: Record<string, unknown>) => React.createElement('VideoView', props, null),
}));

type FutureImageMedia = ImageCardData['media'] & Readonly<{
    primaryUrl: string;
    fallbackUrl: string;
}>;

const media = {
    key: 'image-key',
    altKey: 'releaseNotes.test.alt',
    primaryUrl: 'http://localhost:4150/image.png',
    fallbackUrl: 'https://cdn.example.com/image.png',
} satisfies FutureImageMedia;

const card = {
    kind: 'image',
    titleKey: 'releaseNotes.test.title',
    bodyKey: 'releaseNotes.test.body',
    media,
} satisfies ImageCardData;

describe('StoryDeckImageCard', () => {
    it('uses the wide title key only in wide layout', async () => {
        const { StoryDeckImageCard } = await import('./StoryDeckImageCard');
        const cardWithWideTitle = {
            ...card,
            wideTitleKey: 'releaseNotes.test.wideTitle',
        } satisfies ImageCardData;

        const stacked = await renderScreen(<StoryDeckImageCard card={cardWithWideTitle} isCurrent testID="story-image" />);
        expect(stacked.getTextContent()).toContain('releaseNotes.test.title');
        expect(stacked.getTextContent()).not.toContain('releaseNotes.test.wideTitle');

        const wide = await renderScreen(<StoryDeckImageCard card={cardWithWideTitle} isCurrent layout="wide" testID="story-image-wide" />);
        expect(wide.getTextContent()).toContain('releaseNotes.test.wideTitle');
    });

    it('switches to fallbackUrl after the primary image fails', async () => {
        const { StoryDeckImageCard } = await import('./StoryDeckImageCard');
        const screen = await renderScreen(<StoryDeckImageCard card={card} isCurrent testID="story-image" />);

        expect(screen.findByTestId('story-image-media-image')?.props.source).toEqual({
            uri: 'http://localhost:4150/image.png',
        });

        act(() => {
            invokeTestInstanceHandler(
                screen.findByTestId('story-image-media-image'),
                'onError',
                undefined,
                'story-image-media-image',
            );
        });

        expect(screen.findByTestId('story-image-media-image')?.props.source).toEqual({
            uri: 'https://cdn.example.com/image.png',
        });
    });

    it('shows a stable failure placeholder instead of a spinner after all image URLs fail', async () => {
        const { StoryDeckImageCard } = await import('./StoryDeckImageCard');
        const screen = await renderScreen(<StoryDeckImageCard card={card} isCurrent testID="story-image" />);

        act(() => {
            invokeTestInstanceHandler(screen.findByTestId('story-image-media-image'), 'onError', undefined, 'story-image-media-image');
        });
        act(() => {
            invokeTestInstanceHandler(screen.findByTestId('story-image-media-image'), 'onError', undefined, 'story-image-media-image');
        });

        expect(screen.findByTestId('story-image-media-failed')).toBeTruthy();
        expect(screen.findAllByType('ActivityIndicator')).toHaveLength(0);
    });

    it('shows a stable failure placeholder when image loading stalls past the media timeout', async () => {
        vi.useFakeTimers();

        try {
            const { StoryDeckImageCard } = await import('./StoryDeckImageCard');
            const screen = await renderScreen(
                <StoryDeckImageCard card={card} isCurrent testID="story-image" loadTimeoutMs={100} />,
            );

            expect(screen.findByTestId('story-image-media-loading')).toBeTruthy();

            act(() => {
                vi.advanceTimersByTime(100);
            });
            act(() => {
                vi.advanceTimersByTime(100);
            });

            expect(screen.findByTestId('story-image-media-failed')).toBeTruthy();
            expect(screen.findAllByType('ActivityIndicator')).toHaveLength(0);
        } finally {
            vi.useRealTimers();
        }
    });
});
