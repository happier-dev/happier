import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

const runtime = vi.hoisted(() => ({
    height: 740,
    platform: 'web' as 'web' | 'ios',
    width: 390,
}));

const gestureState = vi.hoisted(() => ({
    enabledCalls: [] as boolean[],
}));

vi.mock('react-native', async () => {
    const actual = await vi.importActual<typeof import('react-native')>('react-native');

    return {
        ...actual,
        Platform: {
            ...actual.Platform,
            get OS() {
                return runtime.platform;
            },
            select: <T,>(options: Partial<Record<'web' | 'ios' | 'android' | 'native' | 'default', T>>) => {
                return options[runtime.platform] ?? options.default;
            },
        },
        useWindowDimensions: () => ({
            fontScale: 1,
            height: runtime.height,
            scale: 1,
            width: runtime.width,
        }),
    };
});

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
}));

vi.mock('expo-blur', () => ({
    BlurView: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
        React.createElement('BlurView', props, children),
}));

const createPanGesture = () => {
    const chain = {
        activeOffsetY: () => chain,
        enabled: (value: boolean) => {
            gestureState.enabledCalls.push(value);
            return chain;
        },
        failOffsetX: () => chain,
        onEnd: () => chain,
        onUpdate: () => chain,
    };
    return chain;
};

vi.mock('react-native-gesture-handler', () => ({
    Gesture: {
        Pan: createPanGesture,
    },
    GestureDetector: ({ children }: React.PropsWithChildren) => React.createElement(React.Fragment, null, children),
}));

vi.mock('react-native-reanimated', () => ({
    default: {
        View: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
            React.createElement('AnimatedView', props, children),
    },
    Easing: {
        bezier: () => 'bezier',
        out: () => 'out',
    },
    runOnJS: <T extends (...args: never[]) => unknown>(callback: T) => callback,
    useAnimatedStyle: (callback: () => Record<string, unknown>) => callback(),
    useSharedValue: <T,>(value: T) => ({ value }),
    withSpring: <T,>(value: T) => value,
    withTiming: <T,>(value: T, _config?: unknown, callback?: (finished?: boolean) => void) => {
        callback?.(true);
        return value;
    },
}));

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map(flattenStyle));
    }
    if (style && typeof style === 'object') {
        return style as Record<string, unknown>;
    }
    return {};
}

describe('StorySheetFrame', () => {
    beforeEach(() => {
        gestureState.enabledCalls = [];
    });

    it('uses drawer chrome on phone-width web screens', async () => {
        runtime.platform = 'web';
        runtime.width = 390;
        runtime.height = 740;
        const { StorySheetFrame } = await import('./StorySheetFrame');

        const screen = await renderScreen(
            <StorySheetFrame testID="story-sheet" onDismiss={() => {}}>
                <></>
            </StorySheetFrame>
        );

        expect(screen.findByTestId('story-sheet-handle')).toBeNull();
        expect(screen.findByTestId('story-sheet')?.props.style).toEqual(
            expect.arrayContaining([expect.objectContaining({ height: 740, width: 390 })]),
        );
        expect(gestureState.enabledCalls).toContain(true);
    });

    it('keeps centered chrome on wide web screens', async () => {
        runtime.platform = 'web';
        runtime.width = 900;
        runtime.height = 740;
        const { StorySheetFrame } = await import('./StorySheetFrame');

        const screen = await renderScreen(
            <StorySheetFrame testID="story-sheet" onDismiss={() => {}}>
                <></>
            </StorySheetFrame>
        );

        expect(screen.findByTestId('story-sheet-handle')).toBeNull();
        expect(gestureState.enabledCalls).toContain(false);
    });

    it('does not duplicate centered modal motion owned by BaseModal', async () => {
        runtime.platform = 'web';
        runtime.width = 900;
        runtime.height = 740;
        const { StorySheetFrame } = await import('./StorySheetFrame');

        const screen = await renderScreen(
            <StorySheetFrame testID="story-sheet" onDismiss={() => {}}>
                <></>
            </StorySheetFrame>
        );

        const sheet = screen.findByType('AnimatedView' as never);
        const style = flattenStyle(sheet.props.style);
        expect(style.opacity).toBeUndefined();
        expect(style.transform).toBeUndefined();
    });

    it('uses a standard opaque surface without an inner blur layer', async () => {
        runtime.platform = 'ios';
        runtime.width = 390;
        runtime.height = 740;
        const { StorySheetFrame } = await import('./StorySheetFrame');

        const screen = await renderScreen(
            <StorySheetFrame testID="story-sheet" onDismiss={() => {}}>
                <></>
            </StorySheetFrame>
        );

        const sheet = screen.findByType('AnimatedView' as never);
        expect(flattenStyle(sheet.props.style).backgroundColor).not.toBe('transparent');
        expect(screen.tree.root.findAllByType('BlurView' as never)).toHaveLength(0);
    });
});
