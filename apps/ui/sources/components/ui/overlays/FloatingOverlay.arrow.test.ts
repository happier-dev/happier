import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';
import { ListPresentationProvider, useListPresentation } from '@/components/ui/lists/listPresentation';
import { usePopoverScrollSourceRef } from '@/components/ui/popover/PopoverScrollSource';
import { FLOATING_OVERLAY_METRICS } from './floatingOverlayMetrics';
import { FloatingOverlay } from './FloatingOverlay';

(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

const shared = vi.hoisted(() => ({
    themeOverride: {} as Record<string, unknown>,
    platformOS: 'web' as 'web' | 'ios' | 'android',
}));

// Platform and theme are read when a test renders, so one module graph serves every scenario.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            get OS() {
                return shared.platformOS;
            },
        },
        ScrollView: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
            React.createElement('ScrollView', props, props.children),
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    const { createThemeFixture, createThemeRuntimeFixture } = await import('@/dev/testkit/fixtures/themeFixtures');
    const base = await createUnistylesMock();
    const rt = createThemeRuntimeFixture();
    const resolveTheme = () => createThemeFixture(shared.themeOverride);
    // A themed stylesheet resolves against the current theme on each read, like the runtime's.
    const themedStyles = (factory: (theme: unknown, runtime: unknown) => unknown) => {
        const read = () => factory(resolveTheme(), rt) as Record<PropertyKey, unknown>;
        return new Proxy({}, {
            get: (_target, key) => read()[key],
            has: (_target, key) => key in read(),
            ownKeys: () => Reflect.ownKeys(read()),
            getOwnPropertyDescriptor: (_target, key) => (key in read()
                ? { value: read()[key], enumerable: true, configurable: true, writable: false }
                : undefined),
        });
    };
    return {
        ...base,
        useUnistyles: () => ({ theme: resolveTheme(), rt }),
        StyleSheet: {
            ...base.StyleSheet,
            create: (input: unknown) =>
                typeof input === 'function'
                    ? themedStyles(input as (theme: unknown, runtime: unknown) => unknown)
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

// The platform gradient is a native renderer boundary; the scroll-edge hook, fades and indicators stay real.
vi.mock('expo-linear-gradient', () => ({
    LinearGradient: (props: Record<string, unknown>) => React.createElement('LinearGradient', props),
}));

function Child() {
    return null;
}

async function renderOverlay(props: Record<string, unknown>) {
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

function findOverlayFrameStyle(screen: RenderedOverlayScreen): Record<string, unknown> {
    const style = screen.findAllByType('AnimatedView' as never)
        .map((candidate) => flattenStyle(candidate.props.style))
        .find((candidate) => (
            candidate.borderRadius === FLOATING_OVERLAY_METRICS.radiusPx
            && candidate.overflow !== 'hidden'
            && candidate.maxHeight !== undefined
        ));
    if (!style) throw new Error('expected floating overlay shadow frame to exist');
    return style;
}

function findOverlayClipStyle(screen: RenderedOverlayScreen): Record<string, unknown> {
    // The clipped material is a platform View/BlurView, while only the shadow
    // frame animates. Inspect its public geometry without fixing the renderer tier.
    const style = screen.tree.root.findAll((node) => typeof node.type === 'string')
        .map((node) => flattenStyle(node.props.style))
        .find((candidate) => (
            // The web clips without a scroll container (`clip`); native clips with `hidden`.
            (candidate.overflow === 'hidden' || candidate.overflow === 'clip')
            && candidate.borderRadius === FLOATING_OVERLAY_METRICS.radiusPx
        ));
    if (!style) throw new Error('expected floating overlay clipped surface to exist');
    return style;
}

function hasShadow(style: Record<string, unknown>): boolean {
    return style.boxShadow !== undefined || style.shadowOpacity !== undefined || style.elevation !== undefined;
}

// The suite setup renders icons as `Icon` hosts.
function countIcons(screen: RenderedOverlayScreen, name: string): number {
    return screen.findAll((node) => String(node.type) === 'Icon' && node.props.name === name).length;
}

afterEach(() => {
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

    it('renders edge indicators for the scrolled-past edges when enabled without edge fades', async () => {
        const screen = await renderOverlay({
            maxHeight: 200,
            edgeIndicators: true,
            edgeFades: false,
        });
        expect(countIcons(screen, 'caret-up') + countIcons(screen, 'caret-down')).toBe(0);

        const scroller = screen.findAllByType('AnimatedScrollView' as never)[0]!;
        await act(async () => {
            scroller.props.onScroll({ nativeEvent: {
                contentOffset: { x: 0, y: 100 },
                layoutMeasurement: { width: 200, height: 100 },
                contentSize: { width: 200, height: 500 },
            } });
        });
        expect(countIcons(screen, 'caret-up')).toBeGreaterThan(0);
        expect(countIcons(screen, 'caret-down')).toBeGreaterThan(0);

        await act(async () => {
            scroller.props.onScroll({ nativeEvent: {
                contentOffset: { x: 0, y: 0 },
                layoutMeasurement: { width: 200, height: 100 },
                contentSize: { width: 200, height: 500 },
            } });
        });
        expect(countIcons(screen, 'caret-up')).toBe(0);
        expect(countIcons(screen, 'caret-down')).toBeGreaterThan(0);
        // Indicators alone: no fade gradient is drawn over the content.
        expect(screen.findAllByType('LinearGradient' as never)).toHaveLength(0);
    });

    it('keeps themed overlay shadow even when the floating border and its edge are transparent', async () => {
        shared.themeOverride = {
            colors: {
                border: { modal: 'transparent' },
                edge: { modal: 'transparent' },
            },
        };

        const screen = await renderOverlay({
            maxHeight: 200,
            surfaceChrome: 'theme',
        });

        const frameStyle = findOverlayFrameStyle(screen);
        const clipStyle = findOverlayClipStyle(screen);
        expect(clipStyle.borderWidth).toBe(0);
        expect(hasShadow(frameStyle)).toBe(true);
        expect(hasShadow(clipStyle)).toBe(false);
    });

    it('hands a themed overlay\'s hairline to its floating rim, under a frame shadow', async () => {
        shared.themeOverride = {
            colors: {
                border: { modal: 'rgba(0,0,0,0.08)' },
                edge: { modal: 'rgba(0,0,0,0.117)' },
            },
        };

        const screen = await renderOverlay({
            maxHeight: 200,
            surfaceChrome: 'theme',
        });

        const frameStyle = findOverlayFrameStyle(screen);
        const clipStyle = findOverlayClipStyle(screen);
        // Floating surfaces stand on the directional rim (SURFACE_EDGE_TREATMENT): the rim draws the
        // floating hairline, so the clipped surface carries no border or flat edge of its own.
        expect(clipStyle.borderWidth).toBe(0);
        expect(clipStyle.borderBottomColor).toBeUndefined();
        const hairlines = screen.findAll((node) => String(node.type) === 'Rect' && node.props.fill === 'none');
        expect(hairlines.map((node) => node.props.stroke)).toContain('rgba(0,0,0,0.08)');
        expect(hasShadow(frameStyle)).toBe(true);
        expect(hasShadow(clipStyle)).toBe(false);
    });

    it('keeps native popover shadows outside the clipped rounded surface', async () => {
        shared.platformOS = 'ios';
        shared.themeOverride = {
            colors: {
                border: { modal: 'rgba(0,0,0,0.08)' },
            },
        };

        for (const surfaceChrome of ['modal', 'theme'] as const) {
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
            // The clip bounds the content to the rounded surface; the frame keeps the same bound.
            expect(clipStyle.maxHeight).toBe(200);
            expect(frameStyle.maxHeight).toBe(200);
        }
    });
});

// I1: a menu or picker opened from a configuration page keeps its grouped look. The overlay is the
// one owner of that reset, on both the plain and the arrowed frame.
function PresentationProbe() {
    return React.createElement('Probe', { presentation: useListPresentation() });
}

describe('FloatingOverlay list presentation (I1)', () => {
    it.each([
        ['without an arrow', {}],
        ['with an arrow', { arrow: { placement: 'bottom' } }],
    ])('resets page presentation to grouped for its content %s', async (_label, props) => {
        const screen = await renderScreen(
            React.createElement(
                ListPresentationProvider,
                { value: 'page', children: null },
                React.createElement(PresentationProbe),
                React.createElement(FloatingOverlay, {
                    maxHeight: 200,
                    ...props,
                    children: React.createElement(PresentationProbe),
                } as React.ComponentProps<typeof FloatingOverlay>),
            ),
        );
        const probes = screen.findAllByType('Probe' as never).map((node) => node.props.presentation);
        // The page content outside the overlay stays page; the overlay content is grouped.
        expect(probes).toEqual(['page', 'grouped']);
    });
});

// L77: a list inside an overlay (Home's Sections popover) autoscrolls the overlay's own scroller, never the page behind it.
describe('FloatingOverlay scroll source', () => {
    it('registers its scroller as the scroll source of its content, and still hands the same node to scrollViewRef', async () => {
        const scroller = { scroller: true };
        let seen: React.RefObject<unknown> | null = null;
        function SourceProbe() { seen = usePopoverScrollSourceRef(); return null; }
        const external = React.createRef<unknown>();
        await renderScreen(
            React.createElement(FloatingOverlay, { maxHeight: 200, scrollViewRef: external as never, children: React.createElement(SourceProbe) }),
            { createNodeMock: (element) => (element.type === 'AnimatedScrollView' ? scroller : null) },
        );
        expect(seen).not.toBeNull();
        expect(seen!.current).toBe(scroller);
        expect(external.current).toBe(scroller);
    });
});

describe('FloatingOverlay scroll edge under fixed chrome', () => {
    it('anchors its scroll-edge fades and indicators to the scroll viewport, not to the surface around a pinned header and footer', async () => {
        const screen = await renderScreen(
            React.createElement(FloatingOverlay, {
                maxHeight: 300,
                edgeFades: { top: true, bottom: true },
                edgeIndicators: true,
                header: React.createElement('View', { testID: 'menu-header' }),
                footer: React.createElement('View', { testID: 'menu-footer' }),
                children: React.createElement(Child),
            } as React.ComponentProps<typeof FloatingOverlay>),
        );
        const scroller = screen.findAllByType('AnimatedScrollView' as never)[0]!;
        // Scrolled into the middle: rows run past both edges of the viewport.
        await act(async () => {
            scroller.props.onScroll({ nativeEvent: {
                contentOffset: { x: 0, y: 100 },
                layoutMeasurement: { width: 200, height: 100 },
                contentSize: { width: 200, height: 500 },
            } });
        });
        const contains = (node: { findAll: (p: (n: { props: Record<string, unknown> }) => boolean) => unknown[] }, testID: string) =>
            node.findAll((candidate) => candidate.props.testID === testID).length > 0;
        const edgeCues = [
            ...screen.findAllByType('LinearGradient' as never),
            ...screen.findAll((node) => String(node.type) === 'Icon' && (node.props.name === 'caret-up' || node.props.name === 'caret-down')),
        ];
        expect(edgeCues.length).toBeGreaterThanOrEqual(2);
        for (const cue of edgeCues) {
            // The cue's frame is the nearest box that also holds the scroll viewport.
            let frame = cue.parent;
            while (frame && !frame.findAll((node) => node === scroller).length) frame = frame.parent;
            expect(frame).toBeTruthy();
            // Absolute cues positioned in that frame start at the viewport's edges only when the pinned chrome is outside it.
            expect(contains(frame!, 'menu-header')).toBe(false);
            expect(contains(frame!, 'menu-footer')).toBe(false);
        }
    });

    it('fades the rows themselves at a scrolled-past viewport edge on the web, where the glass surface leaves a painted fade nothing to paint', async () => {
        const screen = await renderScreen(
            React.createElement(FloatingOverlay, {
                maxHeight: 300,
                edgeFades: { top: true, bottom: true },
                header: React.createElement('View', { testID: 'menu-header' }),
                children: React.createElement(Child),
            } as React.ComponentProps<typeof FloatingOverlay>),
        );
        const scroller = () => screen.findAllByType('AnimatedScrollView' as never)[0]!;
        expect(flattenStyle(scroller().props.style).maskImage).toBeUndefined();
        await act(async () => {
            scroller().props.onScroll({ nativeEvent: {
                contentOffset: { x: 0, y: 100 },
                layoutMeasurement: { width: 200, height: 100 },
                contentSize: { width: 200, height: 500 },
            } });
        });
        const style = flattenStyle(scroller().props.style);
        // Clear at the viewport's top and bottom edges, solid between.
        expect(String(style.maskImage)).toMatch(/^linear-gradient\(to bottom, transparent 0px, black \d+px, black calc\(100% - \d+px\), transparent 100%\)$/);
        expect(style.WebkitMaskImage).toBe(style.maskImage);
    });
});
