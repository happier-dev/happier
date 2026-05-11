import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { StoryDeckCard, StoryDeckImageCard } from '@/changelog/releaseNotes/types';

const shared = vi.hoisted(() => ({
    reducedMotion: false,
    windowWidth: 360,
    scrollTo: vi.fn(),
}));

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => shared.reducedMotion,
}));

vi.mock('@/components/ui/motion/StepTransitionFrame', () => ({
    StepTransitionFrame: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
        React.createElement('StepTransitionFrame', props, children),
    resolveStepTransitionDirection: () => 'replace',
}));

vi.mock('react-native', async () => {
    const ReactModule = await import('react');
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        PanResponder: {
            create: (config: Record<string, unknown>) => ({
                panHandlers: {
                    onMoveShouldSetResponder: config.onMoveShouldSetPanResponder,
                    onResponderRelease: config.onPanResponderRelease,
                },
            }),
        },
        useWindowDimensions: () => ({ width: shared.windowWidth, height: 640 }),
        ScrollView: ReactModule.forwardRef((
            props: Record<string, unknown>,
            ref: React.ForwardedRef<{ scrollTo: typeof shared.scrollTo }>,
        ) => {
            ReactModule.useImperativeHandle(ref, () => ({ scrollTo: shared.scrollTo }));
            const { children, ...rest } = props as React.PropsWithChildren<Record<string, unknown>>;
            return ReactModule.createElement('ScrollView', rest, children);
        }),
    });
});

vi.mock('expo-image', () => ({
    Image: Object.assign(
        (props: Record<string, unknown>) => React.createElement('Image', props, null),
        { prefetch: vi.fn(async () => true) },
    ),
}));

vi.mock('expo-video', () => ({
    useVideoPlayer: () => ({
        play: vi.fn(),
        pause: vi.fn(),
        addListener: vi.fn(() => ({ remove: vi.fn() })),
    }),
    VideoView: (props: Record<string, unknown>) => React.createElement('VideoView', props, null),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props, null),
}));

const cards: StoryDeckCard[] = [
    {
        kind: 'list',
        titleKey: 'releaseNotes.test.one',
        rows: [{ iconId: 'sparkles', titleKey: 'releaseNotes.test.row', bodyKey: 'releaseNotes.test.body' }],
    },
    {
        kind: 'list',
        titleKey: 'releaseNotes.test.two',
        rows: [{ iconId: 'rocket', titleKey: 'releaseNotes.test.row', bodyKey: 'releaseNotes.test.body' }],
    },
];

type FutureImageMedia = StoryDeckImageCard['media'] & Readonly<{
    primaryUrl: string;
}>;

function createImageCard(key: string): StoryDeckImageCard {
    return {
        kind: 'image',
        titleKey: `releaseNotes.test.${key}.title`,
        bodyKey: `releaseNotes.test.${key}.body`,
        media: {
            key,
            altKey: `releaseNotes.test.${key}.alt`,
            primaryUrl: `https://cdn.example.com/${key}.png`,
        } satisfies FutureImageMedia,
    };
}

