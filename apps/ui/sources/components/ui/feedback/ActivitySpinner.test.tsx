import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: 'View',
        ActivityIndicator: 'ActivityIndicator',
        Platform: {
            OS: 'web',
            select: (options: Record<string, unknown>) => options.web ?? options.default,
        },
    });
});

vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                text: { secondary: 'theme-secondary-text' },
                accent: { indigo: 'accent-indigo', purple: 'accent-purple', orange: 'accent-orange' },
            },
        },
    });
});

const localSettingValues: Partial<LocalSettings> = {};

vi.mock('@/sync/store/hooks', async () => {
    const { createUseLocalSettingMock } = await import('@/dev/testkit/mocks/storage');
    const useLocalSetting = createUseLocalSettingMock();
    return {
        useLocalSetting: (key: keyof LocalSettings) => (key in localSettingValues ? localSettingValues[key] : useLocalSetting(key)),
    };
});

/**
 * The document is the one DOM boundary the spinner must never write to again: the old
 * implementation cached its frame sheets in document-level `<style>` rules, which WebKit bug
 * 237002 re-parsed on every rendering update. The stub records any attempt.
 */
type InjectedStyle = { id: string; textContent: string };
let injectedStyles: InjectedStyle[] = [];
let reducedMotionMatches = false;

beforeEach(() => {
    vi.resetModules();
    injectedStyles = [];
    reducedMotionMatches = false;
    for (const key of Object.keys(localSettingValues)) delete localSettingValues[key as keyof LocalSettings];
    vi.stubGlobal('document', {
        visibilityState: 'visible',
        getElementById: (id: string) => injectedStyles.find((style) => style.id === id) ?? null,
        createElement: () => ({ id: '', textContent: '' }),
        head: { appendChild: (style: InjectedStyle) => { injectedStyles.push(style); } },
    });
    vi.stubGlobal('window', {
        matchMedia: () => ({ matches: reducedMotionMatches, addEventListener: () => {} }),
    });
});

afterEach(() => {
    vi.unstubAllGlobals();
});

function flattenStyle(style: unknown): Record<string, unknown> {
    if (!style) return {};
    if (Array.isArray(style)) {
        return style.reduce((acc, item) => Object.assign(acc, flattenStyle(item)), {} as Record<string, unknown>);
    }
    if (typeof style === 'object') return style as Record<string, unknown>;
    return {};
}

type CapturedAnimation = { startTime: number | null; cancel: () => void };
type CapturedAnimateCall = Readonly<{ keyframes: unknown[]; options: Record<string, unknown> }>;

/** A stand-in host span: the DOM element the dot renders into, remembering what it was asked to animate. */
function createCapturedSpan(sink: CapturedAnimation[]): { animateCalls: CapturedAnimateCall[] } & Record<string, unknown> {
    const span: { animateCalls: CapturedAnimateCall[] } & Record<string, unknown> = {
        style: {},
        animateCalls: [],
        animate: (keyframes: unknown[], options: Record<string, unknown>) => {
            span.animateCalls.push({ keyframes, options });
            const animation: CapturedAnimation = { startTime: null, cancel: () => {} };
            sink.push(animation);
            return animation;
        },
    };
    return span;
}

async function renderSpinner(props: Record<string, unknown>) {
    const { ActivitySpinner } = await import('./ActivitySpinner');
    const spans: Array<{ animateCalls: CapturedAnimateCall[] } & Record<string, unknown>> = [];
    const animations: CapturedAnimation[] = [];
    const screen = await renderScreen(<ActivitySpinner testID="spinner" {...props} />, {
        createNodeMock: (element: { type: unknown }) => {
            if (element.type === 'span') {
                const span = createCapturedSpan(animations);
                spans.push(span);
                return span;
            }
            return undefined;
        },
    });
    const spinner = screen.findHostByTestId('spinner');
    if (!spinner) throw new Error('Expected the spinner to render');
    return {
        screen,
        spinner,
        spans,
        animations,
        dotSpans: () => screen.findAllByType('span' as never).map((node) => node.props as Record<string, unknown>),
    };
}

function dotStyle(props: Record<string, unknown>): Record<string, unknown> {
    const style = flattenStyle(props.style);
    expect(style.position).toBe('absolute');
    return style;
}

