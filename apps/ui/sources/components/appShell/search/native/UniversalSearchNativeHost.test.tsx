import * as React from 'react';
import { layoutHitArea } from '@/dev/testkit/harness/hitFrameReach';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { SelectionListStep } from '@/components/ui/selectionList';
import { setReducedMotionPreferenceOverride } from '@/hooks/ui/useReducedMotionPreference';
import { resolveHappierMinimumInteractiveTargetSize } from '@happier-dev/plugin-ui/environment';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const keyboardState = vi.hoisted(() => ({ height: 0 }));
const safeAreaState = vi.hoisted(() => ({ top: 59, bottom: 34, left: 0, right: 0 }));
const keyboardDismiss = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    // This host only ever renders on iOS/Android, and `pointerEvents` routing differs by platform;
    // testing it under the web runtime would assert the wrong seam.
    return createReactNativeWebMock({
        Platform: { OS: 'ios' },
        Keyboard: { dismiss: keyboardDismiss },
        useWindowDimensions: () => ({ width: 390, height: 844, scale: 3, fontScale: 1 }),
    });
});

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => safeAreaState,
    initialWindowMetrics: {
        insets: { top: 59, bottom: 34, left: 0, right: 0 },
        frame: { x: 0, y: 0, width: 390, height: 844 },
    },
}));

// The Node resolver selects the base/web sibling. Map this iOS suite to the
// genuine native sibling; it retains the owner's safe-area normalization.
vi.mock('@/hooks/ui/useKeyboardHeight', () => import('@/hooks/ui/useKeyboardHeight.native'));
// Only the native controller observation is substituted, preserving the rest
// of the package's canonical Node adapter used by KeyboardAwareScreen.
vi.mock('react-native-keyboard-controller', async importOriginal => ({
    ...await importOriginal<typeof import('react-native-keyboard-controller')>(),
    useKeyboardState: () => ({
        height: keyboardState.height > 0 ? keyboardState.height + safeAreaState.bottom : 0,
        isVisible: keyboardState.height > 0,
        progress: keyboardState.height > 0 ? 1 : 0,
    }),
}));

function makeStep(overrides: Partial<SelectionListStep> = {}): SelectionListStep {
    return {
        id: 'universal-search',
        title: 'Search',
        inputPlaceholder: 'Search Happier',
        sections: [
            {
                kind: 'static',
                id: 'commands',
                options: [{ id: 'commands:new-session', label: 'New Session' }],
            },
        ],
        ...overrides,
    };
}

function defaultProps(overrides: Record<string, unknown> = {}) {
    return {
        rootStep: makeStep(),
        query: '',
        onChangeQuery: vi.fn(),
        onSelect: vi.fn(),
        onRequestClose: vi.fn(),
        ...overrides,
    };
}

afterEach(() => {
    vi.useRealTimers();
    keyboardState.height = 0;
    safeAreaState.top = 59;
    safeAreaState.bottom = 34;
    safeAreaState.left = 0;
    safeAreaState.right = 0;
    keyboardDismiss.mockReset();
    setReducedMotionPreferenceOverride(null);
    standardCleanup();
    vi.restoreAllMocks();
});

