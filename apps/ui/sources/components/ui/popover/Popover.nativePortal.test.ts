import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { installPopoverCommonModuleMocks } from './popoverTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const INITIAL_POSITIONING_TICKS = 3;

async function flushInitialPositioning() {
    await flushHookEffects({ cycles: 1, turns: INITIAL_POSITIONING_TICKS });
}

vi.mock('@/components/ui/popover', () => ({
    usePopoverBoundaryRef: () => null,
}));

vi.mock('expo-blur', () => {
    const React = require('react');
    return {
        BlurView: (props: any) => React.createElement('BlurView', props, props.children),
    };
});

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

function PopoverChild() {
    return React.createElement('PopoverChild');
}

describe('Popover (native portal)', () => {
    let restorePopoverWebGlobals: (() => void) | null = null;

    beforeEach(() => {
        restorePopoverWebGlobals = withPopoverWebGlobals();
    });

    afterEach(() => {
        restorePopoverWebGlobals?.();
        restorePopoverWebGlobals = null;
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

        // placement=bottom => top = y + height + gap (default gap=8)
        expect(style.left).toBe(10);
        expect(style.top).toBe(68);
        expect(style.width).toBe(30);
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

        // Portal-root-relative anchor rect = window(anchor) - window(portalRoot):
        // x = 70-50=20, y = 150-100=50.
        // placement=bottom => top = y + height + gap (default gap=8)
        expect(style.left).toBe(20);
        expect(style.top).toBe(98);
        expect(style.width).toBe(30);
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

        // Portal-relative anchor rect = window(anchor) - window(boundary):
        // x = 70-50=20, y = 150-100=50.
        // placement=bottom => top = y + height + gap (default gap=8)
        expect(style.left).toBe(20);
        expect(style.top).toBe(98);
        expect(style.width).toBe(30);
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

        // placement=bottom => top = y + height + gap (default gap=8)
        expect(style.top).toBe(148);
        expect(style.left).toBe(10);
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
        expect(flattenTestStyle(contentView?.props?.style).opacity).toBe(1);
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

        expect(findFirstHostNodeByTestId(tree, 'host-slot')?.findAllByType('PopoverChild' as any).length).toBe(0);
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
        expect(flattenTestStyle(contentView?.props?.style).opacity).toBe(0);

        await act(async () => {
            await flushInitialPositioning();
        });

        const contentViewAfterMeasure = tree ? findPopoverContentView(tree) : null;
        expect(flattenTestStyle(contentViewAfterMeasure?.props?.style).opacity).toBe(0);

        await act(async () => {
            contentViewAfterMeasure?.props?.onLayout?.({ nativeEvent: { layout: { width: 180, height: 0 } } });
        });

        const contentViewAfterFirstLayout = tree ? findPopoverContentView(tree) : null;
        expect(flattenTestStyle(contentViewAfterFirstLayout?.props?.style).opacity).toBe(0);

        await act(async () => {
            contentViewAfterFirstLayout?.props?.onLayout?.({ nativeEvent: { layout: { width: 180, height: 120 } } });
        });

        const contentViewAfterLayout = tree ? findPopoverContentView(tree) : null;
        expect(flattenTestStyle(contentViewAfterLayout?.props?.style).opacity).toBe(1);
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

});
