import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

const shared = vi.hoisted(() => ({
    themeOverride: {} as Record<string, unknown>,
    platformOS: 'web' as 'web' | 'ios' | 'android',
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                    Platform: {
                        OS: shared.platformOS,
                    },
                    ScrollView: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                        React.createElement('ScrollView', props, props.children),
                }
    );
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    const { createThemeFixture, createThemeRuntimeFixture } = await import('@/dev/testkit/fixtures/themeFixtures');
    const base = await createUnistylesMock();
    const rt = createThemeRuntimeFixture();
    const resolveTheme = () => createThemeFixture(shared.themeOverride);
    return {
        ...base,
        useUnistyles: () => ({ theme: resolveTheme(), rt }),
        StyleSheet: {
            ...base.StyleSheet,
            create: (input: unknown) =>
                typeof input === 'function'
                    ? (input as (theme: unknown, runtime: unknown) => unknown)(resolveTheme(), rt)
                    : input,
        },
    };
});

vi.mock('react-native-reanimated', () => {
    const AnimatedView = (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('AnimatedView', props, props.children);
    const AnimatedScrollView = (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('AnimatedScrollView', props, props.children);
    return {
        __esModule: true,
        default: {
            View: AnimatedView,
            ScrollView: AnimatedScrollView,
        },
    };
});

vi.mock('@/components/ui/scroll/ScrollEdgeFades', () => ({
    ScrollEdgeFades: () => React.createElement('ScrollEdgeFades'),
}));

vi.mock('@/components/ui/scroll/ScrollEdgeIndicators', () => ({
    ScrollEdgeIndicators: () => React.createElement('ScrollEdgeIndicators'),
}));

vi.mock('@/components/ui/scroll/useScrollEdgeFades', () => ({
    useScrollEdgeFades: () => ({
        canScrollX: false,
        canScrollY: false,
        visibility: { top: false, bottom: false, left: false, right: false },
        onViewportLayout: () => {},
        onContentSizeChange: () => {},
        onScroll: () => {},
        onMomentumScrollEnd: () => {},
    }),
}));

async function renderOverlay(props: Record<string, unknown>) {
    const { FloatingOverlay } = await import('./FloatingOverlay');
    return renderScreen(
        React.createElement(FloatingOverlay, {
            ...props,
            children: React.createElement(Child),
        } as React.ComponentProps<typeof FloatingOverlay>),
    );
}

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map((entry) => flattenStyle(entry)));
    }
    if (style && typeof style === 'object') return style as Record<string, unknown>;
    return {};
}

type RenderedOverlayScreen = Awaited<ReturnType<typeof renderOverlay>>;

function findAnimatedViewStyles(screen: RenderedOverlayScreen): ReadonlyArray<Readonly<{
    rawStyle: unknown;
    style: Record<string, unknown>;
}>> {
    return screen.findAllByType('AnimatedView' as never).map((candidate) => ({
        rawStyle: candidate.props.style,
        style: flattenStyle(candidate.props.style),
    }));
}

function findOverlayFrame(screen: RenderedOverlayScreen): Readonly<{
    rawStyle: unknown;
    style: Record<string, unknown>;
}> {
    const node = findAnimatedViewStyles(screen).find(({ style }) => (
        style.borderRadius === 12
        && style.overflow !== 'hidden'
        && style.maxHeight !== undefined
    ));
    if (!node) throw new Error('expected floating overlay shadow frame to exist');
    return node;
}

function findOverlayFrameStyle(screen: RenderedOverlayScreen): Record<string, unknown> {
    return findOverlayFrame(screen).style;
}

function findOverlayFrameRawStyle(screen: RenderedOverlayScreen): unknown {
    return findOverlayFrame(screen).rawStyle;
}

function findOverlayClipSurface(screen: RenderedOverlayScreen): Readonly<{
    rawStyle: unknown;
    style: Record<string, unknown>;
}> {
    const node = findAnimatedViewStyles(screen).find(({ style }) => (
        style.overflow === 'hidden'
        && style.borderRadius === 12
    ));
    if (!node) throw new Error('expected floating overlay clipped surface to exist');
    return node;
}

function findOverlayClipStyle(screen: RenderedOverlayScreen): Record<string, unknown> {
    return findOverlayClipSurface(screen).style;
}

function findOverlayClipRawStyle(screen: RenderedOverlayScreen): unknown {
    return findOverlayClipSurface(screen).rawStyle;
}

function hasShadow(style: Record<string, unknown>): boolean {
    return style.boxShadow !== undefined || style.shadowOpacity !== undefined || style.elevation !== undefined;
}

function Child() {
    return null;
}

