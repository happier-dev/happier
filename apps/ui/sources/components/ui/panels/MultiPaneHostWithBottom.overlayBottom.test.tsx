import * as React from 'react';
import { Platform } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import { MultiPaneHostWithBottom } from './MultiPaneHostWithBottom';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { usePluginSurfaceFocusEligibility } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';


const reducedMotionPreference = vi.hoisted(() => ({ value: false }));

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => reducedMotionPreference.value,
}));

describe('MultiPaneHostWithBottom (overlayBottom)', () => {
    const overlayCloseDurationMs = motionTokens.durationMs.base;
    const originalWindow = (globalThis as any).window;

    beforeEach(() => {
        vi.useFakeTimers();
        reducedMotionPreference.value = false;
    });

    afterEach(() => {
        standardCleanup();
        vi.useRealTimers();
        (globalThis as any).window = originalWindow;
    });

    it('renders a scrim for overlay bottom and closes on scrim press', async () => {
        const onCloseBottom = vi.fn();

        const screen = await renderScreen(<MultiPaneHostWithBottom
                    main={<Main />}
                    rightPane={null}
                    detailsPane={null}
                    layout={{ kind: 'single', right: 'hidden', details: 'hidden' }}
                    rightDockWidthPx={360}
                    detailsDockWidthPx={520}
                    onCloseRight={() => {}}
                    onCloseDetails={() => {}}
                    onCommitRightDockWidthPx={() => {}}
                    onCommitDetailsDockWidthPx={() => {}}
                    bottomPane={<Bottom />}
                    bottomPresentation="overlay"
                    bottomDockHeightPx={320}
                    bottomDockMinHeightPx={200}
                    bottomDockMaxHeightPx={600}
                    onCloseBottom={onCloseBottom}
                    onCommitBottomDockHeightPx={() => {}}
                />);

        expect(screen.findByTestId('multi-pane-bottom-scrim')).toBeTruthy();
        await screen.pressByTestIdAsync('multi-pane-bottom-scrim');
        expect(onCloseBottom).toHaveBeenCalledTimes(0);
        await flushHookEffects({ advanceTimersMs: overlayCloseDurationMs });
        expect(onCloseBottom).toHaveBeenCalledTimes(1);
    });

    it('closes overlay bottom on Escape key press and prevents inner pane closures', async () => {
        const onCloseBottom = vi.fn();
        const onCloseRight = vi.fn();
        const originalPlatform = Platform.OS;

        const fakeWindow = new (globalThis as any).EventTarget();
        (globalThis as any).window = fakeWindow;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
        try {
            const screen = await renderScreen(<MultiPaneHostWithBottom
                        main={<Main />}
                        rightPane={<Right />}
                        detailsPane={null}
                        layout={{ kind: 'overlayStack', right: 'overlay', details: 'hidden' }}
                        rightDockWidthPx={360}
                        detailsDockWidthPx={520}
                        onCloseRight={onCloseRight}
                        onCloseDetails={() => {}}
                        onCommitRightDockWidthPx={() => {}}
                        onCommitDetailsDockWidthPx={() => {}}
                        bottomPane={<Bottom />}
                        bottomPresentation="overlay"
                        bottomDockHeightPx={320}
                        bottomDockMinHeightPx={200}
                        bottomDockMaxHeightPx={600}
                        onCloseBottom={onCloseBottom}
                        onCommitBottomDockHeightPx={() => {}}
                    />);

            expect(screen.findByTestId('multi-pane-bottom-scrim')).toBeTruthy();
            act(() => {
                dispatchEscapeKeyDown(fakeWindow);
            });
            expect(onCloseBottom).toHaveBeenCalledTimes(0);
            expect(onCloseRight).toHaveBeenCalledTimes(0);
            await flushHookEffects({ advanceTimersMs: overlayCloseDurationMs });
            expect(onCloseBottom).toHaveBeenCalledTimes(1);
            expect(onCloseRight).toHaveBeenCalledTimes(0);
        } finally {
            Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
        }
    });

    it('keeps the outer bottom overlay ahead when an inner overlay opens later', async () => {
        const onCloseBottom = vi.fn();
        const onCloseRight = vi.fn();
        const originalPlatform = Platform.OS;

        const fakeWindow = new (globalThis as any).EventTarget();
        (globalThis as any).window = fakeWindow;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
        const renderHost = (rightPane: React.ReactNode | null) => (
            <MultiPaneHostWithBottom
                main={<Main />}
                rightPane={rightPane}
                detailsPane={null}
                layout={rightPane
                    ? { kind: 'overlayStack' as const, right: 'overlay' as const, details: 'hidden' as const }
                    : { kind: 'single' as const, right: 'hidden' as const, details: 'hidden' as const }}
                rightDockWidthPx={360}
                detailsDockWidthPx={520}
                onCloseRight={onCloseRight}
                onCloseDetails={() => {}}
                onCommitRightDockWidthPx={() => {}}
                onCommitDetailsDockWidthPx={() => {}}
                bottomPane={<Bottom />}
                bottomPresentation="overlay"
                bottomDockHeightPx={320}
                bottomDockMinHeightPx={200}
                bottomDockMaxHeightPx={600}
                onCloseBottom={onCloseBottom}
                onCommitBottomDockHeightPx={() => {}}
            />
        );

        try {
            const screen = await renderScreen(renderHost(null));
            await screen.update(renderHost(<Right />));

            act(() => {
                dispatchEscapeKeyDown(fakeWindow);
            });
            await flushHookEffects({ advanceTimersMs: overlayCloseDurationMs });

            expect(onCloseBottom).toHaveBeenCalledTimes(1);
            expect(onCloseRight).not.toHaveBeenCalled();
        } finally {
            Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
        }
    });

    it('closes overlay bottom immediately when reduced motion is enabled', async () => {
        reducedMotionPreference.value = true;
        const onCloseBottom = vi.fn();
        const screen = await renderScreen(<MultiPaneHostWithBottom
                    main={<Main />}
                    rightPane={null}
                    detailsPane={null}
                    layout={{ kind: 'single', right: 'hidden', details: 'hidden' }}
                    rightDockWidthPx={360}
                    detailsDockWidthPx={520}
                    onCloseRight={() => {}}
                    onCloseDetails={() => {}}
                    onCommitRightDockWidthPx={() => {}}
                    onCommitDetailsDockWidthPx={() => {}}
                    bottomPane={<Bottom />}
                    bottomPresentation="overlay"
                    bottomDockHeightPx={320}
                    bottomDockMinHeightPx={200}
                    bottomDockMaxHeightPx={600}
                    onCloseBottom={onCloseBottom}
                    onCommitBottomDockHeightPx={() => {}}
                />);

        await screen.pressByTestIdAsync('multi-pane-bottom-scrim');

        expect(onCloseBottom).toHaveBeenCalledTimes(1);
    });

    it('keeps the overlay bottom resizable', async () => {
        const screen = await renderScreen(<MultiPaneHostWithBottom
                    main={<Main />}
                    rightPane={null}
                    detailsPane={null}
                    layout={{ kind: 'single', right: 'hidden', details: 'hidden' }}
                    rightDockWidthPx={360}
                    detailsDockWidthPx={520}
                    onCloseRight={() => {}}
                    onCloseDetails={() => {}}
                    onCommitRightDockWidthPx={() => {}}
                    onCommitDetailsDockWidthPx={() => {}}
                    bottomPane={<Bottom />}
                    bottomPresentation="overlay"
                    bottomDockHeightPx={320}
                    bottomDockMinHeightPx={200}
                    bottomDockMaxHeightPx={600}
                    onCloseBottom={() => {}}
                    onCommitBottomDockHeightPx={() => {}}
                />);

        expect(screen.findByTestId('multi-pane-bottom-overlay-pane')).toBeTruthy();
        expect(screen.findByTestId('multi-pane-bottom-overlay-resize-handle')).toBeTruthy();
    });

    it('keeps the retained underlay mounted but hides it from web pointer, keyboard, and accessibility interaction', async () => {
        const originalPlatform = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
        const tracker = createMountTracker();
        try {
            const screen = await renderScreen(renderOverlayBottom(<TrackedMain tracker={tracker} />));

            expect(tracker.mounts).toBe(1);
            const underlay = screen.findByTestId('multi-pane-bottom-underlay');
            expect(underlay).not.toBeNull();
            expect(underlay?.props).toMatchObject({
                inert: true,
                'aria-hidden': true,
                pointerEvents: 'none',
            });
            expect(tracker.unmounts).toBe(0);
        } finally {
            Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
        }
    });

    it('lets the presented overlay retain focus eligibility while its retained underlay loses it', async () => {
        const screen = await renderScreen(renderOverlayBottom(
            <FocusEligibilityProbe testID="multi-pane-bottom-main-focus" />,
            <FocusEligibilityProbe testID="multi-pane-bottom-overlay-focus" />,
        ));

        expect(screen.findByTestId('multi-pane-bottom-main-focus')?.props.eligible).toBe(false);
        expect(screen.findByTestId('multi-pane-bottom-overlay-focus')?.props.eligible).toBe(true);
    });

    it('makes an overlay bottom a native accessibility modal while hiding the retained underlay descendants', async () => {
        const originalPlatform = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
        const tracker = createMountTracker();
        try {
            const screen = await renderScreen(renderOverlayBottom(<TrackedMain tracker={tracker} />));

            expect(tracker.mounts).toBe(1);
            expect(screen.findByTestId('multi-pane-bottom-underlay')?.props).toMatchObject({
                inert: undefined,
                'aria-hidden': undefined,
                accessibilityElementsHidden: true,
                importantForAccessibility: 'no-hide-descendants',
                pointerEvents: 'none',
            });
            expect(screen.findByTestId('multi-pane-bottom-overlay')?.props).toMatchObject({
                accessibilityViewIsModal: true,
            });
            expect(tracker.unmounts).toBe(0);
        } finally {
            Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
        }
    });
});

