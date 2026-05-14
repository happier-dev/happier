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
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                    Platform: {
                        OS: 'web',
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

function findOverlayContainerStyle(screen: Awaited<ReturnType<typeof renderOverlay>>): Record<string, unknown> {
    const node = screen.findAllByType('AnimatedView' as never).find((candidate) => {
        const style = flattenStyle(candidate.props.style);
        return style.overflow === 'hidden' && style.borderRadius === 12;
    });
    if (!node) throw new Error('expected floating overlay container to exist');
    return flattenStyle(node.props.style);
}

function findOverlayContainerRawStyle(screen: Awaited<ReturnType<typeof renderOverlay>>): unknown {
    const node = screen.findAllByType('AnimatedView' as never).find((candidate) => {
        const style = flattenStyle(candidate.props.style);
        return style.overflow === 'hidden' && style.borderRadius === 12;
    });
    if (!node) throw new Error('expected floating overlay container to exist');
    return node.props.style;
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

    it('does not add themed surface border or shadow when surface chrome colors are transparent', async () => {
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

        const style = findOverlayContainerStyle(screen);
        expect(style.borderWidth).toBe(0);
        expect(style.borderTopWidth).toBe(0);
        expect(hasShadow(style)).toBe(false);
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

        const style = findOverlayContainerStyle(screen);
        expect(style.borderColor).toBe('rgba(0,0,0,0.08)');
        expect(style.borderWidth).toBeGreaterThan(0);
        expect(style.borderTopColor).toBe('rgba(0,0,0,0.08)');
        expect(style.borderTopWidth).toBeGreaterThan(0);
        expect(hasShadow(style)).toBe(true);
    });

    it('keeps themed surface chrome in one static style entry before dynamic overrides', async () => {
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

        const rawStyle = findOverlayContainerRawStyle(screen);
        expect(Array.isArray(rawStyle)).toBe(true);
        const styleEntries = rawStyle as readonly unknown[];
        expect(styleEntries[0]).toMatchObject({
            borderRadius: 12,
            overflow: 'hidden',
            borderColor: 'rgba(0,0,0,0.08)',
            borderTopColor: 'rgba(0,0,0,0.08)',
        });
        expect(styleEntries[1]).toEqual({ maxHeight: 200 });
    });
});
