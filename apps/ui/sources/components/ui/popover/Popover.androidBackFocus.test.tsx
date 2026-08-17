import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { installPopoverCommonModuleMocks } from './popoverTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type HardwareBackHandler = () => boolean;

const nativeBack = vi.hoisted(() => {
    let handlers: HardwareBackHandler[] = [];
    const addEventListener = vi.fn((eventName: string, handler: HardwareBackHandler) => {
        if (eventName !== 'hardwareBackPress') {
            throw new Error(`Unexpected native BackHandler event: ${eventName}`);
        }
        handlers = [...handlers, handler];
        return {
            remove: () => {
                handlers = handlers.filter((candidate) => candidate !== handler);
            },
        };
    });

    return {
        addEventListener,
        emitHardwareBackPress() {
            for (const handler of [...handlers].reverse()) {
                if (handler()) return true;
            }
            return false;
        },
        getHandlerCount() {
            return handlers.length;
        },
        reset() {
            handlers = [];
            addEventListener.mockClear();
        },
    };
});

installPopoverCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'android',
                select: (value: any) => value.android ?? value.native ?? value.default ?? null,
            },
            BackHandler: {
                addEventListener: nativeBack.addEventListener,
            },
            useWindowDimensions: () => ({ width: 1000, height: 800 }),
            StyleSheet: {
                absoluteFill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
            },
        });
    },
});

function createAnchorRef() {
    return {
        current: {
            measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => {
                callback(100, 100, 32, 24);
            },
        },
    } as React.RefObject<any>;
}