function renderOverlayBottom(main: React.ReactNode, bottomPane: React.ReactNode = <Bottom />) {
    return (
        <MultiPaneHostWithBottom
            main={main}
            rightPane={null}
            detailsPane={null}
            layout={{ kind: 'single', right: 'hidden', details: 'hidden' }}
            rightDockWidthPx={360}
            detailsDockWidthPx={520}
            onCloseRight={() => {}}
            onCloseDetails={() => {}}
            onCommitRightDockWidthPx={() => {}}
            onCommitDetailsDockWidthPx={() => {}}
            bottomPane={bottomPane}
            bottomPresentation="overlay"
            bottomDockHeightPx={320}
            bottomDockMinHeightPx={200}
            bottomDockMaxHeightPx={600}
            onCloseBottom={() => {}}
            onCommitBottomDockHeightPx={() => {}}
        />
    );
}

function Main() {
    return React.createElement('Main');
}

function Right() {
    return React.createElement('Right');
}

function Bottom() {
    return React.createElement('Bottom');
}

type MountTracker = {
    mounts: number;
    unmounts: number;
};

function createMountTracker(): MountTracker {
    return { mounts: 0, unmounts: 0 };
}

function TrackedMain(props: Readonly<{ tracker: MountTracker }>) {
    React.useEffect(() => {
        props.tracker.mounts += 1;
        return () => {
            props.tracker.unmounts += 1;
        };
    }, [props.tracker]);
    return React.createElement('TrackedMain');
}

function FocusEligibilityProbe(props: Readonly<{ testID: string }>): React.ReactElement {
    return React.createElement('FocusEligibilityProbe', {
        testID: props.testID,
        eligible: usePluginSurfaceFocusEligibility(),
    });
}

function dispatchEscapeKeyDown(target: EventTarget) {
    const event = new Event('keydown');
    Object.defineProperty(event, 'key', {
        configurable: true,
        enumerable: true,
        value: 'Escape',
    });
    target.dispatchEvent(event);
}
