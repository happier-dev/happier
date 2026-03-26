import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import {
    findFirstHostNodeByTestId,
    findHostNodesByTestId,
    findPopoverContentView,
    flattenTestStyle as flattenStyle,
    withPopoverWebGlobals,
} from '@/dev/testkit/harness/popoverHarness';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderScreen } from '@/dev/testkit';
import { installPopoverCommonModuleMocks } from './popoverTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const INITIAL_POSITIONING_TICKS = 3;
const RETRY_POSITIONING_TICKS = 6;
const POST_LAYOUT_TICKS = 2;

let mockPopoverContentDomRect: { width: number; height: number } | null = null;
let mockPopoverContentRefKind: 'dom' | 'opaque' = 'dom';

async function flushInitialPositioning() {
    await flushHookEffects({ cycles: 1, turns: INITIAL_POSITIONING_TICKS });
}

async function flushRetryPositioning() {
    await flushHookEffects({ cycles: 1, turns: RETRY_POSITIONING_TICKS });
}

async function flushPostLayoutTicks() {
    await flushHookEffects({ cycles: 1, turns: POST_LAYOUT_TICKS });
}

vi.mock('@/utils/web/radixCjs', () => {
    const React = require('react');
    return {
        requireRadixDismissableLayer: () => ({
            Branch: (props: any) => React.createElement('DismissableLayerBranch', props, props.children),
        }),
    };
});

vi.mock('@/utils/web/reactDomCjs', () => ({
    requireReactDOM: () => ({
        createPortal: (node: any, target: any) => {
            const React = require('react');
            return React.createElement('Portal', { target }, node);
        },
    }),
}));

installPopoverCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            useWindowDimensions: () => ({ width: 1000, height: 800 }),
            StyleSheet: {
                absoluteFill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
            },
            View: React.forwardRef((props: any, ref) => {
                React.useImperativeHandle(ref, () => {
                    if (mockPopoverContentRefKind !== 'dom') {
                        return {};
                    }
                    return {
                        contains: () => false,
                        getBoundingClientRect: () => ({
                            left: 0,
                            top: 0,
                            x: 0,
                            y: 0,
                            width: mockPopoverContentDomRect?.width ?? 0,
                            height: mockPopoverContentDomRect?.height ?? 0,
                        }),
                    };
                });
                return React.createElement('View', props, props.children);
            }),
            Pressable: (props: any) => React.createElement('Pressable', props, props.children),
        });
    },
});

