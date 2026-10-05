import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { ListPresentationProvider, useListPresentation } from '@/components/ui/lists/listPresentation';

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

vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    const boundary = createReanimatedModuleMock();
    const AnimatedView = (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('AnimatedView', props, props.children);
    const AnimatedScrollView = (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('AnimatedScrollView', props, props.children);
    return {
        ...boundary,
        default: {
            ...boundary.default,
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
// I1: a menu or picker opened from a configuration page keeps its grouped look. The overlay is the
// one owner of that reset, on both the plain and the arrowed frame.
function PresentationProbe() {
    return React.createElement('Probe', { presentation: useListPresentation() });
}

async function renderOverlayUnderPage(props: Record<string, unknown>) {
    const { FloatingOverlay } = await import('./FloatingOverlay');
    return renderScreen(
        React.createElement(
            ListPresentationProvider,
            {
                value: 'page',
                children: null,
            },
            React.createElement(PresentationProbe),
            React.createElement(FloatingOverlay, {
                ...props,
                children: React.createElement(PresentationProbe),
            } as React.ComponentProps<typeof FloatingOverlay>),
        ),
    );
}

describe('FloatingOverlay list presentation (I1)', () => {
    it.each([
        ['without an arrow', {}],
        ['with an arrow', { arrow: { placement: 'bottom' } }],
    ])('resets page presentation to grouped for its content %s', async (_label, props) => {
        const screen = await renderOverlayUnderPage({ maxHeight: 200, ...props });
        const probes = screen.findAllByType('Probe' as never).map((node) => node.props.presentation);
        // The page content outside the overlay stays page; the overlay content is grouped.
        expect(probes).toEqual(['page', 'grouped']);
    });
});
