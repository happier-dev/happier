import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import type { ActivityIndicatorProps } from 'react-native';

/**
 * Core draws native spinners through the same shared dot owner plugins use; the native-driver clock
 * itself is proven at that owner (`packages/plugin-ui/src/presentation/feedback/Spinner.native.test.tsx`).
 * Here the contract is core's: its colour, its setting, and the pause/reduced-motion facts it injects.
 */
const reducedMotionState = vi.hoisted(() => ({
    current: false,
    listener: null as ((enabled: boolean) => void) | null,
}));
const localSettingValues = vi.hoisted(() => ({}) as Partial<Record<string, unknown>>);
const nativeBoundary = vi.hoisted(() => ({ os: 'ios' as 'ios' | 'android' }));
/** `Animated.loop` hands the clock to the native driver; recording start/stop is the observable boundary. */
const animatedLoops = vi.hoisted(() => [] as Array<{ started: number; stopped: number }>);

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    const React = await import('react');
    return createReactNativeNativeMock({ platformOS: 'ios' }, {
        Platform: { get OS() { return nativeBoundary.os; } },
        View: 'View',
        // Android ProgressBarContainerView hides animating=false regardless of hidesWhenStopped.
        ActivityIndicator: (props: ActivityIndicatorProps) => React.createElement('ActivityIndicator', {
            ...props,
            nativeVisibility: nativeBoundary.os === 'android' && props.animating === false ? 'invisible' : 'visible',
        }),
        AccessibilityInfo: {
            isReduceMotionEnabled: async () => reducedMotionState.current,
            addEventListener: (_event: string, listener: (enabled: boolean) => void) => {
                reducedMotionState.listener = listener;
                return { remove: () => { reducedMotionState.listener = null; } };
            },
        },
        Animated: {
            loop: () => {
                const record = { started: 0, stopped: 0 };
                animatedLoops.push(record);
                return { start: () => { record.started += 1; }, stop: () => { record.stopped += 1; } };
            },
        },
    });
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

vi.mock('@/sync/store/hooks', async () => {
    const { createUseLocalSettingMock } = await import('@/dev/testkit/mocks/storage');
    return { useLocalSetting: createUseLocalSettingMock({ values: localSettingValues as Partial<LocalSettings> }) };
});

beforeEach(() => {
    nativeBoundary.os = 'ios';
    reducedMotionState.current = false;
    animatedLoops.length = 0;
    for (const key of Object.keys(localSettingValues)) delete localSettingValues[key];
});

function flattenStyle(style: unknown): Record<string, unknown> {
    if (!style) return {};
    if (Array.isArray(style)) {
        return style.reduce((acc, item) => Object.assign(acc, flattenStyle(item)), {} as Record<string, unknown>);
    }
    if (typeof style === 'object') return style as Record<string, unknown>;
    return {};
}

async function renderSpinner(props: Record<string, unknown>) {
    const { ActivitySpinner } = await import('./ActivitySpinner');
    const { act } = await import('react-test-renderer');
    await act(async () => reducedMotionState.listener?.(reducedMotionState.current));
    const screen = await renderScreen(<ActivitySpinner testID="spinner" size={18} {...props} />);
    const dots = screen.findAll((node) => (node.props as { testID?: string }).testID === 'happier-spinner-dot');
    const rings = screen.findAllByType('ActivityIndicator' as never);
    return { screen, dots, rings };
}

