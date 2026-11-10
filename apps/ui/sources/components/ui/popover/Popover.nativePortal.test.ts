import React from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

import {
    findFirstHostNodeByTestId,
    findHostNodesByTestId,
    findPopoverContentView,
    flattenTestStyle,
    withPopoverWebGlobals,
} from '@/dev/testkit/harness/popoverHarness';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderScreen } from '@/dev/testkit';
import { installExpoBlurRequireStub } from '@/dev/testkit/mocks/expoBlur';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { installPopoverCommonModuleMocks } from './popoverTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const localSettingState = vi.hoisted(() => ({
    uiBackdropBlurEnabled: true,
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createPartialStorageModuleMock, createUseLocalSettingMock } = await import('@/dev/testkit/mocks/storage');
    return createPartialStorageModuleMock(importOriginal, {
        useLocalSetting: createUseLocalSettingMock({ values: localSettingState }),
    });
});

const INITIAL_POSITIONING_TICKS = 3;

async function flushInitialPositioning() {
    await flushHookEffects({ cycles: 2, turns: INITIAL_POSITIONING_TICKS, frames: 1 });
}

const restoreExpoBlur = installExpoBlurRequireStub();
afterAll(restoreExpoBlur);

installPopoverCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'ios',
            },
            useWindowDimensions: () => ({ width: 390, height: 844 }),
            View: (props: any) => React.createElement('View', props, props.children),
            Pressable: (props: any) => React.createElement('Pressable', props, props.children),
        });
    },
});

// Resolve the component graph during collection, outside behavior-test deadlines.
await import('./Popover');

function PopoverChild() {
    return React.createElement('PopoverChild');
}

function readNumericStyle(style: Record<string, unknown>, key: string): number {
    const value = style[key];
    if (typeof value !== 'number') {
        throw new Error(`Expected numeric ${key} style`);
    }
    return value;
}

function findNativePortalBackdropPressable(tree: ReturnType<typeof renderer.create> | undefined) {
    return tree?.root.findAllByType('Pressable' as any).find((node) => {
        return flattenTestStyle(node.props.style).zIndex === 200000;
    }) ?? null;
}

/**
 * A native popover waits for its placement out of sight by translation, never by opacity: UIKit renders no glass
 * created under an ancestor with alpha below 1 (iOS QA, PHONE-POPOVERS-1109).
 */
function nativeUnplacedState(view: { props?: { style?: unknown } } | null | undefined): Readonly<{ hidden: boolean; faded: boolean }> {
    const style = flattenTestStyle(view?.props?.style) as { opacity?: unknown; transform?: unknown };
    const transforms = Array.isArray(style.transform) ? style.transform as Array<Record<string, unknown>> : [];
    const hidden = transforms.some((entry) => typeof entry.translateX === 'number' && entry.translateX <= -10000);
    const faded = typeof style.opacity === 'number' && style.opacity < 1;
    return { hidden, faded };
}