describe('Popover (Android Back and focus)', () => {
    beforeEach(() => {
        nativeBack.reset();
    });

    afterEach(() => {
        nativeBack.reset();
        vi.restoreAllMocks();
    });

    it('consumes Android Back at the topmost native popover and restores the explicit pressable focus return target', async () => {
        const { Popover } = await import('./Popover');
        const { OverlayPortalHost, OverlayPortalProvider } = await import('./OverlayPortal');
        const outerOnRequestClose = vi.fn();
        const innerOnRequestClose = vi.fn();
        const outerAnchorFocus = vi.fn();
        const outerTriggerFocus = vi.fn();
        const innerAnchorFocus = vi.fn();
        const innerTriggerFocus = vi.fn();
        const unrelatedBackHandler = vi.fn(() => false);
        nativeBack.addEventListener('hardwareBackPress', unrelatedBackHandler);

        const outerAnchorRef = createAnchorRef();
        outerAnchorRef.current!.focus = outerAnchorFocus;
        const outerFocusReturnRef = { current: { focus: outerTriggerFocus } } as React.RefObject<any>;
        const innerAnchorRef = createAnchorRef();
        innerAnchorRef.current!.focus = innerAnchorFocus;
        const innerFocusReturnRef = { current: { focus: innerTriggerFocus } } as React.RefObject<any>;

        const renderNestedPopovers = (innerOpen: boolean) => (
            <OverlayPortalProvider>
                <Popover
                    open
                    anchorRef={outerAnchorRef}
                    focusReturnRef={outerFocusReturnRef}
                    portal={{ native: true }}
                    placement="bottom"
                    backdrop={false}
                    onRequestClose={outerOnRequestClose}
                >
                    {() => (
                        <Popover
                            open={innerOpen}
                            anchorRef={innerAnchorRef}
                            focusReturnRef={innerFocusReturnRef}
                            portal={{ native: true }}
                            placement="bottom"
                            backdrop={false}
                            onRequestClose={innerOnRequestClose}
                        >
                            {() => <PopoverChild />}
                        </Popover>
                    )}
                </Popover>
                <OverlayPortalHost />
            </OverlayPortalProvider>
        );

        const screen = await renderScreen(renderNestedPopovers(true));
        await flushHookEffects({ cycles: 3, turns: 4 });

        // The pre-existing handler is lower in the platform stack; both active
        // popovers must register above it, with the nested surface last.
        expect(nativeBack.getHandlerCount()).toBe(3);
        expect(nativeBack.emitHardwareBackPress()).toBe(true);
        expect(innerOnRequestClose).toHaveBeenCalledTimes(1);
        expect(outerOnRequestClose).not.toHaveBeenCalled();
        expect(unrelatedBackHandler).not.toHaveBeenCalled();
        // The measurable wrapper is not necessarily the Pressable trigger.
        // Return focus follows the explicit focusReturnRef supplied by the menu.
        expect(innerTriggerFocus).toHaveBeenCalledTimes(1);
        expect(innerAnchorFocus).not.toHaveBeenCalled();

        await screen.update(renderNestedPopovers(false));
        await flushHookEffects({ cycles: 2, turns: 3 });

        expect(nativeBack.getHandlerCount()).toBe(2);
        expect(nativeBack.emitHardwareBackPress()).toBe(true);
        expect(outerOnRequestClose).toHaveBeenCalledTimes(1);
        expect(unrelatedBackHandler).not.toHaveBeenCalled();
        expect(outerTriggerFocus).toHaveBeenCalledTimes(1);
        expect(outerAnchorFocus).not.toHaveBeenCalled();

        await screen.unmount();
    });

    it('keeps an open popover above a pane promoted from docked to modal presentation', async () => {
        const { ModalPaneBoundaryView, useModalPaneBoundary } = await import('@/components/ui/panels/ModalPaneBoundary');
        const { Popover } = await import('./Popover');
        const { OverlayPortalHost, OverlayPortalProvider } = await import('./OverlayPortal');
        const onPaneClose = vi.fn();
        const onPopoverClose = vi.fn();
        const anchorRef = createAnchorRef();

        function Pane(props: Readonly<{ active: boolean }>) {
            const boundary = useModalPaneBoundary({
                active: props.active,
                label: 'Right sidebar',
                onRequestClose: onPaneClose,
            });
            return (
                <ModalPaneBoundaryView {...boundary.overlayProps}>
                    <Popover
                        open
                        anchorRef={anchorRef}
                        portal={{ native: true }}
                        placement="bottom"
                        backdrop={false}
                        onRequestClose={onPopoverClose}
                    >
                        {() => <PopoverChild />}
                    </Popover>
                </ModalPaneBoundaryView>
            );
        }

        const screen = await renderScreen(
            <OverlayPortalProvider>
                <Pane active={false} />
                <OverlayPortalHost />
            </OverlayPortalProvider>,
        );
        await flushHookEffects({ cycles: 3, turns: 4 });
        await screen.update(
            <OverlayPortalProvider>
                <Pane active />
                <OverlayPortalHost />
            </OverlayPortalProvider>,
        );
        await flushHookEffects({ cycles: 3, turns: 4 });

        expect(nativeBack.emitHardwareBackPress()).toBe(true);
        expect(onPopoverClose).toHaveBeenCalledTimes(1);
        expect(onPaneClose).not.toHaveBeenCalled();

        await screen.unmount();
    });

    it('moves native focus into the portaled popover content when opening a menu-like surface', async () => {
        const { Popover } = await import('./Popover');
        const { OverlayPortalHost, OverlayPortalProvider } = await import('./OverlayPortal');
        const contentFocus = vi.fn();
        const anchorRef = createAnchorRef();

        const screen = await renderScreen(
            <OverlayPortalProvider>
                <Popover
                    open
                    anchorRef={anchorRef}
                    autoFocusOnOpen
                    portal={{ native: true }}
                    placement="bottom"
                    backdrop={false}
                    onRequestClose={() => {}}
                >
                    {() => <PopoverChild />}
                </Popover>
                <OverlayPortalHost />
            </OverlayPortalProvider>,
            {
                createNodeMock: (element) => (
                    element.type === 'View' ? { focus: contentFocus } : {}
                ),
            },
        );
        await flushHookEffects({ cycles: 3, turns: 4 });

        expect(contentFocus).toHaveBeenCalled();
        await screen.unmount();
    });

    it('moves native focus to the supplied active menu row instead of the anonymous portal wrapper', async () => {
        const { Popover } = await import('./Popover');
        const { OverlayPortalHost, OverlayPortalProvider } = await import('./OverlayPortal');
        const wrapperFocus = vi.fn();
        const activeRowFocus = vi.fn();
        const anchorRef = createAnchorRef();
        const initialFocusRef = { current: { focus: activeRowFocus } } as React.RefObject<any>;

        const screen = await renderScreen(
            <OverlayPortalProvider>
                <Popover
                    open
                    anchorRef={anchorRef}
                    initialFocusRef={initialFocusRef}
                    autoFocusOnOpen
                    portal={{ native: true }}
                    placement="bottom"
                    backdrop={false}
                    onRequestClose={() => {}}
                >
                    {() => <PopoverChild />}
                </Popover>
                <OverlayPortalHost />
            </OverlayPortalProvider>,
            {
                createNodeMock: (element) => (
                    element.type === 'View' ? { focus: wrapperFocus } : {}
                ),
            },
        );
        await flushHookEffects({ cycles: 3, turns: 4 });

        expect(activeRowFocus).toHaveBeenCalledTimes(1);
        expect(wrapperFocus).not.toHaveBeenCalled();
        await screen.unmount();
    });
});

function PopoverChild(): React.ReactElement {
    return React.createElement('PopoverChild');
}