afterEach(() => {
    vi.resetModules();
    shared.themeOverride = {};
    shared.platformOS = 'web';
});

describe('FloatingOverlay', () => {
    it('renders an arrow when configured', async () => {
        const screen = await renderOverlay({
            maxHeight: 200,
            arrow: { placement: 'bottom' },
        });

        expect(screen.findByTestId('floating-overlay-arrow')).toBeTruthy();
    });

    it('renders edge indicators when enabled without edge fades', async () => {
        const screen = await renderOverlay({
            maxHeight: 200,
            edgeIndicators: true,
            edgeFades: false,
        });

        expect(screen.findByType('ScrollEdgeIndicators')).toBeTruthy();
    });

    it('keeps themed overlay shadow even when optional surface border/highlight colors are transparent', async () => {
        shared.themeOverride = {
            colors: {
                border: { surface: 'transparent' },
                effect: { surfaceHighlight: 'transparent' },
            },
        };

        const screen = await renderOverlay({
            maxHeight: 200,
            surfaceChrome: 'theme',
        });

        const frameStyle = findOverlayFrameStyle(screen);
        const clipStyle = findOverlayClipStyle(screen);
        expect(clipStyle.borderWidth).toBe(0);
        expect(clipStyle.borderTopWidth).toBe(0);
        expect(hasShadow(frameStyle)).toBe(true);
        expect(hasShadow(clipStyle)).toBe(false);
    });

    it('adds themed surface border and shadow when surface chrome colors are visible', async () => {
        shared.themeOverride = {
            colors: {
                border: { surface: 'rgba(0,0,0,0.08)' },
                effect: { surfaceHighlight: 'rgba(255,255,255,0.04)' },
            },
        };

        const screen = await renderOverlay({
            maxHeight: 200,
            surfaceChrome: 'theme',
        });

        const frameStyle = findOverlayFrameStyle(screen);
        const clipStyle = findOverlayClipStyle(screen);
        expect(clipStyle.borderColor).toBe('rgba(0,0,0,0.08)');
        expect(clipStyle.borderWidth).toBeGreaterThan(0);
        expect(clipStyle.borderTopColor).toBe('rgba(0,0,0,0.08)');
        expect(clipStyle.borderTopWidth).toBeGreaterThan(0);
        expect(hasShadow(frameStyle)).toBe(true);
        expect(hasShadow(clipStyle)).toBe(false);
    });

    it('keeps native popover shadows outside the clipped rounded surface', async () => {
        shared.platformOS = 'ios';
        shared.themeOverride = {
            colors: {
                border: { surface: 'rgba(0,0,0,0.08)' },
                effect: { surfaceHighlight: 'rgba(255,255,255,0.04)' },
            },
        };

        for (const surfaceChrome of ['modal', 'theme'] as const) {
            vi.resetModules();
            const screen = await renderOverlay({
                maxHeight: 200,
                surfaceChrome,
            });

            const frameStyle = findOverlayFrameStyle(screen);
            const clipStyle = findOverlayClipStyle(screen);
            expect(frameStyle.overflow).not.toBe('hidden');
            expect(hasShadow(frameStyle)).toBe(true);
            expect(clipStyle.overflow).toBe('hidden');
            expect(hasShadow(clipStyle)).toBe(false);
        }
    });

    it('keeps themed surface chrome split between a shadow frame and clipped content surface', async () => {
        shared.themeOverride = {
            colors: {
                border: { surface: 'rgba(0,0,0,0.08)' },
                effect: { surfaceHighlight: 'rgba(255,255,255,0.04)' },
            },
        };

        const screen = await renderOverlay({
            maxHeight: 200,
            surfaceChrome: 'theme',
        });

        const frameRawStyle = findOverlayFrameRawStyle(screen);
        expect(Array.isArray(frameRawStyle)).toBe(true);
        const frameStyleEntries = frameRawStyle as readonly unknown[];
        expect(frameStyleEntries[0]).toMatchObject({
            borderRadius: 12,
        });
        expect(flattenStyle(frameStyleEntries[0]).overflow).toBeUndefined();
        expect(frameStyleEntries[1]).toEqual({ maxHeight: 200 });

        const clipRawStyle = findOverlayClipRawStyle(screen);
        expect(Array.isArray(clipRawStyle)).toBe(true);
        const clipStyleEntries = clipRawStyle as readonly unknown[];
        expect(clipStyleEntries[0]).toMatchObject({
            borderRadius: 12,
            overflow: 'hidden',
            borderColor: 'rgba(0,0,0,0.08)',
            borderTopColor: 'rgba(0,0,0,0.08)',
        });
        expect(clipStyleEntries[1]).toEqual({ maxHeight: 200 });
    });
});