describe('Popover (native portal)', () => {
    let restorePopoverWebGlobals: (() => void) | null = null;

    beforeEach(() => {
        restorePopoverWebGlobals = withPopoverWebGlobals();
    });

    afterEach(() => {
        restorePopoverWebGlobals?.();
        restorePopoverWebGlobals = null;
        vi.useRealTimers();
        localSettingState.uiBackdropBlurEnabled = true;
    });

    it('positions using anchor coordinates relative to the portal root when available (avoids iOS header/sheet offsets)', async () => {
        const { OverlayPortalHost, OverlayPortalProvider } = await import('./OverlayPortal');
        const { Popover } = await import('./Popover');
        const { PopoverPortalTargetContextProvider } = await import('./PopoverPortalTarget');

        const portalRootNode = { _id: 'portal-root' };

        const anchorRef = {
            current: {
                measureLayout: (relativeTo: any, onSuccess: any) => {
                    // Simulate coordinates relative to the portal root (e.g. inside a screen with a header).
                    if (relativeTo !== portalRootNode) throw new Error('expected measureLayout relativeTo portal root');
                    queueMicrotask(() => onSuccess(10, 20, 30, 40));
                },
                // If Popover mistakenly uses window coords here, it will position incorrectly.
                measureInWindow: (cb: any) => queueMicrotask(() => cb(999, 999, 30, 40)),
            },
        } as any;

        let tree: ReturnType<typeof renderer.create> | undefined;
        tree = (await renderScreen(React.createElement(
                    OverlayPortalProvider,
                    null,
                    React.createElement(
                        PopoverPortalTargetContextProvider,
                        {
                            value: { rootRef: { current: portalRootNode } as any, layout: { width: 390, height: 844 } },
                            children: React.createElement(Popover, {
                                open: true,
                                anchorRef,
                                placement: 'bottom',
                                portal: { native: true },
                                backdrop: false,
                                children: () => React.createElement(PopoverChild),
                            } as any),
                        } as any,
                    ),
                    React.createElement(OverlayPortalHost),
                ))).tree;

        await act(async () => {
            await flushInitialPositioning();
        });

        const container = tree ? findPopoverContentView(tree) : null;
        const style = flattenTestStyle(container?.props?.style);

        const paddingLeft = readNumericStyle(style, 'paddingLeft');
        const paddingTop = readNumericStyle(style, 'paddingTop');
        const paddingRight = readNumericStyle(style, 'paddingRight');
        expect(paddingLeft).toBeGreaterThan(0);
        expect(paddingTop).toBeGreaterThan(0);
        expect(paddingRight).toBe(paddingLeft);

        // placement=bottom => visual top = y + height + gap (default gap=8), while
        // the native portal wrapper reserves transparent breathing room for the shadow.
        expect(readNumericStyle(style, 'left') + paddingLeft).toBe(10);
        expect(readNumericStyle(style, 'top') + paddingTop).toBe(68);
        expect(readNumericStyle(style, 'width') - paddingLeft - paddingRight).toBe(30);
    });

    it('keeps native portal content mounted until the shared exit animation finishes', async () => {
        vi.useFakeTimers();

        const { OverlayPortalHost, OverlayPortalProvider } = await import('./OverlayPortal');
        const { Popover } = await import('./Popover');

        const anchorRef = {
            current: {
                measureInWindow: (cb: any) => {
                    queueMicrotask(() => cb(100, 100, 20, 20));
                },
            },
        } as any;

        const screen = await renderScreen(React.createElement(
            OverlayPortalProvider,
            null,
            React.createElement(Popover, {
                open: true,
                anchorRef,
                placement: 'bottom',
                portal: { native: true },
                backdrop: false,
                onRequestClose: () => {},
                children: () => React.createElement(PopoverChild),
            } as any),
            React.createElement(OverlayPortalHost),
        ));
        const tree = screen.tree;

        await act(async () => {
            await flushInitialPositioning();
        });
        expect(tree?.root.findAllByType('PopoverChild' as any)).toHaveLength(1);

        await act(async () => {
            await screen.update(React.createElement(
                OverlayPortalProvider,
                null,
                React.createElement(Popover, {
                    open: false,
                    anchorRef,
                    placement: 'bottom',
                    portal: { native: true },
                    backdrop: false,
                    onRequestClose: () => {},
                    children: () => React.createElement(PopoverChild),
                } as any),
                React.createElement(OverlayPortalHost),
            ));
        });

        expect(tree?.root.findAllByType('PopoverChild' as any)).toHaveLength(1);

        await act(async () => {
            vi.advanceTimersByTime(motionTokens.overlay.popover.exitMs - 1);
        });
        expect(tree?.root.findAllByType('PopoverChild' as any)).toHaveLength(1);

        await act(async () => {
            vi.advanceTimersByTime(1);
        });
        expect(tree?.root.findAllByType('PopoverChild' as any)).toHaveLength(0);
    });

    it('does not let a closing native backdrop intercept taps above follow-up modals', async () => {
        vi.useFakeTimers();

        const { OverlayPortalHost, OverlayPortalProvider } = await import('./OverlayPortal');
        const { Popover } = await import('./Popover');

        const anchorRef = {
            current: {
                measureInWindow: (cb: any) => {
                    queueMicrotask(() => cb(100, 100, 20, 20));
                },
            },
        } as any;

        const screen = await renderScreen(React.createElement(
            OverlayPortalProvider,
            null,
            React.createElement(Popover, {
                open: true,
                anchorRef,
                placement: 'bottom',
                portal: { native: true },
                backdrop: { enabled: true, blockOutsidePointerEvents: true },
                onRequestClose: () => {},
                children: () => React.createElement(PopoverChild),
            } as any),
            React.createElement(OverlayPortalHost),
        ));
        const tree = screen.tree;

        await act(async () => {
            await flushInitialPositioning();
        });

        // Fake timers also own requestAnimationFrame: let the real positioning
        // pass run before asserting that the measured portal accepts input.
        await flushHookEffects({ frames: 1 });

        // The motion frame owns content hit testing while the Popover remains
        // present. This preserves native responder behavior during the web-only
        // pointer-events style migration.
        expect(findPopoverContentView(tree)?.props.pointerEvents).toBe('auto');
        expect(findNativePortalBackdropPressable(tree)?.props.pointerEvents).toBe('auto');

        await act(async () => {
            await screen.update(React.createElement(
                OverlayPortalProvider,
                null,
                React.createElement(Popover, {
                    open: false,
                    anchorRef,
                    placement: 'bottom',
                    portal: { native: true },
                    backdrop: { enabled: true, blockOutsidePointerEvents: true },
                    onRequestClose: () => {},
                    children: () => React.createElement(PopoverChild),
                } as any),
                React.createElement(OverlayPortalHost),
            ));
        });

        expect(tree?.root.findAllByType('PopoverChild' as any)).toHaveLength(1);
        expect(findPopoverContentView(tree)?.props.pointerEvents).toBe('none');
        expect(findNativePortalBackdropPressable(tree)?.props.pointerEvents).toBe('none');

        await act(async () => {
            vi.advanceTimersByTime(motionTokens.overlay.popover.exitMs);
        });
        expect(findNativePortalBackdropPressable(tree)).toBeNull();
    });

    it('anchors top-placed portals using the portal root height (not the window height) so contained sheets/drawers do not offset', async () => {
        const { OverlayPortalHost, OverlayPortalProvider } = await import('./OverlayPortal');
        const { Popover } = await import('./Popover');
        const { PopoverPortalTargetContextProvider } = await import('./PopoverPortalTarget');

        const portalRootNode = { _id: 'portal-root' };

        const anchorRef = {
            current: {
                measureLayout: (relativeTo: any, onSuccess: any) => {
                    if (relativeTo !== portalRootNode) throw new Error('expected measureLayout relativeTo portal root');
                    // Simulate a trigger near the bottom of a contained sheet/drawer.
                    queueMicrotask(() => onSuccess(10, 450, 30, 40));
                },
                // If Popover mistakenly uses window coords here, it will position incorrectly.
                measureInWindow: (cb: any) => queueMicrotask(() => cb(999, 999, 30, 40)),
            },
        } as any;

        let tree: ReturnType<typeof renderer.create> | undefined;
        tree = (await renderScreen(React.createElement(
            OverlayPortalProvider,
            null,
            React.createElement(
                PopoverPortalTargetContextProvider,
                {
                    // Simulate a contained modal/sheet that's shorter than the device window.
                    value: { rootRef: { current: portalRootNode } as any, layout: { width: 390, height: 794 } },
                    children: React.createElement(Popover, {
                        open: true,
                        anchorRef,
                        placement: 'top',
                        portal: { native: true },
                        backdrop: false,
                        children: () => React.createElement(PopoverChild),
                    } as any),
                } as any,
            ),
            React.createElement(OverlayPortalHost),
        ))).tree;

        await act(async () => {
            await flushInitialPositioning();
        });

        const container = tree ? findPopoverContentView(tree) : null;
        const style = flattenTestStyle(container?.props?.style);

        // placement=top uses `bottom` positioning pinned to (anchorTop - gap).
        const paddingLeft = readNumericStyle(style, 'paddingLeft');
        const paddingRight = readNumericStyle(style, 'paddingRight');
        const paddingBottom = readNumericStyle(style, 'paddingBottom');
        expect(paddingBottom).toBeGreaterThan(0);

        // Expected visual bottom = portalHeight - (anchorTop - gap) = 794 - (450 - 8) = 352,
        // while the native portal wrapper reserves transparent breathing room for the shadow.
        expect(readNumericStyle(style, 'bottom') + paddingBottom).toBe(352);
        expect(readNumericStyle(style, 'left') + paddingLeft).toBe(10);
        expect(readNumericStyle(style, 'width') - paddingLeft - paddingRight).toBe(30);
    });

    it('falls back to deriving portal-root-relative anchor coordinates from window measurements when measureLayout is unavailable', async () => {
        const { OverlayPortalHost, OverlayPortalProvider } = await import('./OverlayPortal');
        const { Popover } = await import('./Popover');
        const { PopoverPortalTargetContextProvider } = await import('./PopoverPortalTarget');

        const portalRootNode = {
            _id: 'portal-root',
            measureInWindow: (cb: any) => queueMicrotask(() => cb(50, 100, 390, 844)),
        };

        const anchorRef = {
            current: {
                // Simulate an anchor node without `measureLayout` (some RN host components).
                measureInWindow: (cb: any) => queueMicrotask(() => cb(70, 150, 30, 40)),
            },
        } as any;

        let tree: ReturnType<typeof renderer.create> | undefined;
        tree = (await renderScreen(React.createElement(
                    OverlayPortalProvider,
                    null,
                    React.createElement(
                        PopoverPortalTargetContextProvider,
                        {
                            value: { rootRef: { current: portalRootNode } as any, layout: { width: 390, height: 844 } },
                            children: React.createElement(Popover, {
                                open: true,
                                anchorRef,
                                placement: 'bottom',
                                portal: { native: true },
                                backdrop: false,
                                children: () => React.createElement(PopoverChild),
                            } as any),
                        } as any,
                    ),
                    React.createElement(OverlayPortalHost),
                ))).tree;

        await act(async () => {
            await flushInitialPositioning();
        });

        const container = tree ? findPopoverContentView(tree) : null;
        const style = flattenTestStyle(container?.props?.style);

        const paddingLeft = readNumericStyle(style, 'paddingLeft');
        const paddingTop = readNumericStyle(style, 'paddingTop');
        const paddingRight = readNumericStyle(style, 'paddingRight');

        // Portal-root-relative anchor rect = window(anchor) - window(portalRoot):
        // x = 70-50=20, y = 150-100=50.
        // placement=bottom => visual top = y + height + gap (default gap=8)
        expect(readNumericStyle(style, 'left') + paddingLeft).toBe(20);
        expect(readNumericStyle(style, 'top') + paddingTop).toBe(98);
        expect(readNumericStyle(style, 'width') - paddingLeft - paddingRight).toBe(30);
    });

    it('can derive portal-root-relative anchor coordinates from the boundary window rect when the portal root cannot be measured', async () => {
        const { OverlayPortalHost, OverlayPortalProvider } = await import('./OverlayPortal');
        const { Popover } = await import('./Popover');
        const { PopoverPortalTargetContextProvider } = await import('./PopoverPortalTarget');

        const portalRootNode = {
            _id: 'portal-root',
            // Simulate a portal root that cannot be measured (common in cross-root / modal presentations).
            // The popover should still be able to derive portal-relative coordinates via the boundary.
        };

        const boundaryRef = {
            current: {
                measureInWindow: (cb: any) => queueMicrotask(() => cb(50, 100, 390, 844)),
            },
        } as any;

        const anchorRef = {
            current: {
                // Simulate an anchor node without `measureLayout`.
                measureInWindow: (cb: any) => queueMicrotask(() => cb(70, 150, 30, 40)),
            },
        } as any;

        let tree: ReturnType<typeof renderer.create> | undefined;
        tree = (await renderScreen(React.createElement(
            OverlayPortalProvider,
            null,
            React.createElement(
                PopoverPortalTargetContextProvider,
                {
                    value: { rootRef: { current: portalRootNode } as any, layout: { width: 390, height: 844 } },
                    children: React.createElement(Popover, {
                        open: true,
                        anchorRef,
                        boundaryRef,
                        placement: 'bottom',
                        portal: { native: true },
                        backdrop: false,
                        children: () => React.createElement(PopoverChild),
                    } as any),
                } as any,
            ),
            React.createElement(OverlayPortalHost),
        ))).tree;

        await act(async () => {
            await flushInitialPositioning();
        });

        const container = tree ? findPopoverContentView(tree) : null;
        const style = flattenTestStyle(container?.props?.style);

        const paddingLeft = readNumericStyle(style, 'paddingLeft');
        const paddingTop = readNumericStyle(style, 'paddingTop');
        const paddingRight = readNumericStyle(style, 'paddingRight');

        // Portal-relative anchor rect = window(anchor) - window(boundary):
        // x = 70-50=20, y = 150-100=50.
        // placement=bottom => visual top = y + height + gap (default gap=8)
        expect(readNumericStyle(style, 'left') + paddingLeft).toBe(20);
        expect(readNumericStyle(style, 'top') + paddingTop).toBe(98);
        expect(readNumericStyle(style, 'width') - paddingLeft - paddingRight).toBe(30);
    });

    it('does not mix window-relative boundary measurements with portal-root-relative anchor measurements (prevents off-screen menus)', async () => {
        const { OverlayPortalHost, OverlayPortalProvider } = await import('./OverlayPortal');
        const { Popover } = await import('./Popover');
        const { PopoverPortalTargetContextProvider } = await import('./PopoverPortalTarget');

        const portalRootNode = { _id: 'portal-root' };

        const anchorRef = {
            current: {
                measureLayout: (relativeTo: any, onSuccess: any) => {
                    if (relativeTo !== portalRootNode) throw new Error('expected measureLayout relativeTo portal root');
                    queueMicrotask(() => onSuccess(10, 100, 30, 40));
                },
                measureInWindow: (cb: any) => queueMicrotask(() => cb(999, 999, 30, 40)),
            },
        } as any;

        const boundaryRef = {
            current: {
                // If Popover wrongly uses this window-relative boundary rect while the anchor rect is
                // portal-root-relative, `topForBottom` clamps `top` to boundaryRect.y (off-screen).
                measureInWindow: (cb: any) => queueMicrotask(() => cb(0, 600, 390, 844)),
            },
        } as any;

        let tree: ReturnType<typeof renderer.create> | undefined;
        tree = (await renderScreen(React.createElement(
                    OverlayPortalProvider,
                    null,
                    React.createElement(
                        PopoverPortalTargetContextProvider,
                        {
                            value: { rootRef: { current: portalRootNode } as any, layout: { width: 0, height: 0 } },
                            children: React.createElement(Popover, {
                                open: true,
                                anchorRef,
                                boundaryRef,
                                placement: 'bottom',
                                portal: { native: true },
                                backdrop: false,
                                children: () => React.createElement(PopoverChild),
                            } as any),
                        } as any,
                    ),
                    React.createElement(OverlayPortalHost),
                ))).tree;

        await act(async () => {
            await flushInitialPositioning();
        });

        const container = tree ? findPopoverContentView(tree) : null;
        const style = flattenTestStyle(container?.props?.style);

        const paddingLeft = readNumericStyle(style, 'paddingLeft');
        const paddingTop = readNumericStyle(style, 'paddingTop');

        // placement=bottom => visual top = y + height + gap (default gap=8)
        expect(readNumericStyle(style, 'top') + paddingTop).toBe(148);
        expect(readNumericStyle(style, 'left') + paddingLeft).toBe(10);
    });

    it('retries measurement when the initial anchor rect is zero-sized (prevents iOS dropdowns from overlapping the trigger)', async () => {
        const { OverlayPortalHost, OverlayPortalProvider } = await import('./OverlayPortal');
        const { Popover } = await import('./Popover');

        let measureCalls = 0;
        const anchorRef = {
            current: {
                measureInWindow: (cb: any) => {
                    measureCalls += 1;
                    if (measureCalls === 1) {
                        cb(200, 200, 0, 0);
                        return;
                    }
                    cb(200, 200, 20, 20);
                },
            },
        } as any;

        let tree: ReturnType<typeof renderer.create> | undefined;
        tree = (await renderScreen(React.createElement(
                    OverlayPortalProvider,
                    null,
                    React.createElement(Popover, {
                        open: true,
                        anchorRef,
                        placement: 'bottom',
                        portal: { native: true },
                        backdrop: false,
                        children: () => React.createElement(PopoverChild),
                    }),
                    React.createElement(OverlayPortalHost),
                ))).tree;

        await act(async () => {
            await flushInitialPositioning();
        });

        expect(measureCalls).toBeGreaterThanOrEqual(2);

        const contentView = tree ? findPopoverContentView(tree) : null;
        expect(nativeUnplacedState(contentView)).toEqual({ hidden: false, faded: false });
    });

    it('renders inline when no OverlayPortalProvider is present', async () => {
        const { Popover } = await import('./Popover');

        const anchorRef = {
            current: {
                measureInWindow: (cb: any) => cb(100, 100, 20, 20),
            },
        } as any;

        let tree: ReturnType<typeof renderer.create> | undefined;
        tree = (await renderScreen(React.createElement(
                    'View',
                    { testID: 'inline-slot' },
                        React.createElement(Popover, {
                            open: true,
                            anchorRef,
                            portal: { native: true },
                            backdrop: false,
                            children: () => React.createElement(PopoverChild),
                        }),
                ))).tree;

        expect(findFirstHostNodeByTestId(tree, 'inline-slot')?.findAllByType('PopoverChild' as any).length).toBe(1);
    });

    it('renders into OverlayPortalHost when usePortalOnNative is enabled', async () => {
        vi.useFakeTimers();

        const { OverlayPortalHost, OverlayPortalProvider } = await import('./OverlayPortal');
        const { Popover } = await import('./Popover');

        const anchorRef = {
            current: {
                measureInWindow: (cb: any) => cb(200, 200, 20, 20),
            },
        } as any;

        let tree: ReturnType<typeof renderer.create> | undefined;
        tree = (await renderScreen(React.createElement(
                    OverlayPortalProvider,
                    null,
                    React.createElement(
                        'View',
                        { testID: 'inline-slot' },
                        React.createElement(Popover, {
                            open: true,
                            anchorRef,
                            portal: { native: true },
                            backdrop: false,
                            children: () => React.createElement(PopoverChild),
                        }),
                    ),
                    React.createElement(
                        'View',
                        { testID: 'host-slot' },
                        React.createElement(OverlayPortalHost),
                    ),
                ))).tree;

        expect(findFirstHostNodeByTestId(tree, 'inline-slot')?.findAllByType('PopoverChild' as any).length).toBe(0);
        expect(findFirstHostNodeByTestId(tree, 'host-slot')?.findAllByType('PopoverChild' as any).length).toBe(1);

        await act(async () => {
            tree?.update(
                React.createElement(
                    OverlayPortalProvider,
                    null,
                    React.createElement(
                        'View',
                        { testID: 'inline-slot' },
                        React.createElement(Popover, {
                            open: false,
                            anchorRef,
                            portal: { native: true },
                            backdrop: false,
                            children: () => React.createElement(PopoverChild),
                        }),
                    ),
                    React.createElement(
                        'View',
                        { testID: 'host-slot' },
                        React.createElement(OverlayPortalHost),
                    ),
                ),
            );
        });

        await act(async () => {
            vi.advanceTimersByTime(motionTokens.overlay.popover.exitMs);
        });
        expect(findFirstHostNodeByTestId(tree, 'host-slot')?.findAllByType('PopoverChild' as any).length).toBe(0);
    });

    it('carries a live-picture backdrop into the portal host, so a menu opened over an HTML frame keeps the readable coat on native too', async () => {
        vi.useFakeTimers();

        const { OverlayPortalHost, OverlayPortalProvider } = await import('./OverlayPortal');
        const { Popover } = await import('./Popover');
        const { GlassLivePictureBackdropContext } = await import('@/components/ui/glass/livePictureBackdrop');

        const anchorRef = { current: { measureInWindow: (cb: any) => cb(200, 200, 20, 20) } } as any;
        // Stands where the menu's floating surface reads the declaration (GlassSurface).
        const Probe = () => React.createElement('Probe', { overPicture: React.useContext(GlassLivePictureBackdropContext) });
        const tree = (await renderScreen(React.createElement(
            OverlayPortalProvider,
            null,
            React.createElement(
                GlassLivePictureBackdropContext.Provider,
                { value: true },
                React.createElement(Popover, {
                    open: true,
                    anchorRef,
                    portal: { native: true },
                    backdrop: false,
                    children: () => React.createElement(Probe),
                }),
            ),
            React.createElement('View', { testID: 'host-slot' }, React.createElement(OverlayPortalHost)),
        ))).tree;

        const probes = findFirstHostNodeByTestId(tree, 'host-slot')?.findAllByType('Probe' as any) ?? [];
        expect(probes).toHaveLength(1);
        expect(probes[0]!.props.overPicture).toBe(true);
    });

    it('keeps portal content hidden until it can be positioned (prevents visible jiggle)', async () => {
        const { OverlayPortalHost, OverlayPortalProvider } = await import('./OverlayPortal');
        const { Popover } = await import('./Popover');

        const anchorRef = {
            current: {
                measureInWindow: (cb: any) => {
                    queueMicrotask(() => cb(200, 200, 20, 20));
                },
            },
        } as any;

        let tree: ReturnType<typeof renderer.create> | undefined;
        tree = (await renderScreen(React.createElement(
                    OverlayPortalProvider,
                    null,
                    React.createElement(Popover, {
                        open: true,
                        anchorRef,
                        placement: 'left',
                        portal: { native: true, anchorAlignVertical: 'center' },
                        backdrop: false,
                        children: () => React.createElement(PopoverChild),
                    }),
                    React.createElement(OverlayPortalHost),
                ))).tree;

        const contentView = tree ? findPopoverContentView(tree) : null;
        expect(nativeUnplacedState(contentView)).toEqual({ hidden: true, faded: false });

        await act(async () => {
            await flushInitialPositioning();
        });

        const contentViewAfterMeasure = tree ? findPopoverContentView(tree) : null;
        expect(nativeUnplacedState(contentViewAfterMeasure)).toEqual({ hidden: true, faded: false });

        await act(async () => {
            contentViewAfterMeasure?.props?.onLayout?.({ nativeEvent: { layout: { width: 180, height: 0 } } });
        });

        const contentViewAfterFirstLayout = tree ? findPopoverContentView(tree) : null;
        expect(nativeUnplacedState(contentViewAfterFirstLayout)).toEqual({ hidden: true, faded: false });

        await act(async () => {
            contentViewAfterFirstLayout?.props?.onLayout?.({ nativeEvent: { layout: { width: 180, height: 120 } } });
        });

        const contentViewAfterLayout = tree ? findPopoverContentView(tree) : null;
        expect(nativeUnplacedState(contentViewAfterLayout)).toEqual({ hidden: false, faded: false });
    });

    it('can spotlight the anchor so it stays crisp above the blur', async () => {
        const { OverlayPortalHost, OverlayPortalProvider } = await import('./OverlayPortal');
        const { Popover } = await import('./Popover');

        const anchorRef = {
            current: {
                measureInWindow: (cb: any) => {
                    queueMicrotask(() => cb(100, 100, 20, 20));
                },
            },
        } as any;

        let tree: ReturnType<typeof renderer.create> | undefined;
        tree = (await renderScreen(React.createElement(
                    OverlayPortalProvider,
                    null,
                    React.createElement(Popover, {
                        open: true,
                        anchorRef,
                        placement: 'bottom',
                        portal: { native: true },
                        onRequestClose: () => {},
                        backdrop: { effect: 'blur', spotlight: true },
                        children: () => React.createElement(PopoverChild),
                    } as any),
                    React.createElement(OverlayPortalHost),
                ))).tree;

        await act(async () => {
            await flushInitialPositioning();
        });

        const hostEffects = tree ? findHostNodesByTestId(tree, 'popover-backdrop-effect') : [];
        expect(hostEffects.length).toBe(4);
    });

    it('spotlights a rect anchor the same way it spotlights a view anchor', async () => {
        const { OverlayPortalHost, OverlayPortalProvider } = await import('./OverlayPortal');
        const { Popover } = await import('./Popover');

        let tree: ReturnType<typeof renderer.create> | undefined;
        tree = (await renderScreen(React.createElement(
                    OverlayPortalProvider,
                    null,
                    React.createElement(Popover, {
                        open: true,
                        anchor: { kind: 'rect', rect: { left: 100, top: 100, width: 20, height: 20 } },
                        placement: 'bottom',
                        portal: { native: true },
                        onRequestClose: () => {},
                        backdrop: { effect: 'blur', spotlight: true },
                        children: () => React.createElement(PopoverChild),
                    } as any),
                    React.createElement(OverlayPortalHost),
                ))).tree;

        await act(async () => {
            await flushInitialPositioning();
        });

        const hostEffects = tree ? findHostNodesByTestId(tree, 'popover-backdrop-effect') : [];
        expect(hostEffects.length).toBe(4);
    });

    it('can render an anchor overlay above the blur backdrop (keeps the trigger crisp without cutout seams)', async () => {
        const { OverlayPortalHost, OverlayPortalProvider } = await import('./OverlayPortal');
        const { Popover } = await import('./Popover');

        const anchorRef = {
            current: {
                measureInWindow: (cb: any) => {
                    queueMicrotask(() => cb(140, 120, 28, 28));
                },
            },
        } as any;

        let tree: ReturnType<typeof renderer.create> | undefined;
        tree = (await renderScreen(React.createElement(
                    OverlayPortalProvider,
                    null,
                    React.createElement(Popover, {
                        open: true,
                        anchorRef,
                        placement: 'bottom',
                        portal: { native: true },
                        onRequestClose: () => {},
                        backdrop: { effect: 'blur', anchorOverlay: () => React.createElement('AnchorOverlay') },
                        children: () => React.createElement(PopoverChild),
                    } as any),
                    React.createElement(OverlayPortalHost),
                ))).tree;

        await act(async () => {
            await flushInitialPositioning();
        });

        const hostOverlays = tree ? findHostNodesByTestId(tree, 'popover-anchor-overlay') : [];
        expect(hostOverlays.length).toBe(1);

        const overlayStyle = flattenTestStyle(hostOverlays[0]?.props?.style);
        expect(overlayStyle.position).toBe('absolute');
        expect(overlayStyle.left).toBe(140);
        expect(overlayStyle.top).toBe(120);
        expect(overlayStyle.width).toBe(28);
        expect(overlayStyle.height).toBe(28);
    });

    it('renders the anchor overlay at a rect anchor\'s rect', async () => {
        const { OverlayPortalHost, OverlayPortalProvider } = await import('./OverlayPortal');
        const { Popover } = await import('./Popover');

        let tree: ReturnType<typeof renderer.create> | undefined;
        tree = (await renderScreen(React.createElement(
                    OverlayPortalProvider,
                    null,
                    React.createElement(Popover, {
                        open: true,
                        anchor: { kind: 'rect', rect: { left: 140, top: 120, width: 28, height: 28 } },
                        placement: 'bottom',
                        portal: { native: true },
                        onRequestClose: () => {},
                        backdrop: { effect: 'blur', anchorOverlay: () => React.createElement('AnchorOverlay') },
                        children: () => React.createElement(PopoverChild),
                    } as any),
                    React.createElement(OverlayPortalHost),
                ))).tree;

        await act(async () => {
            await flushInitialPositioning();
        });

        const hostOverlays = tree ? findHostNodesByTestId(tree, 'popover-anchor-overlay') : [];
        expect(hostOverlays.length).toBe(1);

        const overlayStyle = flattenTestStyle(hostOverlays[0]?.props?.style);
        expect(overlayStyle.position).toBe('absolute');
        expect(overlayStyle.left).toBe(140);
        expect(overlayStyle.top).toBe(120);
        expect(overlayStyle.width).toBe(28);
        expect(overlayStyle.height).toBe(28);
    });

    it('does not let the retired device-local switch override Account material', async () => {
        localSettingState.uiBackdropBlurEnabled = false;
        const { OverlayPortalHost, OverlayPortalProvider } = await import('./OverlayPortal');
        const { Popover } = await import('./Popover');

        const anchorRef = {
            current: {
                measureInWindow: (cb: any) => {
                    queueMicrotask(() => cb(100, 100, 20, 20));
                },
            },
        } as any;

        let tree: ReturnType<typeof renderer.create> | undefined;
        tree = (await renderScreen(React.createElement(
                    OverlayPortalProvider,
                    null,
                    React.createElement(Popover, {
                        open: true,
                        anchorRef,
                        placement: 'bottom',
                        portal: { native: true },
                        onRequestClose: () => {},
                        backdrop: { effect: 'blur' },
                        children: () => React.createElement(PopoverChild),
                    } as any),
                    React.createElement(OverlayPortalHost),
                ))).tree;

        await act(async () => {
            await flushInitialPositioning();
        });

        // SDK availability may turn blur into a tint; the requested material
        // must still reach the real backdrop owner without the old local gate.
        const { PopoverBackdrop } = await import('./backdrop');
        expect(tree?.root.findByType(PopoverBackdrop).props.backdropEffect).toBe('blur');
    });

});