describe('ActivitySpinner (web)', () => {
    it.each(['wave', 'classicRing'] as const)('provides a localized accessible name for %s and preserves caller labels', async (variant) => {
        const { setPreferredLanguageFromSettings, t } = await import('@/text');
        setPreferredLanguageFromSettings('fr');
        try {
            const { ActivitySpinner } = await import('./ActivitySpinner');
            const { screen } = await renderSpinner({ variant });
            const host = screen.findHostByTestId('spinner')!;
            expect(host.props.accessibilityRole).toBe('progressbar');
            expect(host.props.accessibilityLabel).toBe(t('common.loading'));

            await screen.update(<ActivitySpinner testID="spinner" variant={variant} accessibilityLabel="Upload progress" />);
            expect(host.props.accessibilityLabel).toBe('Upload progress');
            await screen.update(<ActivitySpinner testID="spinner" variant={variant} accessibilityLabel="" />);
            expect(host.props.accessibilityLabel).toBe('');
        } finally {
            setPreferredLanguageFromSettings(null);
        }
    });

    it('draws the mark as DOM dots that never write a style sheet or SVG data URI into the document', async () => {
        const { spans } = await renderSpinner({ size: 12, color: 'red' });

        expect(spans).toHaveLength(8);
        expect(injectedStyles).toHaveLength(0);
        for (const span of spans) {
            for (const call of span.animateCalls) {
                expect(JSON.stringify(call)).not.toContain('data:image/svg');
            }
        }
        expect(JSON.stringify(spans)).not.toContain('data:image/svg');
    });

    it('steps each dot through its style’s sampled frame table on the document clock', async () => {
        const { getDotSpinnerFrames, readDotSeries } = await import('./activitySpinner/dotSpinnerFrames');
        const frames = getDotSpinnerFrames('wave', { speed: 'normal', pause: 'short' });
        const { spans, animations, dotSpans } = await renderSpinner({ size: 12, color: 'red' });

        expect(frames.dots).toHaveLength(spans.length);
        spans.forEach((span, index) => {
            expect(span.animateCalls).toHaveLength(1);
            const { keyframes, options } = span.animateCalls[0]!;
            expect(options).toEqual({ duration: frames.cycleMs, iterations: Infinity, easing: 'steps(1, end)' });
            expect(keyframes).toHaveLength(frames.frameCount);
            const expected = readDotSeries(frames, frames.opacity, index);
            expect(keyframes.map((frame) => (frame as { opacity: number }).opacity)).toEqual(expected);
            keyframes.forEach((frame, frameIndex) => {
                expect((frame as { offset: number }).offset).toBeCloseTo(frameIndex / frames.frameCount, 10);
            });
        });
        // Every animation is pinned to the document timeline’s origin, so all copies on the page
        // step on the same frame boundaries.
        expect(animations).toHaveLength(spans.length);
        for (const animation of animations) expect(animation.startTime).toBe(0);

        // A dot sits in the middle of its third-of-the-box cell and is a sixth of the box wide.
        const pitch = 12 / 3;
        const diameter = 12 / 6;
        spans.forEach((_, index) => {
            const dot = frames.dots[index]!;
            const style = dotStyle(dotSpans()[index]!);
            expect(style.left).toBe((dot.col + 0.5) * pitch - diameter / 2);
            expect(style.top).toBe((dot.row + 0.5) * pitch - diameter / 2);
            expect(style.width).toBe(diameter);
            expect(style.height).toBe(diameter);
            expect(style.borderRadius).toBe(diameter / 2);
            expect(style.backgroundColor).toBe('red');
        });
    });

    it('keeps the H a seven-dot mark and colors aurora with the theme accents', async () => {
        const mark = await renderSpinner({});
        expect(mark.spans).toHaveLength(8);

        const h = await renderSpinner({ variant: 'hWave' });
        expect(h.spans).toHaveLength(7);

        const aurora = await renderSpinner({ variant: 'hAurora' });
        expect(aurora.spans).toHaveLength(7);
        for (const props of aurora.dotSpans()) {
            const style = dotStyle(props);
            expect(String(style.backgroundImage)).toContain('accent-indigo');
            expect(String(style.backgroundImage)).toContain('accent-purple');
            expect(String(style.backgroundImage)).toContain('accent-orange');
            expect(style.backgroundColor).not.toBe('theme-secondary-text');
        }
        // Aurora travels by shifting its gradient, not by fading the dots.
        aurora.spans.forEach((span) => {
            expect(span.animateCalls).toHaveLength(1);
            const { keyframes } = span.animateCalls[0]!;
            for (const frame of keyframes) {
                expect((frame as Record<string, unknown>).opacity).toBeUndefined();
                expect(String((frame as Record<string, unknown>).backgroundPosition)).toMatch(/px 0px$/);
            }
        });
    });

    it('lets an explicit color win over aurora so the mark stays legible on tinted buttons', async () => {
        const explicit = await renderSpinner({ variant: 'hAurora', color: 'white' });
        for (const props of explicit.dotSpans()) {
            const style = dotStyle(props);
            expect(style.backgroundColor).toBe('white');
            expect(style.backgroundImage).toBeUndefined();
        }
    });

    it('draws the style chosen in settings, and a caller may preview another', async () => {
        localSettingValues.loadingIndicatorStyle = 'slowBreath';
        const chosen = await renderSpinner({ size: 16 });
        expect(chosen.spans[0]!.animateCalls[0]!.options.duration).toBe(2400);

        const preview = await renderSpinner({ size: 16, variant: 'radar' });
        expect(preview.spans[0]!.animateCalls[0]!.options.duration).toBe(1100);
    });

    it('falls back to the wave when the stored style is not one it knows', async () => {
        localSettingValues.loadingIndicatorStyle = 'retiredStyle' as never;
        const { spans } = await renderSpinner({ size: 16 });

        expect(spans[0]!.animateCalls[0]!.options.duration).toBe(1004);
    });

    it('plays at the speed and pause chosen in settings, and previews follow them', async () => {
        localSettingValues.loadingIndicatorSpeed = 'fast';
        localSettingValues.loadingIndicatorPause = 'long';
        const wave = await renderSpinner({ size: 16 });
        // 804 ms of motion at 1.5×, then the 500 ms pause.
        expect(wave.spans[0]!.animateCalls[0]!.options.duration).toBe(1036);

        // A continuous style takes the speed but has no pause to lengthen.
        const radar = await renderSpinner({ size: 16, variant: 'radar' });
        expect(radar.spans[0]!.animateCalls[0]!.options.duration).toBe(733);
    });

    it('plays unknown stored speeds and pauses at the defaults', async () => {
        localSettingValues.loadingIndicatorSpeed = 'warp' as never;
        localSettingValues.loadingIndicatorPause = 'forever' as never;
        const { spans } = await renderSpinner({ size: 16 });

        expect(spans[0]!.animateCalls[0]!.options.duration).toBe(1004);
    });

    it('uses the theme secondary text color and self-centers when no color is provided', async () => {
        const { spinner, dotSpans } = await renderSpinner({ size: 'small' });

        expect(flattenStyle(spinner.props.style).alignSelf).toBe('center');
        expect(flattenStyle(spinner.props.style).width).toBe(20);
        for (const props of dotSpans()) expect(dotStyle(props).backgroundColor).toBe('theme-secondary-text');
    });

    it('holds a still, fully drawn mark without scheduling any animation when ambient motion is paused', async () => {
        const { spans, dotSpans } = await renderSpinner({ size: 12, animationEnabled: false });

        expect(spans).toHaveLength(8);
        for (const span of spans) expect(span.animateCalls).toHaveLength(0);
        for (const props of dotSpans()) expect(dotStyle(props).opacity).toBe(0.85);
        expect(injectedStyles).toHaveLength(0);
    });

    it('drops every animation while the page is hidden, so an unseen tab never keeps a spinner moving', async () => {
        vi.stubGlobal('document', { ...globalThis.document, visibilityState: 'hidden' });
        const dots = await renderSpinner({ size: 12 });
        for (const span of dots.spans) expect(span.animateCalls).toHaveLength(0);
        for (const props of dots.dotSpans()) expect(dotStyle(props).opacity).toBe(0.85);

        reducedMotionMatches = true;
        const breathing = await renderSpinner({ size: 12 });
        expect(flattenStyle(breathing.spinner.props.style).animationName).toBeUndefined();
        for (const span of breathing.spans) expect(span.animateCalls).toHaveLength(0);

        localSettingValues.loadingIndicatorStyle = 'classicRing';
        const ring = await renderSpinner({ size: 12 });
        expect(flattenStyle(ring.spinner.props.style).animationName).toBeUndefined();
    });

    it('replaces the travelling light with a slow breath of the still chosen mark under reduced motion', async () => {
        reducedMotionMatches = true;
        const { spinner, spans, dotSpans } = await renderSpinner({ size: 12 });

        expect(flattenStyle(spinner.props.style).animationName).toBe('happierActivitySpinnerBreath');
        for (const span of spans) expect(span.animateCalls).toHaveLength(0);
        for (const props of dotSpans()) expect(dotStyle(props).opacity).toBe(0.85);
    });

    it('stops turning the classic ring under reduced motion', async () => {
        reducedMotionMatches = true;
        localSettingValues.loadingIndicatorStyle = 'classicRing';
        const { spinner } = await renderSpinner({ size: 12 });

        expect(flattenStyle(spinner.props.style).animationName).toBeUndefined();
    });

    it.each([false, true])('keeps an explicitly stopped classic ring visible without animating (reduced motion: %s)', async (reduceMotion) => {
        reducedMotionMatches = reduceMotion;
        localSettingValues.loadingIndicatorStyle = 'classicRing';
        const { spinner, spans } = await renderSpinner({ animating: false, hidesWhenStopped: false });

        expect(spans).toHaveLength(0);
        const style = flattenStyle(spinner.props.style);
        expect(style.animationName).toBeUndefined();
        expect(style.animationIterationCount).toBeUndefined();
        expect(style.opacity).toBe(1);
    });

    it.each(['wave', 'classicRing'] as const)('renders nothing when stopped and hidden with %s', async (variant) => {
        const { ActivitySpinner } = await import('./ActivitySpinner');
        const screen = await renderScreen(<ActivitySpinner testID="spinner" variant={variant} animating={false} />);

        expect(screen.findAllByType('View' as never)).toHaveLength(0);
        expect(screen.findAllByType('span' as never)).toHaveLength(0);
    });

    it('keeps the classic ring for people who choose it', async () => {
        localSettingValues.loadingIndicatorStyle = 'classicRing';
        const { spinner, spans } = await renderSpinner({ size: 12, color: 'red' });

        const style = flattenStyle(spinner.props.style);
        expect(spans).toHaveLength(0);
        expect(style.animationName).toBe('happierActivitySpinnerSpin');
        expect(style.animationTimingFunction).toBe('steps(6, end)');
        expect(style.width).toBe(12);
        expect(style.borderColor).toBe('red');
    });
});
