import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { StoryDeckVideoCard as VideoCardData } from '@/changelog/releaseNotes/types';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        useWindowDimensions: () => ({ width: 360, height: 640 }),
    });
});

const shared = vi.hoisted(() => {
    type StatusListener = (payload: { status: string; error?: Error }) => void;
    return {
        reducedMotion: false,
        useVideoPlayer: vi.fn(),
        players: [] as Array<{
            play: ReturnType<typeof vi.fn>;
            pause: ReturnType<typeof vi.fn>;
            addListener: ReturnType<typeof vi.fn>;
            emitStatus: StatusListener;
        }>,
        playersBySource: new Map<string | null, {
            play: ReturnType<typeof vi.fn>;
            pause: ReturnType<typeof vi.fn>;
            addListener: ReturnType<typeof vi.fn>;
            emitStatus: StatusListener;
        }>(),
    };
});

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => shared.reducedMotion,
}));

vi.mock('expo-image', () => ({
    Image: (props: Record<string, unknown>) => React.createElement('Image', props, null),
}));

vi.mock('expo-video', () => ({
    useVideoPlayer: (source: string | null, setup?: (player: unknown) => void) => {
        const existing = shared.playersBySource.get(source);
        if (existing) return existing;

        const listeners: Array<(payload: { status: string; error?: Error }) => void> = [];
        const player = {
            play: vi.fn(),
            pause: vi.fn(),
            addListener: vi.fn((_event: string, listener: (payload: { status: string; error?: Error }) => void) => {
                listeners.push(listener);
                return { remove: vi.fn() };
            }),
            emitStatus: (payload: { status: string; error?: Error }) => {
                for (const listener of listeners) listener(payload);
            },
        };
        shared.useVideoPlayer(source);
        setup?.(player);
        shared.players.push(player);
        shared.playersBySource.set(source, player);
        return player;
    },
    VideoView: (props: Record<string, unknown>) => React.createElement('VideoView', props, null),
}));

type FutureVideoMedia = VideoCardData['media'] & Readonly<{
    primaryUrl: string;
    fallbackUrl: string;
    posterUrl: string;
    posterFallbackUrl?: string;
}>;

const media = {
    key: 'video-key',
    posterKey: 'poster-key',
    accessibilityLabelKey: 'releaseNotes.test.video',
    primaryUrl: 'http://localhost:4150/video.mp4',
    fallbackUrl: 'https://cdn.example.com/video.mp4',
    posterUrl: 'http://localhost:4150/poster.png',
    posterFallbackUrl: 'https://cdn.example.com/poster.png',
} satisfies FutureVideoMedia;

const card = {
    kind: 'video',
    titleKey: 'releaseNotes.test.title',
    bodyKey: 'releaseNotes.test.body',
    media,
} satisfies VideoCardData;

describe('StoryDeckVideoCard', () => {
    it('keeps the ready player playing when ready state rerenders the card', async () => {
        shared.reducedMotion = false;
        shared.useVideoPlayer.mockClear();
        shared.players = [];
        shared.playersBySource.clear();

        const { StoryDeckVideoCard } = await import('./StoryDeckVideoCard');
        await renderScreen(<StoryDeckVideoCard card={card} isCurrent testID="story-video" />);

        act(() => {
            shared.players[0]?.emitStatus({ status: 'readyToPlay' });
        });

        expect(shared.players[0]?.pause).not.toHaveBeenCalled();
    });

    it('renders poster-only media and does not create a video player when reduced motion is enabled', async () => {
        shared.reducedMotion = true;
        shared.useVideoPlayer.mockClear();
        shared.players = [];
        shared.playersBySource.clear();

        const { StoryDeckVideoCard } = await import('./StoryDeckVideoCard');
        const screen = await renderScreen(<StoryDeckVideoCard card={card} isCurrent testID="story-video" />);

        expect(shared.useVideoPlayer).not.toHaveBeenCalled();
        expect(screen.findByTestId('story-video-media-poster')).toBeTruthy();
        expect(screen.findAllByType('VideoView')).toHaveLength(0);
        expect(screen.findAllByType('ActivityIndicator')).toHaveLength(0);
    });

    it('falls back to poster without console warnings or infinite spinner when video loading fails', async () => {
        shared.reducedMotion = false;
        shared.useVideoPlayer.mockClear();
        shared.players = [];
        shared.playersBySource.clear();
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        try {
            const { StoryDeckVideoCard } = await import('./StoryDeckVideoCard');
            const screen = await renderScreen(<StoryDeckVideoCard card={card} isCurrent testID="story-video" />);

            act(() => {
                shared.players[0]?.emitStatus({ status: 'error', error: new Error('primary failed') });
            });
            act(() => {
                shared.players[1]?.emitStatus({ status: 'error', error: new Error('fallback failed') });
            });

            expect(warnSpy).not.toHaveBeenCalled();
            expect(screen.findByTestId('story-video-media-poster')).toBeTruthy();
            expect(screen.findAllByType('ActivityIndicator')).toHaveLength(0);
        } finally {
            warnSpy.mockRestore();
        }
    });

    it('falls back to poster when video loading stalls past the media timeout', async () => {
        vi.useFakeTimers();
        shared.reducedMotion = false;
        shared.useVideoPlayer.mockClear();
        shared.players = [];
        shared.playersBySource.clear();

        try {
            const { StoryDeckVideoCard } = await import('./StoryDeckVideoCard');
            const screen = await renderScreen(
                <StoryDeckVideoCard card={card} isCurrent testID="story-video" loadTimeoutMs={100} />,
            );

            expect(screen.findByTestId('story-video-media-loading')).toBeTruthy();

            act(() => {
                vi.advanceTimersByTime(100);
            });
            act(() => {
                vi.advanceTimersByTime(100);
            });

            expect(screen.findByTestId('story-video-media-poster')).toBeTruthy();
            expect(screen.findAllByType('ActivityIndicator')).toHaveLength(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it('switches to the poster fallback source when the primary poster fails', async () => {
        shared.reducedMotion = true;
        shared.useVideoPlayer.mockClear();
        shared.players = [];
        shared.playersBySource.clear();

        const { invokeTestInstanceHandler } = await import('@/dev/testkit');
        const { StoryDeckVideoCard } = await import('./StoryDeckVideoCard');
        const screen = await renderScreen(<StoryDeckVideoCard card={card} isCurrent testID="story-video" />);

        expect(screen.findByTestId('story-video-media-poster')?.props.source).toEqual({
            uri: 'http://localhost:4150/poster.png',
        });

        act(() => {
            invokeTestInstanceHandler(
                screen.findByTestId('story-video-media-poster'),
                'onError',
                undefined,
                'story-video-media-poster',
            );
        });

        expect(screen.findByTestId('story-video-media-poster')?.props.source).toEqual({
            uri: 'https://cdn.example.com/poster.png',
        });
    });
});