describe('ActivitySpinner (native)', () => {
    it('uses the chosen loading indicator for machine setup status and the installing picker marker', async () => {
        const { MachineAgentStatusLine } = await import('@/components/machines/agents/MachineAgentStatusLine');
        const { MachineAgentPickerMarker } = await import('@/components/machines/agents/MachineAgentPickerMarker');
        const screen = await renderScreen(<>
            <MachineAgentStatusLine status={{ kind: 'checking', tone: 'quiet' }} />
            <MachineAgentPickerMarker marker="installing" />
        </>);
        expect(screen.findAll((node) => node.props?.testID === 'happier-spinner-dot')).toHaveLength(16);
    });

    it('draws the mark with the shared dot owner in core colour', async () => {
        const { dots, rings } = await renderSpinner({});

        expect(rings).toHaveLength(0);
        expect(dots).toHaveLength(8);
        expect(flattenStyle(dots[0]!.props.style)).toMatchObject({ width: 3, backgroundColor: 'theme-secondary-text' });
    });

    it('holds the full mark still when ambient motion is paused', async () => {
        const { dots } = await renderSpinner({ animationEnabled: false });

        expect(dots.map((dot) => flattenStyle(dot.props.style).opacity)).toEqual(Array(8).fill(0.85));
    });

    it('holds the full mark still under reduced motion', async () => {
        reducedMotionState.current = true;
        const { dots } = await renderSpinner({});

        expect(dots.map((dot) => flattenStyle(dot.props.style).opacity)).toEqual(Array(8).fill(0.85));
    });

    it.each([
        { platform: 'android', variant: 'wave' },
        { platform: 'android', variant: 'classicRing' },
        { platform: 'ios', variant: 'classicRing' },
    ] as const)('removes a stopped hidden $variant from $platform accessibility and restores it on resume', async ({ platform, variant }) => {
        nativeBoundary.os = platform;
        localSettingValues.loadingIndicatorStyle = variant;
        const { ActivitySpinner } = await import('./ActivitySpinner');
        const { act } = await import('react-test-renderer');
        const spinner = (animating: boolean) => (
            <ActivitySpinner testID="spinner" accessible accessibilityLabel="Working" animating={animating} />
        );
        const screen = await renderScreen(spinner(false));
        const host = screen.findHostByTestId('spinner')!;
        expect(host.props).toMatchObject({
            accessible: false,
            accessibilityElementsHidden: true,
            importantForAccessibility: 'no-hide-descendants',
        });

        await act(async () => screen.update(spinner(true)));
        expect(screen.findHostByTestId('spinner')).toBe(host);
        expect(host.props.accessible).toBe(true);
        expect(host.props.accessibilityElementsHidden).not.toBe(true);
        expect(host.props.importantForAccessibility).not.toBe('no-hide-descendants');
    });

    it('releases its clock while the app is in the background and takes it back on return', async () => {
        // A fresh module graph, so the one app-wide visibility watch subscribes to this AppState.
        vi.resetModules();
        const { AppState } = await import('react-native');
        const { act } = await import('react-test-renderer');
        const { createReactNativeAppStateEmitter } = await import('@/dev/testkit/mocks/reactNative');
        const appState = createReactNativeAppStateEmitter();
        const restoreAppState = appState.install(AppState);
        const running = () => animatedLoops.filter((loop) => loop.started > loop.stopped).length;
        try {
            const { dots } = await renderSpinner({});
            expect(running()).toBe(1);

            await act(async () => appState.emit('background'));
            expect(running()).toBe(0);
            expect(dots).toHaveLength(8);

            await act(async () => appState.emit('active'));
            expect(running()).toBe(1);
        } finally {
            restoreAppState();
        }
    });

    it('pauses a pending release mark in the background and preserves the device-local H choice', async () => {
        vi.resetModules();
        localSettingValues.loadingIndicatorStyle = 'hWave';
        const { AppState } = await import('react-native');
        const { act } = await import('react-test-renderer');
        const { createReactNativeAppStateEmitter } = await import('@/dev/testkit/mocks/reactNative');
        const appState = createReactNativeAppStateEmitter();
        const restoreAppState = appState.install(AppState);
        const running = () => animatedLoops.filter((loop) => loop.started > loop.stopped).length;
        try {
            const { EntityReleaseOutcomePill } = await import('@/components/ui/treeDragDrop/ui/EntityReleasePreview');
            const screen = await renderScreen(<EntityReleaseOutcomePill outcome={{ tone: 'pending', title: 'Moving Review' }} />);
            expect(running()).toBe(1);
            await act(async () => appState.emit('background'));
            expect(running()).toBe(0);
            expect(screen.findAll((node) => node.props?.testID === 'happier-spinner-dot')).toHaveLength(7);
            await act(async () => appState.emit('active'));
            expect(running()).toBe(1);
        } finally {
            restoreAppState();
        }
    });

    describe('classic ring', () => {
        it.each([
            { pause: 'ambient', size: 'small', expectedSize: 20 },
            { pause: 'reduced motion', size: 'large', expectedSize: 36 },
            { pause: 'explicit stop', size: 16, expectedSize: 16 },
        ] as const)('keeps a visible still Android ring during $pause', async ({ pause, size, expectedSize }) => {
            nativeBoundary.os = 'android';
            localSettingValues.loadingIndicatorStyle = 'classicRing';
            reducedMotionState.current = pause === 'reduced motion';
            // Opaque native colours are passed to RN unchanged, rather than normalized as CSS ink.
            const color = pause === 'explicit stop' ? Object.freeze({ semantic: ['label'] }) : '#2468ab';
            const { screen, rings: nativeWidgets } = await renderSpinner({
                accessibilityLabel: 'Working',
                size,
                color,
                style: { marginLeft: 7 },
                animationEnabled: pause !== 'ambient',
                ...(pause === 'explicit stop' ? { animating: false, hidesWhenStopped: false } : {}),
            });
            const rings = screen.findAllByType('View' as never).filter((node) => flattenStyle(node.props.style).borderWidth);
            expect(nativeWidgets.some((node) => node.props.nativeVisibility === 'visible') || rings.length > 0).toBe(true);
            expect(nativeWidgets).toHaveLength(1);
            expect(nativeWidgets[0]!.props.nativeVisibility).toBe('invisible');
            expect(rings).toHaveLength(1);
            const ring = rings[0]!;
            expect(flattenStyle(ring.props.style)).toMatchObject({
                width: expectedSize, height: expectedSize, opacity: 1,
            });
            expect(flattenStyle(ring.props.style).borderColor).toBe(color);
            expect(flattenStyle(ring.props.style)).not.toHaveProperty('animationName');
            const host = screen.findHostByTestId('spinner')!;
            expect(flattenStyle(host.props.style)).toMatchObject({ marginLeft: 7 });
            expect(host.props).toMatchObject({ accessibilityRole: 'progressbar', accessibilityLabel: 'Working' });
            expect(host.props.accessibilityElementsHidden).not.toBe(true);
            expect(host.props.importantForAccessibility).not.toBe('no-hide-descendants');
            expect(ring.props.accessible).toBe(false);
        });

        it('preserves its Android native hosts while pausing, stopping and resuming', async () => {
            nativeBoundary.os = 'android';
            localSettingValues.loadingIndicatorStyle = 'classicRing';
            const { ActivitySpinner } = await import('./ActivitySpinner');
            const { act } = await import('react-test-renderer');
            const spinner = (props: Partial<React.ComponentProps<typeof ActivitySpinner>>) => (
                <ActivitySpinner testID="spinner" size={18} {...props} />
            );
            const screen = await renderScreen(spinner({}));
            const host = screen.findHostByTestId('spinner')!;
            const widget = screen.findByType('ActivityIndicator');
            const overlay = () => screen.findAllByType('View').find((node) => flattenStyle(node.props.style).borderWidth);
            const stillRing = overlay();

            expect(stillRing).toBeDefined();
            expect(flattenStyle(stillRing!.props.style).opacity).toBe(0);
            for (const props of [
                { animationEnabled: false },
                { animating: false, hidesWhenStopped: true },
                {},
            ]) {
                await act(async () => screen.update(spinner(props)));
                expect(screen.findHostByTestId('spinner')).toBe(host);
                expect(screen.findByType('ActivityIndicator')).toBe(widget);
                expect(overlay()).toBe(stillRing);
                expect(flattenStyle(stillRing!.props.style).opacity).toBe('animationEnabled' in props ? 1 : 0);
            }
            expect(widget.props.nativeVisibility).toBe('visible');
        });

        it('retains the Android platform widget when turning or explicitly stopped and hidden', async () => {
            nativeBoundary.os = 'android';
            localSettingValues.loadingIndicatorStyle = 'classicRing';
            expect((await renderSpinner({})).rings[0]!.props.nativeVisibility).toBe('visible');
            expect((await renderSpinner({ animating: false })).rings[0]!.props.nativeVisibility).toBe('invisible');
            expect((await renderSpinner({ animating: false, hidesWhenStopped: true })).rings[0]!.props.nativeVisibility).toBe('invisible');
        });

        it('animates by default and never hands the platform component an unknown prop', async () => {
            localSettingValues.loadingIndicatorStyle = 'classicRing';
            const { rings } = await renderSpinner({});
            const props = rings[0]!.props as Record<string, unknown>;

            expect(rings).toHaveLength(1);
            expect(props.animating).toBeUndefined();
            expect(props.color).toBe('theme-secondary-text');
            expect(props).not.toHaveProperty('animationEnabled');
            expect(props).not.toHaveProperty('variant');
        });

        it('actually stops the native ring when ambient motion is paused, and keeps it visible', async () => {
            localSettingValues.loadingIndicatorStyle = 'classicRing';
            const { rings } = await renderSpinner({ animationEnabled: false });
            const props = rings[0]!.props as Record<string, unknown>;

            expect(props.animating).toBe(false);
            expect(props.hidesWhenStopped).toBe(false);
        });

        it('preserves explicit stopped visibility under reduced motion and ambient pause', async () => {
            localSettingValues.loadingIndicatorStyle = 'classicRing';
            reducedMotionState.current = true;
            const running = (await renderSpinner({})).rings[0]!.props;
            expect(running.animating).toBe(false);
            expect(running.hidesWhenStopped).toBe(false);

            const stopped = (await renderSpinner({ animating: false, animationEnabled: false })).rings[0]!.props;
            expect(stopped.animating).toBe(false);
            expect(stopped.hidesWhenStopped).toBeUndefined();
            const hidden = (await renderSpinner({ animating: false, hidesWhenStopped: true })).rings[0]!.props;
            expect(hidden.hidesWhenStopped).toBe(true);
            const visible = (await renderSpinner({ animating: false, hidesWhenStopped: false })).rings[0]!.props;
            expect(visible.hidesWhenStopped).toBe(false);
        });

        it('leaves an explicitly stopped ring alone, so hiding it stays the caller\'s decision', async () => {
            localSettingValues.loadingIndicatorStyle = 'classicRing';
            const { rings } = await renderSpinner({ animating: false });
            const props = rings[0]!.props as Record<string, unknown>;

            expect(props.animating).toBe(false);
            expect(props.hidesWhenStopped).toBeUndefined();
        });
    });
});