describe('UniversalSearchNativeHost', () => {
    it('marks the native Search surface as an accessibility modal', async () => {
        const { UniversalSearchNativeHost } = await import('./UniversalSearchNativeHost');
        const screen = await renderScreen(<UniversalSearchNativeHost {...(defaultProps() as any)} />);
        const host = screen.findByTestId('universal-search-native-host');
        expect(host?.props.accessibilityViewIsModal).toBe(true);
    });

    it('seats the controller-owned catalog in one canonical bottom-placed input', async () => {
        const { UniversalSearchNativeHost } = await import('./UniversalSearchNativeHost');
        const { SelectionList } = await import('@/components/ui/selectionList');
        const scopeFilters = [{ id: 'scope', label: 'Home', valueLabel: 'Studio' }];
        const props = defaultProps({ filters: scopeFilters });

        const screen = await renderScreen(<UniversalSearchNativeHost {...(props as any)} />);

        const list = screen.root.findByType(SelectionList);
        expect(list.props.inputPlacement).toBe('bottom');
        // Explicit opening focuses the field and may raise the keyboard (§9.3).
        expect(list.props.autoFocusInputOnNative).toBe(true);
        expect(list.props.rootStep).toBe(props.rootStep);
        expect(list.props.inputValue).toBe('');
        expect(list.props.onChangeInputValue).toBe(props.onChangeQuery);
        expect(list.props.onSelect).toBe(props.onSelect);
        expect(list.props.filters).toBe(scopeFilters);
        // One query owner: the host never renders a search field of its own beside the list's.
        expect(screen.root.findAllByType('TextInput' as unknown as React.ComponentType)).toHaveLength(1);
    });

    it('caps the results region at the room the keyboard leaves', async () => {
        const { UniversalSearchNativeHost } = await import('./UniversalSearchNativeHost');
        const { SelectionList } = await import('@/components/ui/selectionList');
        const { resolveUniversalSearchPlaneMaxHeight } = await import('./universalSearchNativeGeometry');
        const { OVERLAY_CAPSULE_ROW_HEIGHT } = await import('@/components/ui/overlays/OverlayCapsuleButton');
        keyboardState.height = 336;

        const screen = await renderScreen(<UniversalSearchNativeHost {...(defaultProps() as any)} />);

        expect(screen.root.findByType(SelectionList).props.maxHeight).toBe(
            resolveUniversalSearchPlaneMaxHeight({
                windowHeight: 844,
                safeAreaTop: 59,
                // The host owns the bottom edge too: the frame reserves the whole keyboard, and with
                // the keyboard down the plane pads itself by the home indicator.
                safeAreaBottom: 34,
                keyboardHeight: 336,
                capsuleRowHeight: OVERLAY_CAPSULE_ROW_HEIGHT,
            }),
        );
    });

    it('seats the plane above the home indicator only while the keyboard is down', async () => {
        const { UniversalSearchNativeHost } = await import('./UniversalSearchNativeHost');
        const screen = await renderScreen(<UniversalSearchNativeHost {...(defaultProps() as any)} />);
        const flatten = (style: unknown): Record<string, unknown> => (
            Array.isArray(style)
                ? style.reduce<Record<string, unknown>>((acc, entry) => ({ ...acc, ...flatten(entry) }), {})
                : (style as Record<string, unknown> | null) ?? {}
        );

        expect(flatten(screen.findHostByTestId('universal-search-native-host:plane')?.props.style).paddingBottom)
            .toBe(34);

        keyboardState.height = 336;
        await act(async () => {
            await screen.update(<UniversalSearchNativeHost {...(defaultProps() as any)} />);
        });

        expect(flatten(screen.findHostByTestId('universal-search-native-host:plane')?.props.style).paddingBottom)
            .toBe(0);
    });

    it('keeps the whole Search plane inside lateral safe areas', async () => {
        safeAreaState.left = 47;
        safeAreaState.right = 21;
        const { UniversalSearchNativeHost } = await import('./UniversalSearchNativeHost');
        const screen = await renderScreen(<UniversalSearchNativeHost {...(defaultProps() as any)} />);
        const flatten = (style: unknown): Record<string, unknown> => (
            Array.isArray(style)
                ? style.reduce<Record<string, unknown>>((acc, entry) => ({ ...acc, ...flatten(entry) }), {})
                : (style as Record<string, unknown> | null) ?? {}
        );

        expect(flatten(screen.findHostByTestId('universal-search-native-host:plane')?.props.style))
            .toMatchObject({ paddingLeft: 47, paddingRight: 21 });
    });

    it('keeps the full-screen touch barrier armed while suppressing duplicate close requests', async () => {
        vi.useFakeTimers();
        const { UniversalSearchNativeHost } = await import('./UniversalSearchNativeHost');
        const onRequestClose = vi.fn();
        const screen = await renderScreen(
            <UniversalSearchNativeHost {...(defaultProps({ onRequestClose }) as any)} />,
        );

        await act(async () => {
            screen.pressByTestId('universal-search-native-host:close');
        });
        expect(onRequestClose).toHaveBeenCalledTimes(1);

        // The route is still mounted while the native pop settles. It must continue covering the
        // prior screen, while the close-request guard independently makes later presses no-ops.
        await act(async () => {
            screen.pressByTestId('universal-search-native-host:backdrop');
            vi.advanceTimersByTime(1_001);
            screen.pressByTestId('universal-search-native-host:close');
        });
        expect(onRequestClose).toHaveBeenCalledTimes(1);
        expect(screen.findHostByTestId('universal-search-native-host')?.props.pointerEvents).toBe('box-none');
        expect(screen.findHostByTestId('universal-search-native-host:backdrop')).not.toBeNull();
    });

    it('retracts the keyboard after the close, not before it', async () => {
        const { UniversalSearchNativeHost } = await import('./UniversalSearchNativeHost');
        const order: string[] = [];
        keyboardDismiss.mockImplementation(() => order.push('keyboard'));
        const onRequestClose = vi.fn(() => order.push('close'));
        const screen = await renderScreen(
            <UniversalSearchNativeHost {...(defaultProps({ onRequestClose }) as any)} />,
        );

        await act(async () => {
            screen.pressByTestId('universal-search-native-host:close');
        });

        // Retracting first would drag the plane and the scrim down the keyboard's curve.
        expect(order).toEqual(['close', 'keyboard']);
    });

    it('closes from the backdrop', async () => {
        const { UniversalSearchNativeHost } = await import('./UniversalSearchNativeHost');
        const onRequestClose = vi.fn();
        const screen = await renderScreen(
            <UniversalSearchNativeHost {...(defaultProps({ onRequestClose }) as any)} />,
        );

        await act(async () => {
            screen.pressByTestId('universal-search-native-host:backdrop');
        });
        expect(onRequestClose).toHaveBeenCalledTimes(1);
    });

    it('offers keyboard dismissal only while the keyboard is up', async () => {
        const { UniversalSearchNativeHost } = await import('./UniversalSearchNativeHost');
        const screen = await renderScreen(<UniversalSearchNativeHost {...(defaultProps() as any)} />);
        expect(screen.findHostByTestId('universal-search-native-host:dismiss-keyboard')).toBeNull();

        keyboardState.height = 336;
        await act(async () => {
            await screen.update(<UniversalSearchNativeHost {...(defaultProps() as any)} />);
        });

        await act(async () => {
            screen.pressByTestId('universal-search-native-host:dismiss-keyboard');
        });
        expect(keyboardDismiss).toHaveBeenCalledTimes(1);
    });

    it('gives each capsule a real platform-minimum press frame without hit slop', async () => {
        const { UniversalSearchNativeHost } = await import('./UniversalSearchNativeHost');
        const { HappierUiPlatformProvider } = await import('@happier-dev/plugin-ui/environment');
        const screen = await renderScreen(<HappierUiPlatformProvider platform={{ platform: 'ios', colorScheme: 'light' }}>
            <UniversalSearchNativeHost {...(defaultProps() as any)} />
        </HappierUiPlatformProvider>);
        const close = screen.findHostByTestId('universal-search-native-host:close');
        const style = typeof close?.props.style === 'function'
            ? close.props.style({ pressed: false })
            : close?.props.style;
        const flatten = (value: unknown): Record<string, unknown> => (
            Array.isArray(value)
                ? value.reduce<Record<string, unknown>>((acc, entry) => ({ ...acc, ...flatten(entry) }), {})
                : (value as Record<string, unknown> | null) ?? {}
        );

        // The capsule keeps its drawn size; the iOS floor is its hit area (a web frame, not hitSlop).
        const drawn = { width: Number(flatten(style).width), height: Number(flatten(style).height) };
        const area = await layoutHitArea(() => screen.findHostByTestId('universal-search-native-host:close'), drawn);
        expect(area.height).toBeGreaterThanOrEqual(resolveHappierMinimumInteractiveTargetSize('ios'));
        expect(area.width).toBeGreaterThanOrEqual(24);
    });

    it('offers an accessible clear action that preserves input focus', async () => {
        const { UniversalSearchNativeHost } = await import('./UniversalSearchNativeHost');
        const onChangeQuery = vi.fn();
        const screen = await renderScreen(
            <UniversalSearchNativeHost {...(defaultProps({ query: 'daemon', onChangeQuery }) as any)} />,
        );

        // The clear action lives inside the canonical input row (the list's
        // input-suffix slot), not as a second plane-level control.
        const clear = screen.findByProps({ testID: 'universal-search-native-host:clear' });
        expect(clear.props.accessibilityRole).toBe('button');
        expect(clear.props.accessibilityLabel).toBeTypeOf('string');
        expect((clear.props.accessibilityLabel as string).length).toBeGreaterThan(0);

        await act(async () => {
            clear.props.onPress?.();
        });
        expect(onChangeQuery).toHaveBeenCalledWith('');
        // Clearing must not resign the input: the keyboard stays exactly as
        // engaged as the close/dismiss controls leave it.
        expect(keyboardDismiss).not.toHaveBeenCalled();
    });

    it('hides the clear action while the query is empty', async () => {
        const { UniversalSearchNativeHost } = await import('./UniversalSearchNativeHost');
        const screen = await renderScreen(
            <UniversalSearchNativeHost {...(defaultProps({ query: '' }) as any)} />,
        );

        expect(screen.findAllByProps({ testID: 'universal-search-native-host:clear' })).toHaveLength(0);
    });

    it('keeps the same input mounted while sections publish and the keyboard resizes', async () => {
        const { UniversalSearchNativeHost } = await import('./UniversalSearchNativeHost');
        const props = defaultProps();
        const screen = await renderScreen(<UniversalSearchNativeHost {...(props as any)} />);
        const before = screen.findHostByTestId('universal-search-native-host:input');
        expect(before).not.toBeNull();

        keyboardState.height = 336;
        await act(async () => {
            // Keep the testkit's Profiler/provider ancestors mounted too.
            await screen.update(
                <UniversalSearchNativeHost
                    {...(defaultProps({
                        rootStep: makeStep({
                            sections: [
                                {
                                    kind: 'static',
                                    id: 'commands',
                                    options: [{ id: 'commands:new-session', label: 'New Session' }],
                                },
                                {
                                    kind: 'static',
                                    id: 'messages',
                                    options: [{ id: 'messages:1', label: 'Refactor the daemon' }],
                                },
                            ],
                        }),
                    }) as any)}
                />,
            );
        });

        expect(screen.findHostByTestId('universal-search-native-host:input')).toBe(before);
    });

    it('settles the scrim immediately under Reduced Motion', async () => {
        setReducedMotionPreferenceOverride(true);
        const reanimated = await import('react-native-reanimated');
        const timing = vi.spyOn(reanimated, 'withTiming');
        const { motionTokens } = await import('@/components/ui/motion/motionTokens');
        const { UniversalSearchNativeHost } = await import('./UniversalSearchNativeHost');
        const { OverlayScrim } = await import('@/components/ui/overlays/OverlayScrim');
        // The renderer's instance type is the function inside React.memo.
        const ScrimRender = (OverlayScrim as unknown as { readonly type: React.ElementType }).type;
        const screen = await renderScreen(<UniversalSearchNativeHost {...(defaultProps() as any)} />);

        expect(screen.root.findByType(ScrimRender)
            .props.progress.value).toBe(1);
        // The Node animation adapter settles immediately; the native SDK call
        // distinguishes a truly motion-free entrance from an animated one.
        expect(timing).not.toHaveBeenCalledWith(1, expect.objectContaining({
            duration: motionTokens.overlay.modal.enterMs,
        }));
    });
});