describe('Popover (web)', () => {
    let restorePopoverWebGlobals: (() => void) | null = null;

    beforeEach(() => {
        restorePopoverWebGlobals = withPopoverWebGlobals();
    });

    afterEach(() => {
        restorePopoverWebGlobals?.();
        restorePopoverWebGlobals = null;
        mockPopoverContentDomRect = null;
        mockPopoverContentRefKind = 'dom';
        vi.unstubAllGlobals();
    });

    it('keeps the content above the backdrop when not using a portal', async () => {
        const { Popover } = await import('./Popover');

        const anchorRef = { current: null } as any;

        const screen = await renderScreen(React.createElement(
                    Popover,
                    {
                        open: true,
                        anchorRef,
                        backdrop: { enabled: true, blockOutsidePointerEvents: true },
                        onRequestClose: () => {},
                        children: () => React.createElement('PopoverChild'),
                    },
                ));

        const backdrop = screen.find((node) => (
            String(node.type) === 'Pressable'
            && flattenStyle(node.props.style).top === 0
        ));
        expect(backdrop).toBeTruthy();
        expect(flattenStyle(backdrop?.props.style).position).toBe('fixed');

        const content = findPopoverContentView(screen);
        expect(content).toBeTruthy();

        const backdropZ = flattenStyle(backdrop?.props.style).zIndex;
        const contentZ = flattenStyle(content?.props.style).zIndex;
        expect(typeof backdropZ).toBe('number');
        expect(typeof contentZ).toBe('number');
        if (typeof backdropZ !== 'number' || typeof contentZ !== 'number') {
            throw new Error('Expected numeric z-index values for backdrop and content');
        }
        expect(contentZ).toBeGreaterThan(backdropZ);
    });

    it('wraps portal-to-body popovers in a Radix DismissableLayer Branch so underlying Vaul/Radix layers don’t treat it as “outside”', async () => {
        const { Popover } = await import('./Popover');

        const anchorRef = { current: null } as any;

        const screen = await renderScreen(React.createElement(
                    Popover,
                    {
                        open: true,
                        anchorRef,
                        portal: { web: true },
                        onRequestClose: () => {},
                        children: () => React.createElement('PopoverChild'),
                    },
                ));

        expect(screen.findAllByType('DismissableLayerBranch' as any).length).toBe(1);
    });

    it('does not fall back to document.body when a boundary portal target is requested but not ready yet', async () => {
        const { Popover } = await import('./Popover');

        const anchorRef = { current: null } as any;
        const boundaryRef = { current: null } as any;

        const screen = await renderScreen(React.createElement(
                    Popover,
                    {
                        open: true,
                        anchorRef,
                        boundaryRef,
                        portal: { web: { target: 'boundary' } },
                        onRequestClose: () => {},
                        children: () => React.createElement('PopoverChild'),
                    },
                ));

        expect(screen.findAllByType('Portal' as any)).toHaveLength(0);
        expect(screen.findAllByType('PopoverChild' as any)).toHaveLength(1);
    });

    it('can portal to a boundary ref that exposes getNode() (react-native-web refs)', async () => {
        const { Popover } = await import('./Popover');

        const anchorRef = { current: null } as any;
        const boundaryDomEl = {
            addEventListener: () => {},
            appendChild: () => {},
            getBoundingClientRect: () => ({ left: 0, top: 0, x: 0, y: 0, width: 800, height: 600 }),
        };
        const boundaryRef = {
            current: {
                getNode: () => boundaryDomEl,
            },
        } as any;

        const screen = await renderScreen(React.createElement(
            Popover,
            {
                open: true,
                anchorRef,
                boundaryRef,
                portal: { web: { target: 'boundary' } },
                onRequestClose: () => {},
                children: () => React.createElement('PopoverChild'),
            },
        ));

        const portals = screen.findAllByType('Portal' as any);
        expect(portals).toHaveLength(1);
        expect(portals[0]?.props?.target).toBe(boundaryDomEl);
    });

    it('can close when clicking the anchor when closeOnAnchorPress is enabled', async () => {
        const { Popover } = await import('./Popover');

        const pointerHandlers: any[] = [];
        const keyHandlers: Array<{ handler: any; options: any }> = [];
        const addEventListener = vi.fn((type: string, handler: any, options?: any) => {
            if (type === 'pointerdown') pointerHandlers.push(handler);
            if (type === 'keydown') keyHandlers.push({ handler, options });
        });
        const removeEventListener = vi.fn();

        vi.stubGlobal('document', {
            addEventListener,
            removeEventListener,
        });

        const onRequestClose = vi.fn();

        const anchorTarget = {} as any;
        const anchorRef = {
            current: {
                contains: (node: any) => node === anchorTarget,
                getBoundingClientRect: () => ({ left: 0, top: 0, width: 10, height: 10 }),
            },
        } as any;

        await renderScreen(React.createElement(Popover, {
                    open: true,
                    anchorRef,
                    closeOnAnchorPress: true,
                    onRequestClose,
                    backdrop: false,
                    children: () => React.createElement('PopoverChild'),
                }));

        await act(async () => {});

        expect(pointerHandlers.length).toBeGreaterThan(0);
        pointerHandlers.at(-1)?.({ target: anchorTarget });
        expect(onRequestClose).toHaveBeenCalledTimes(1);
    });

    it('stops event propagation when closing on Escape so underlying modal layers do not also dismiss', async () => {
        const { Popover } = await import('./Popover');

        const keyHandlers: Array<{ handler: any; options: any }> = [];
        const addEventListener = vi.fn((type: string, handler: any, options?: any) => {
            if (type === 'keydown') keyHandlers.push({ handler, options });
        });
        const removeEventListener = vi.fn();

        vi.stubGlobal('document', {
            addEventListener,
            removeEventListener,
        });

        const onRequestClose = vi.fn();
        const anchorRef = {
            current: {
                contains: () => false,
                getBoundingClientRect: () => ({ left: 0, top: 0, width: 10, height: 10 }),
            },
        } as any;

        await renderScreen(React.createElement(Popover, {
            open: true,
            anchorRef,
            onRequestClose,
            backdrop: false,
            children: () => React.createElement('PopoverChild'),
        }));

        await act(async () => {});

        expect(keyHandlers.length).toBeGreaterThan(0);

        const stopPropagation = vi.fn();
        const stopImmediatePropagation = vi.fn();
        const preventDefault = vi.fn();
        keyHandlers.at(-1)?.handler({
            key: 'Escape',
            stopPropagation,
            stopImmediatePropagation,
            preventDefault,
        });

        expect(stopPropagation).toHaveBeenCalledTimes(1);
        expect(stopImmediatePropagation).toHaveBeenCalledTimes(1);
        expect(preventDefault).toHaveBeenCalledTimes(1);
        expect(onRequestClose).toHaveBeenCalledTimes(1);
        expect(keyHandlers.at(-1)?.options).toBe(true);
    });

    it('stops event propagation when closing on outside clicks so underlying modal layers do not also dismiss', async () => {
        const { Popover } = await import('./Popover');

        const pointerHandlers: Array<{ handler: any; options: any }> = [];
        const addEventListener = vi.fn((type: string, handler: any, options?: any) => {
            if (type === 'pointerdown') pointerHandlers.push({ handler, options });
        });
        const removeEventListener = vi.fn();

        vi.stubGlobal('document', {
            addEventListener,
            removeEventListener,
        });

        const onRequestClose = vi.fn();
        const anchorRef = {
            current: {
                contains: () => false,
                getBoundingClientRect: () => ({ left: 0, top: 0, width: 10, height: 10 }),
            },
        } as any;

        await renderScreen(React.createElement(Popover, {
            open: true,
            anchorRef,
            onRequestClose,
            backdrop: false,
            children: () => React.createElement('PopoverChild'),
        }));

        await act(async () => {});

        expect(pointerHandlers.length).toBeGreaterThan(0);

        const stopPropagation = vi.fn();
        const stopImmediatePropagation = vi.fn();
        pointerHandlers.at(-1)?.handler({
            target: {} as any,
            stopPropagation,
            stopImmediatePropagation,
        });

        expect(stopPropagation).toHaveBeenCalledTimes(1);
        expect(stopImmediatePropagation).toHaveBeenCalledTimes(1);
        expect(onRequestClose).toHaveBeenCalledTimes(1);
        expect(pointerHandlers.at(-1)?.options).toBe(true);
    });

    it('portals to a modal portal host when available (prevents Radix Dialog scroll-lock from swallowing wheel/touch scroll)', async () => {
        const { Popover } = await import('./Popover');
        const { ModalPortalTargetProvider } = await import('@/modal/portal/ModalPortalTarget');

        const anchorRef = { current: null } as any;
        const modalTarget = {} as any;

        const screen = await renderScreen(React.createElement(
                    ModalPortalTargetProvider,
                    {
                        target: modalTarget,
                        children: React.createElement(Popover, {
                            open: true,
                            anchorRef,
                            portal: { web: true },
                            onRequestClose: () => {},
                            children: () => React.createElement('PopoverChild'),
                        }),
                    },
                ));

        const portal = screen.findAllByType('Portal' as any)?.[0];
        expect(portal).toBeTruthy();
        expect((portal as any)?.props?.target).toBe(modalTarget);
    });

    it('does not subscribe to scroll events when portaling into a modal/boundary target (avoids scroll jank on mobile web)', async () => {
        const { Popover } = await import('./Popover');
        const { ModalPortalTargetProvider } = await import('@/modal/portal/ModalPortalTarget');

        const anchorRef = { current: null } as any;
        const modalTarget = {} as any;

        await renderScreen(React.createElement(
                    ModalPortalTargetProvider,
                    {
                        target: modalTarget,
                        children: React.createElement(Popover, {
                            open: true,
                            anchorRef,
                            portal: { web: true },
                            onRequestClose: () => {},
                            children: () => React.createElement('PopoverChild'),
                        }),
                    },
                ));

        const add = (globalThis as any).window?.addEventListener as any;
        const calls = add?.mock?.calls ?? [];
        const events = calls.map((c: any[]) => c?.[0]).filter(Boolean);
        expect(events).toContain('resize');
        expect(events).not.toContain('scroll');
    });

    it('portals to the PopoverBoundary when in an Expo Router modal (prevents Vaul/Radix scroll-lock from swallowing wheel/touch scroll)', async () => {
        const boundaryTarget = {
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            appendChild: vi.fn(),
        } as any;
        const boundaryRef = { current: boundaryTarget } as any;
        const { Popover } = await import('./Popover');
        const { PopoverBoundaryProvider } = await import('@/components/ui/popover');

        const anchorRef = { current: null } as any;
        const screen = await renderScreen(React.createElement(
                    PopoverBoundaryProvider,
                    {
                        boundaryRef,
                        children: React.createElement(Popover, {
                            open: true,
                            anchorRef,
                            portal: { web: true },
                            onRequestClose: () => {},
                            children: () => React.createElement('PopoverChild'),
                        }),
                    },
                ));

        const portal = screen.findAllByType('Portal' as any)?.[0];
        expect(portal).toBeTruthy();
        expect((portal as any)?.props?.target).toBe(boundaryTarget);
    });

    it('accounts for portal-target scroll offset when positioning inside a scrollable boundary (prevents dropdowns from drifting upward)', async () => {
        const { Popover } = await import('./Popover');
        const { PopoverBoundaryProvider } = await import('@/components/ui/popover');

        const boundaryTarget = {
            scrollTop: 400,
            scrollLeft: 0,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            appendChild: vi.fn(),
            getBoundingClientRect: () => ({
                left: 0,
                top: 50,
                width: 1000,
                height: 800,
                x: 0,
                y: 50,
            }),
        } as any;

        const boundaryRef = { current: boundaryTarget } as any;
        const anchorRef = {
            current: {
                getBoundingClientRect: () => ({
                    left: 0,
                    top: 600,
                    width: 300,
                    height: 40,
                    x: 0,
                    y: 600,
                }),
            },
        } as any;

        const screen = await renderScreen(React.createElement(
            PopoverBoundaryProvider,
            {
                boundaryRef,
                children: React.createElement(Popover, {
                    open: true,
                    anchorRef,
                    boundaryRef,
                    portal: { web: { target: 'boundary' } },
                    placement: 'bottom',
                    gap: 0,
                    maxHeightCap: 320,
                    onRequestClose: () => {},
                    children: () => React.createElement('PopoverChild'),
                }),
            },
        ));

        await act(async () => {
            await flushRetryPositioning();
        });

        const content = findPopoverContentView(screen);
        expect(content).toBeTruthy();

        const style = flattenStyle(content?.props?.style);
        // Desired viewport top is anchorBottom (= 600 + 40) = 640.
        // Portal target top is 50; when positioned absolute inside a scrollable element, the style.top
        // must include scrollTop to avoid being offset by scrolling (640 - 50 + 400 = 990).
        expect(style.top).toBe(990);
    });

    it('stops wheel propagation in portal mode (prevents document-level scroll-lock listeners from breaking popover scrolling)', async () => {
        const { Popover } = await import('./Popover');

        const anchorRef = { current: null } as any;

        const screen = await renderScreen(React.createElement(Popover, {
                    open: true,
                    anchorRef,
                    portal: { web: true },
                    onRequestClose: () => {},
                    children: () => React.createElement('PopoverChild'),
                }));

        const content = findPopoverContentView(screen);
        expect(content).toBeTruthy();

        const stopPropagation = vi.fn();
        act(() => {
            content?.props?.onWheel?.({ stopPropagation });
        });
        expect(stopPropagation).toHaveBeenCalledTimes(1);
    });

    it('treats boundaryRef={null} as an explicit override (uses viewport fallback even when a PopoverBoundaryProvider is present)', async () => {
        const { Popover } = await import('./Popover');
        const { PopoverBoundaryProvider } = await import('@/components/ui/popover');

        const anchorRef = {
            current: {
                getBoundingClientRect: () => ({
                    left: 0,
                    top: 650,
                    width: 100,
                    height: 40,
                    x: 0,
                    y: 650,
                }),
            },
        } as any;

        const boundaryRef = {
            current: {
                getBoundingClientRect: () => ({
                    left: 0,
                    top: 500,
                    width: 1000,
                    height: 200,
                    x: 0,
                    y: 500,
                }),
            },
        } as any;

        const renders: Array<{ maxHeight: number }> = [];

        const screen = await renderScreen(React.createElement(
            PopoverBoundaryProvider,
            {
                boundaryRef,
                children: React.createElement(Popover, {
                    open: true,
                    anchorRef,
                    boundaryRef: null,
                    portal: { web: true },
                    placement: 'top',
                    maxHeightCap: 400,
                    onRequestClose: () => {},
                    children: (renderProps: any) => {
                        renders.push({ maxHeight: renderProps.maxHeight });
                        return React.createElement('PopoverChild');
                    },
                }),
            },
        ));

        await act(async () => {
            await flushRetryPositioning();
        });

        expect(screen).toBeTruthy();
        // With boundaryRef=null, it should ignore the boundary provider and use viewport fallback.
        // Available top is 650 - 0 - 8 = 642, capped by maxHeightCap=400.
        expect(renders.at(-1)?.maxHeight).toBe(400);
    });

    it('positions top-placed portal popovers using bottom anchoring (prevents jiggle when content height changes)', async () => {
        const { Popover } = await import('./Popover');

        const anchorRef = {
            current: {
                getBoundingClientRect: () => ({
                    left: 0,
                    top: 600,
                    width: 300,
                    height: 40,
                    x: 0,
                    y: 600,
                }),
            },
        } as any;

        const screen = await renderScreen(React.createElement(Popover, {
            open: true,
            anchorRef,
            portal: { web: true },
            placement: 'top',
            gap: 8,
            maxHeightCap: 400,
            onRequestClose: () => {},
            children: () => React.createElement('PopoverChild'),
        }));

        await act(async () => {
            await flushRetryPositioning();
        });

        const contentView = findPopoverContentView(screen);
        expect(contentView).toBeTruthy();

        const layoutNode = screen.findAllByType('View' as any).find((v: any) => typeof v.props.onLayout === 'function');
        expect(layoutNode).toBeTruthy();

        // Simulate measuring the popover content.
        await act(async () => {
            layoutNode?.props?.onLayout?.({ nativeEvent: { layout: { width: 520, height: 200 } } });
            await flushPostLayoutTicks();
        });

        const updatedContent = findPopoverContentView(screen);
        expect(updatedContent).toBeTruthy();

        const style = flattenStyle(updatedContent?.props?.style);
        // bottom should pin the popover's bottom edge to (anchorTop - gap).
        // windowHeight=800 => bottom = 800 - (600 - 8) = 208
        expect(style.bottom).toBe(208);
        expect(style.top).toBeUndefined();
    });

    it('positions top-placed popovers inside scrollable portal targets using bottom anchoring (prevents async content jiggle)', async () => {
        const { Popover } = await import('./Popover');
        const { PopoverBoundaryProvider } = await import('@/components/ui/popover');

        const boundaryTarget = {
            scrollTop: 400,
            scrollLeft: 0,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            appendChild: vi.fn(),
            getBoundingClientRect: () => ({
                left: 0,
                top: 50,
                width: 1000,
                height: 800,
                x: 0,
                y: 50,
            }),
        } as any;

        const boundaryRef = { current: boundaryTarget } as any;
        const anchorRef = {
            current: {
                getBoundingClientRect: () => ({
                    left: 0,
                    top: 600,
                    width: 300,
                    height: 40,
                    x: 0,
                    y: 600,
                }),
            },
        } as any;

        const screen = await renderScreen(React.createElement(
            PopoverBoundaryProvider,
            {
                boundaryRef,
                children: React.createElement(Popover, {
                    open: true,
                    anchorRef,
                    boundaryRef,
                    portal: { web: { target: 'boundary' } },
                    placement: 'top',
                    gap: 8,
                    maxHeightCap: 400,
                    onRequestClose: () => {},
                    children: () => React.createElement('PopoverChild'),
                }),
            },
        ));

        await act(async () => {
            await flushRetryPositioning();
        });

        const contentView = findPopoverContentView(screen);
        expect(contentView).toBeTruthy();

        const layoutNode = screen.findAllByType('View' as any).find((v: any) => typeof v.props.onLayout === 'function');
        expect(layoutNode).toBeTruthy();

        await act(async () => {
            layoutNode?.props?.onLayout?.({ nativeEvent: { layout: { width: 520, height: 200 } } });
            await flushPostLayoutTicks();
        });

        const updatedContent = findPopoverContentView(screen);
        expect(updatedContent).toBeTruthy();

        const style = flattenStyle(updatedContent?.props?.style);
        // In boundary portal coordinate space: webPortalOffsetY = boundaryTop(50) - scrollTop(400) = -350.
        // anchorTopRelative = 600 - (-350) = 950. portalHeight=800.
        // bottom = 800 - (950 - gap(8)) = -142.
        expect(style.bottom).toBe(-142);
        expect(style.top).toBeUndefined();
    });

    it('does not attach wheel propagation stoppers when not using a portal', async () => {
        const { Popover } = await import('./Popover');

        const anchorRef = { current: null } as any;

        const screen = await renderScreen(React.createElement(Popover, {
                    open: true,
                    anchorRef,
                    backdrop: false,
                    children: () => React.createElement('PopoverChild'),
                }));

        const content = findPopoverContentView(screen);
        expect(content).toBeTruthy();
        expect(content?.props?.onWheel).toBeUndefined();
        expect(content?.props?.onTouchMove).toBeUndefined();
    });

    it('keeps portal popovers hidden until the anchor is measured (prevents visible jiggle)', async () => {
        const { Popover } = await import('./Popover');

        const anchorRef = {
            current: {
                measureInWindow: (cb: any) => {
                    queueMicrotask(() => cb(100, 100, 20, 20));
                },
            },
        } as any;

        const screen = await renderScreen(React.createElement(Popover, {
                    open: true,
                    anchorRef,
                    placement: 'bottom',
                    portal: { web: true },
                    backdrop: false,
                    children: () => React.createElement('PopoverChild'),
                }));

        const contentView = findPopoverContentView(screen);
        expect(flattenStyle(contentView?.props?.style).opacity).toBe(0);

        await act(async () => {
            await flushInitialPositioning();
        });

        const contentViewAfter = findPopoverContentView(screen);
        // Still hidden until content layout is known (prevents clamp jiggle for top/bottom portals).
        expect(flattenStyle(contentViewAfter?.props?.style).opacity).toBe(0);

        await act(async () => {
            contentViewAfter?.props?.onLayout?.({ nativeEvent: { layout: { width: 200, height: 120 } } });
        });

        const contentViewAfterLayout = findPopoverContentView(screen);
        expect(flattenStyle(contentViewAfterLayout?.props?.style).opacity).toBe(1);
    });

    it('measures DOM anchors on web when measureInWindow is unavailable (prevents invisible portal popovers)', async () => {
        const { Popover } = await import('./Popover');

        const anchorRef = {
            current: {
                getBoundingClientRect: () => ({ left: 120, top: 140, width: 48, height: 22 }),
            },
        } as any;

        const screen = await renderScreen(React.createElement(Popover, {
                    open: true,
                    anchorRef,
                    placement: 'bottom',
                    portal: { web: true },
                    backdrop: false,
                    children: () => React.createElement('PopoverChild'),
                }));

        const contentView = findPopoverContentView(screen);
        expect(flattenStyle(contentView?.props?.style).opacity).toBe(0);

        await act(async () => {
            await flushInitialPositioning();
        });

        const contentViewAfter = findPopoverContentView(screen);
        expect(flattenStyle(contentViewAfter?.props?.style).opacity).toBe(0);

        await act(async () => {
            contentViewAfter?.props?.onLayout?.({ nativeEvent: { layout: { width: 200, height: 120 } } });
        });

        const contentViewAfterLayout = findPopoverContentView(screen);
        expect(flattenStyle(contentViewAfterLayout?.props?.style).opacity).toBe(1);
    });

    it('falls back to DOM anchors on web when measureInWindow returns invalid values (prevents stuck invisible portal popovers)', async () => {
        const { Popover } = await import('./Popover');

        const anchorRef = {
            current: {
                measureInWindow: (cb: any) => {
                    queueMicrotask(() => cb(NaN, NaN, NaN, NaN));
                },
                getBoundingClientRect: () => ({ left: 120, top: 140, width: 48, height: 22 }),
            },
        } as any;

        const screen = await renderScreen(React.createElement(Popover, {
                    open: true,
                    anchorRef,
                    placement: 'bottom',
                    portal: { web: true },
                    backdrop: false,
                    children: () => React.createElement('PopoverChild'),
                }));

        const contentView = findPopoverContentView(screen);
        expect(flattenStyle(contentView?.props?.style).opacity).toBe(0);

        await act(async () => {
            await flushInitialPositioning();
        });

        const contentViewAfter = findPopoverContentView(screen);
        expect(flattenStyle(contentViewAfter?.props?.style).opacity).toBe(0);

        await act(async () => {
            contentViewAfter?.props?.onLayout?.({ nativeEvent: { layout: { width: 200, height: 120 } } });
        });

        const contentViewAfterLayout = findPopoverContentView(screen);
        expect(flattenStyle(contentViewAfterLayout?.props?.style).opacity).toBe(1);
    });

    it('unhides portal popovers on web when content DOM rect is available even if onLayout never fires (prevents stuck non-interactive menus)', async () => {
        const { Popover } = await import('./Popover');

        mockPopoverContentDomRect = { width: 200, height: 120 };
        mockPopoverContentRefKind = 'dom';

        const anchorRef = {
            current: {
                getBoundingClientRect: () => ({ left: 120, top: 140, width: 48, height: 22 }),
            },
        } as any;

        const screen = await renderScreen(React.createElement(Popover, {
            open: true,
            anchorRef,
            placement: 'bottom',
            portal: { web: true },
            backdrop: false,
            children: () => React.createElement('PopoverChild'),
        }));

        const contentView = findPopoverContentView(screen);
        const initialOpacity = flattenStyle(contentView?.props?.style).opacity;
        expect([0, 1]).toContain(initialOpacity);

        await act(async () => {
            await flushInitialPositioning();
        });

        const contentViewAfter = findPopoverContentView(screen);
        expect(flattenStyle(contentViewAfter?.props?.style).opacity).toBe(1);
    });

    it('does not treat inside clicks as outside when the content ref is opaque (falls back to web DOM lookup)', async () => {
        const { Popover } = await import('./Popover');

        mockPopoverContentRefKind = 'opaque';

        const fixedRandom = 0.12345;
        const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(fixedRandom);
        const expectedId = `popover-${fixedRandom.toString(36).slice(2)}`;

        const pointerHandlers: Array<{ handler: any; options: any }> = [];
        const addEventListener = vi.fn((type: string, handler: any, options?: any) => {
            if (type === 'pointerdown') pointerHandlers.push({ handler, options });
        });
        const removeEventListener = vi.fn();

        const insideTarget = {} as any;
        const contentDomEl = {
            contains: (node: any) => node === insideTarget,
        } as any;

        const getElementById = vi.fn((id: string) => (id === expectedId ? contentDomEl : null));

        vi.stubGlobal('document', {
            addEventListener,
            removeEventListener,
            getElementById,
        });

        const onRequestClose = vi.fn();
        const anchorRef = {
            current: {
                contains: () => false,
                getBoundingClientRect: () => ({ left: 0, top: 0, width: 10, height: 10 }),
            },
        } as any;

        const screen = await renderScreen(React.createElement(Popover, {
            open: true,
            anchorRef,
            portal: { web: true },
            onRequestClose,
            backdrop: false,
            children: () => React.createElement('PopoverChild'),
        }));
        expect(screen).toBeTruthy();

        await act(async () => {});
        expect(pointerHandlers.length).toBeGreaterThan(0);

        pointerHandlers.at(-1)?.handler({
            target: insideTarget,
            stopPropagation: vi.fn(),
            stopImmediatePropagation: vi.fn(),
        });

        expect(onRequestClose).toHaveBeenCalledTimes(0);

        randomSpy.mockRestore();
    });

    it('fails open when pointerdown capture cannot resolve anchor/content DOM elements (does not swallow clicks)', async () => {
        const { Popover } = await import('./Popover');

        mockPopoverContentRefKind = 'opaque';

        const pointerHandlers: Array<{ handler: any; options: any }> = [];
        const addEventListener = vi.fn((type: string, handler: any, options?: any) => {
            if (type === 'pointerdown') pointerHandlers.push({ handler, options });
        });
        const removeEventListener = vi.fn();

        vi.stubGlobal('document', {
            addEventListener,
            removeEventListener,
            getElementById: vi.fn(() => null),
            querySelector: vi.fn(() => null),
        });

        const onRequestClose = vi.fn();
        const anchorRef = {
            current: {
                getBoundingClientRect: () => ({ left: 0, top: 0, width: 10, height: 10 }),
            },
        } as any;

        await renderScreen(React.createElement(Popover, {
            open: true,
            anchorRef,
            portal: { web: true },
            onRequestClose,
            backdrop: false,
            children: () => React.createElement('PopoverChild'),
        }));

        await act(async () => {});
        expect(pointerHandlers.length).toBeGreaterThan(0);

        pointerHandlers.at(-1)?.handler({
            target: {} as any,
            stopPropagation: vi.fn(),
            stopImmediatePropagation: vi.fn(),
        });

        expect(onRequestClose).toHaveBeenCalledTimes(0);
    });

    it('retries measuring portal anchors on web when measureInWindow returns invalid values (prevents needing a resize)', async () => {
        const { Popover } = await import('./Popover');

        let calls = 0;
        const anchorRef = {
            current: {
                measureInWindow: (cb: any) => {
                    calls += 1;
                    queueMicrotask(() => {
                        if (calls === 1) return cb(NaN, NaN, NaN, NaN);
                        cb(100, 100, 20, 20);
                    });
                },
            },
        } as any;

        const screen = await renderScreen(React.createElement(Popover, {
            open: true,
            anchorRef,
            placement: 'bottom',
            portal: { web: true },
            backdrop: false,
            children: () => React.createElement('PopoverChild'),
        }));

        const contentView = findPopoverContentView(screen);
        expect(flattenStyle(contentView?.props?.style).opacity).toBe(0);

        await act(async () => {
            await flushRetryPositioning();
        });

        const contentViewAfter = findPopoverContentView(screen);
        expect(flattenStyle(contentViewAfter?.props?.style).opacity).toBe(0);

        await act(async () => {
            contentViewAfter?.props?.onLayout?.({ nativeEvent: { layout: { width: 200, height: 120 } } });
        });

        const contentViewAfterLayout = findPopoverContentView(screen);
        expect(flattenStyle(contentViewAfterLayout?.props?.style).opacity).toBe(1);
    });

    it('retries measuring portal anchors on web when the initial anchor rect is unrealistically tiny (prevents 0-width popovers)', async () => {
        const { Popover } = await import('./Popover');

        let calls = 0;
        const anchorRef = {
            current: {
                measureInWindow: (cb: any) => {
                    calls += 1;
                    queueMicrotask(() => {
                        if (calls === 1) return cb(100, 100, 1, 1);
                        cb(100, 100, 120, 24);
                    });
                },
            },
        } as any;

        const screen = await renderScreen(React.createElement(Popover, {
            open: true,
            anchorRef,
            placement: 'bottom',
            portal: { web: true },
            backdrop: false,
            children: () => React.createElement('PopoverChild'),
        }));

        await act(async () => {
            await flushRetryPositioning();
        });

        const contentView = findPopoverContentView(screen);
        expect(contentView).toBeTruthy();

        const width = flattenStyle(contentView?.props?.style).width;
        expect(width).toBe(120);
    });

    it('keeps retrying portal anchor measurement for multiple frames on web (prevents invisible popovers that only appear after a second click)', async () => {
        const { Popover } = await import('./Popover');

        let calls = 0;
        const anchorRef = {
            current: {
                measureInWindow: (cb: any) => {
                    calls += 1;
                    queueMicrotask(() => {
                        if (calls <= 3) return cb(100, 100, 1, 1);
                        cb(100, 100, 120, 24);
                    });
                },
            },
        } as any;

        const screen = await renderScreen(React.createElement(Popover, {
            open: true,
            anchorRef,
            placement: 'bottom',
            portal: { web: true },
            backdrop: false,
            children: () => React.createElement('PopoverChild'),
        }));

        await act(async () => {
            await flushRetryPositioning();
        });

        const contentView = findPopoverContentView(screen);
        expect(contentView).toBeTruthy();

        const width = flattenStyle(contentView?.props?.style).width;
        expect(width).toBe(120);
    });

    it('keeps left/right portal popovers hidden until content layout is known (prevents recenter jiggle)', async () => {
        const { Popover } = await import('./Popover');

        const anchorRef = {
            current: {
                measureInWindow: (cb: any) => {
                    queueMicrotask(() => cb(200, 200, 20, 20));
                },
            },
        } as any;

        const screen = await renderScreen(React.createElement(Popover, {
            open: true,
            anchorRef,
            placement: 'left',
            portal: {
                web: true,
                matchAnchorWidth: false,
                anchorAlignVertical: 'center',
            },
            backdrop: false,
            children: () => React.createElement('PopoverChild'),
        }));

        await act(async () => {
            await flushInitialPositioning();
        });

        const contentView = findPopoverContentView(screen);
        expect(flattenStyle(contentView?.props?.style).opacity).toBe(0);

        await act(async () => {
            contentView?.props?.onLayout?.({ nativeEvent: { layout: { width: 180, height: 0 } } });
        });

        const contentViewAfterFirstLayout = findPopoverContentView(screen);
        expect(flattenStyle(contentViewAfterFirstLayout?.props?.style).opacity).toBe(0);

        await act(async () => {
            contentViewAfterFirstLayout?.props?.onLayout?.({ nativeEvent: { layout: { width: 180, height: 120 } } });
        });

        const contentViewAfter = findPopoverContentView(screen);
        expect(flattenStyle(contentViewAfter?.props?.style).opacity).toBe(1);
    });

    it('keeps top/bottom portal popovers hidden until content layout is known (prevents clamp jiggle)', async () => {
        const { Popover } = await import('./Popover');

        const anchorRef = {
            current: {
                measureInWindow: (cb: any) => {
                    queueMicrotask(() => cb(200, 200, 140, 34));
                },
            },
        } as any;

        const screen = await renderScreen(React.createElement(Popover, {
            open: true,
            anchorRef,
            placement: 'bottom',
            portal: { web: true },
            backdrop: false,
            children: () => React.createElement('PopoverChild'),
        }));

        await act(async () => {
            await flushInitialPositioning();
        });

        const contentView = findPopoverContentView(screen);
        expect(flattenStyle(contentView?.props?.style).opacity).toBe(0);

        await act(async () => {
            contentView?.props?.onLayout?.({ nativeEvent: { layout: { width: 180, height: 0 } } });
        });

        const contentViewAfterFirstLayout = findPopoverContentView(screen);
        expect(flattenStyle(contentViewAfterFirstLayout?.props?.style).opacity).toBe(0);

        await act(async () => {
            contentViewAfterFirstLayout?.props?.onLayout?.({ nativeEvent: { layout: { width: 180, height: 140 } } });
        });

        const contentViewAfter = findPopoverContentView(screen);
        expect(flattenStyle(contentViewAfter?.props?.style).opacity).toBe(1);
    });

    it('supports a blur backdrop behind the popover content (context-menu focus)', async () => {
        const { Popover } = await import('./Popover');

        const anchorRef = { current: null } as any;

        const screen = await renderScreen(React.createElement(Popover, {
            open: true,
            anchorRef,
            onRequestClose: () => {},
            backdrop: { effect: 'blur' },
            children: () => React.createElement('PopoverChild'),
        } as any));

        const views = screen.findAllByType('View' as any);
        expect(views.some((v: any) => v.props?.testID === 'popover-backdrop-effect')).toBe(true);
    });

    it('allows configuring web blur strength and tint for blur backdrops', async () => {
        const { Popover } = await import('./Popover');

        const anchorRef = {
            current: {
                measureInWindow: (cb: any) => {
                    queueMicrotask(() => cb(100, 100, 20, 20));
                },
            },
        } as any;

        const screen = await renderScreen(React.createElement(Popover, {
            open: true,
            anchorRef,
            placement: 'bottom',
            portal: { web: true },
            backdrop: {
                effect: 'blur',
                blurOnWeb: { px: 3, tintColor: 'rgba(255, 255, 255, 0.18)' },
            },
            onRequestClose: () => {},
            children: () => React.createElement('PopoverChild'),
        } as any));

        await act(async () => {
            await flushInitialPositioning();
        });

        const hostEffects = findHostNodesByTestId(screen, 'popover-backdrop-effect');
        expect(hostEffects.length).toBe(1);

        const style = flattenStyle(hostEffects[0]?.props?.style);
        expect(style.backdropFilter).toBe('blur(3px)');
        expect(style.backgroundColor).toBe('rgba(255, 255, 255, 0.18)');
    });

    it('can spotlight the anchor so it stays crisp above the blur', async () => {
        const { Popover } = await import('./Popover');

        const anchorRef = {
            current: {
                measureInWindow: (cb: any) => {
                    queueMicrotask(() => cb(100, 100, 20, 20));
                },
            },
        } as any;

        const screen = await renderScreen(React.createElement(Popover, {
                    open: true,
                    anchorRef,
                    placement: 'bottom',
                    portal: { web: true },
                    backdrop: {
                        effect: 'blur',
                        spotlight: true,
                    },
                    onRequestClose: () => {},
                    children: () => React.createElement('PopoverChild'),
                } as any));

        await act(async () => {
            await flushInitialPositioning();
        });

        const hostEffects = findHostNodesByTestId(screen, 'popover-backdrop-effect');
        expect(hostEffects.length).toBe(4);
    });

    it('can render an anchor overlay above the blur backdrop (keeps the trigger crisp without cutout seams)', async () => {
        const { Popover } = await import('./Popover');

        const anchorRef = {
            current: {
                measureInWindow: (cb: any) => {
                    queueMicrotask(() => cb(120, 80, 24, 24));
                },
            },
        } as any;

        const screen = await renderScreen(React.createElement(Popover, {
                    open: true,
                    anchorRef,
                    placement: 'bottom',
                    portal: { web: { target: 'body' } },
                    backdrop: {
                        effect: 'blur',
                        anchorOverlay: () => React.createElement('AnchorOverlay'),
                    },
                    onRequestClose: () => {},
                    children: () => React.createElement('PopoverChild'),
                } as any));

        await act(async () => {
            await flushInitialPositioning();
        });

        const hostOverlay = findFirstHostNodeByTestId(screen, 'popover-anchor-overlay');
        expect(hostOverlay).toBeTruthy();

        const overlayStyle = flattenStyle(hostOverlay?.props?.style);
        expect(overlayStyle.position).toBe('fixed');
        expect(overlayStyle.left).toBe(120);
        expect(overlayStyle.top).toBe(80);
        expect(overlayStyle.width).toBe(24);
        expect(overlayStyle.height).toBe(24);
    });
});