describe('StoryDeckSurface', () => {
    it('lets the horizontal pager own slide motion and avoids wrapping it in StepTransitionFrame', async () => {
        shared.reducedMotion = false;
        shared.windowWidth = 360;
        shared.scrollTo.mockClear();

        const { StoryDeckSurface } = await import('./StoryDeckSurface');
        const screen = await renderScreen(<StoryDeckSurface cards={cards} onComplete={() => {}} testID="story" />);

        expect(screen.findAllByType('StepTransitionFrame')).toHaveLength(0);
        await screen.pressByTestIdAsync('story-footer-primary');

        expect(shared.scrollTo).toHaveBeenCalledWith({ x: 360, animated: true });
    });

    it('disables programmatic pager animation when reduced motion is enabled', async () => {
        shared.reducedMotion = true;
        shared.windowWidth = 360;
        shared.scrollTo.mockClear();

        const { StoryDeckSurface } = await import('./StoryDeckSurface');
        const screen = await renderScreen(<StoryDeckSurface cards={cards} onComplete={() => {}} testID="story" />);

        await screen.pressByTestIdAsync('story-footer-primary');

        expect(shared.scrollTo).toHaveBeenCalledWith({ x: 360, animated: false });
    });

    it('uses the measured deck width for page sizing inside constrained desktop modals', async () => {
        shared.reducedMotion = false;
        shared.windowWidth = 1200;
        shared.scrollTo.mockClear();

        const { StoryDeckSurface } = await import('./StoryDeckSurface');
        const screen = await renderScreen(<StoryDeckSurface cards={cards} onComplete={() => {}} testID="story" />);
        const onLayout = screen.findByTestId('story')?.props.onLayout;

        if (typeof onLayout === 'function') {
            act(() => {
                onLayout({ nativeEvent: { layout: { width: 480 } } });
            });
        }

        await screen.pressByTestIdAsync('story-footer-primary');

        expect(shared.scrollTo).toHaveBeenCalledWith({ x: 480, animated: true });
        expect(screen.findByTestId('story-page-0')?.props.style).toContainEqual({ width: 480 });
    });

    it('uses the bounded wide modal width before the first layout measurement', async () => {
        shared.reducedMotion = false;
        shared.windowWidth = 1200;
        shared.scrollTo.mockClear();

        const { StoryDeckSurface } = await import('./StoryDeckSurface');
        const screen = await renderScreen(<StoryDeckSurface cards={cards} onComplete={() => {}} testID="story" />);

        expect(screen.findByTestId('story-page-0')?.props.style).toContainEqual({ width: 860 });
        await screen.pressByTestIdAsync('story-footer-primary');

        expect(shared.scrollTo).toHaveBeenCalledWith({ x: 860, animated: true });
    });

    it('keeps wide media cards in a stable media-left layout by default', async () => {
        shared.reducedMotion = false;
        shared.windowWidth = 1200;

        const { StoryDeckSurface } = await import('./StoryDeckSurface');
        const screen = await renderScreen(
            <StoryDeckSurface
                cards={[createImageCard('one'), createImageCard('two')]}
                onComplete={() => {}}
                testID="story"
            />,
        );

        expect(screen.findByTestId('story-card-0')?.props.style).not.toContainEqual({ flexDirection: 'row-reverse' });
        expect(screen.findByTestId('story-card-1')?.props.style).not.toContainEqual({ flexDirection: 'row-reverse' });
    });

    it('can use the soft blur transition without driving the horizontal pager', async () => {
        shared.reducedMotion = false;
        shared.windowWidth = 1200;
        shared.scrollTo.mockClear();

        const { StoryDeckSurface } = await import('./StoryDeckSurface');
        const screen = await renderScreen(
            <StoryDeckSurface
                cards={cards}
                onComplete={() => {}}
                slideAnimation="softBlur"
                testID="story"
            />,
        );

        expect(screen.findByTestId('story-soft-slide')).not.toBeNull();
        await screen.pressByTestIdAsync('story-footer-primary');

        expect(shared.scrollTo).not.toHaveBeenCalled();
        expect(screen.findByTestId('story-page-1')).not.toBeNull();
    });

    it('keeps the current soft slide layer in normal flow so the card body does not collapse', async () => {
        shared.reducedMotion = false;
        shared.windowWidth = 1200;

        const { StoryDeckSurface } = await import('./StoryDeckSurface');
        const screen = await renderScreen(
            <StoryDeckSurface
                cards={cards}
                onComplete={() => {}}
                slideAnimation="softBlur"
                testID="story"
            />,
        );

        const currentLayer = screen.findByTestId('story-soft-slide-current-layer');
        expect(currentLayer?.props.style).not.toContainEqual(expect.objectContaining({ position: 'absolute' }));
    });

    it('supports horizontal drag gestures for soft slide navigation', async () => {
        shared.reducedMotion = false;
        shared.windowWidth = 1200;

        const { StoryDeckSurface } = await import('./StoryDeckSurface');
        const screen = await renderScreen(
            <StoryDeckSurface
                cards={cards}
                onComplete={() => {}}
                slideAnimation="softBlur"
                testID="story"
            />,
        );

        const gestureSurface = screen.findByTestId('story-soft-slide-gesture-surface');

        expect(gestureSurface?.props.onMoveShouldSetResponder({}, { dx: -90, dy: 5 })).toBe(true);
        act(() => {
            gestureSurface?.props.onResponderRelease({}, { dx: -90, dy: 5 });
        });

        expect(screen.findByTestId('story-page-1')).not.toBeNull();
    });

    it('uses the bounded wide deck width for media before the first card layout measurement', async () => {
        shared.reducedMotion = false;
        shared.windowWidth = 1200;

        const { StoryDeckSurface } = await import('./StoryDeckSurface');
        const screen = await renderScreen(
            <StoryDeckSurface
                cards={[createImageCard('one')]}
                onComplete={() => {}}
                slideAnimation="softBlur"
                testID="story"
            />,
        );

        expect(screen.findByTestId('story-card-0-media-image')?.props.style).toEqual(
            expect.objectContaining({ width: 361, height: 361 }),
        );
    });
});
