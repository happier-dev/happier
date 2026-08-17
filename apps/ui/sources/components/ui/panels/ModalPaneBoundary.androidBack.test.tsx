import * as React from 'react';
import { BackHandler } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';

type HardwareBackHandler = () => boolean | null | undefined;

const nativeBack = vi.hoisted(() => {
    let handlers: HardwareBackHandler[] = [];

    const register = (handler: HardwareBackHandler) => {
        handlers = [...handlers, handler];
        return () => {
            handlers = handlers.filter((candidate) => candidate !== handler);
        };
    };

    const addEventListener = vi.fn((eventName: string, handler: HardwareBackHandler) => {
        if (eventName !== 'hardwareBackPress') {
            throw new Error(`Unexpected native BackHandler event: ${eventName}`);
        }
        const remove = register(handler);
        return { remove };
    });

    return {
        addEventListener,
        register,
        emit() {
            for (const handler of [...handlers].reverse()) {
                if (handler()) return true;
            }
            return false;
        },
        reset() {
            handlers = [];
            addEventListener.mockClear();
        },
    };
});

vi.mock('react-native', async () => {
    const actual = await vi.importActual<typeof import('react-native-web')>('react-native-web');
    return {
        ...actual,
        Platform: {
            ...actual.Platform,
            OS: 'android',
            select: <T,>(values: { android?: T; native?: T; default?: T }) => (
                values.android ?? values.native ?? values.default
            ),
        },
        BackHandler: {
            addEventListener: nativeBack.addEventListener,
        },
    };
});

describe('ModalPaneBoundary Android Back', () => {
    beforeEach(() => {
        nativeBack.reset();
    });

    afterEach(() => {
        nativeBack.reset();
    });

    it('lets a later native menu handler consume Back before closing the active pane', async () => {
        const { ModalPaneBoundaryView, useModalPaneBoundary } = await import('./ModalPaneBoundary');
        const onRequestClose = vi.fn();
        const higherMenuHandler = vi.fn(() => true);

        function PaneBoundary() {
            const boundary = useModalPaneBoundary({
                active: true,
                label: 'Right sidebar',
                onRequestClose,
            });
            return <ModalPaneBoundaryView {...boundary.overlayProps} />;
        }

        const screen = await renderScreen(<PaneBoundary />);
        await flushHookEffects({ cycles: 2, turns: 2 });
        const removeHigherMenuHandler = nativeBack.register(higherMenuHandler);

        expect(nativeBack.emit()).toBe(true);
        expect(higherMenuHandler).toHaveBeenCalledTimes(1);
        expect(onRequestClose).not.toHaveBeenCalled();

        removeHigherMenuHandler();
        expect(nativeBack.emit()).toBe(true);
        expect(onRequestClose).toHaveBeenCalledTimes(1);

        await screen.unmount();
    });

    it('keeps an already-open child overlay above the pane when the pane becomes modal', async () => {
        const { ModalPaneBoundaryView, useModalPaneBoundary } = await import('./ModalPaneBoundary');
        const { useNativeBackLayerDescendant } = await import('@/components/ui/overlays/NativeBackLayerBoundary');
        const onRequestClose = vi.fn();
        const onChildOverlayBack = vi.fn(() => true);

        function OpenChildOverlay() {
            useNativeBackLayerDescendant(true);
            React.useEffect(() => {
                const subscription = BackHandler.addEventListener('hardwareBackPress', onChildOverlayBack);
                return () => subscription.remove();
            }, []);
            return React.createElement('OpenChildOverlay');
        }

        function PaneBoundary(props: Readonly<{ active: boolean }>) {
            const boundary = useModalPaneBoundary({
                active: props.active,
                label: 'Right sidebar',
                onRequestClose,
            });
            return (
                <ModalPaneBoundaryView {...boundary.overlayProps}>
                    <OpenChildOverlay />
                </ModalPaneBoundaryView>
            );
        }

        const screen = await renderScreen(<PaneBoundary active={false} />);
        await screen.update(<PaneBoundary active />);

        expect(nativeBack.emit()).toBe(true);
        expect(onChildOverlayBack).toHaveBeenCalledTimes(1);
        expect(onRequestClose).not.toHaveBeenCalled();
    });

    it('keeps a modal underlay boundary from stealing Back when it opens after the visible overlay', async () => {
        const { ModalPaneBoundaryView, useModalPaneBoundary } = await import('./ModalPaneBoundary');
        const onCloseOuter = vi.fn();
        const onCloseInner = vi.fn();

        function InnerBoundary(props: Readonly<{ active: boolean }>) {
            const boundary = useModalPaneBoundary({
                active: props.active,
                label: 'Right sidebar',
                onRequestClose: onCloseInner,
            });
            return <ModalPaneBoundaryView {...boundary.overlayProps} />;
        }

        function OuterBoundary(props: Readonly<{ innerActive: boolean }>) {
            const boundary = useModalPaneBoundary({
                active: true,
                label: 'Bottom panel',
                onRequestClose: onCloseOuter,
            });
            return (
                <>
                    <ModalPaneBoundaryView {...boundary.underlayProps}>
                        <InnerBoundary active={props.innerActive} />
                    </ModalPaneBoundaryView>
                    <ModalPaneBoundaryView {...boundary.overlayProps} />
                </>
            );
        }

        const screen = await renderScreen(<OuterBoundary innerActive={false} />);
        await screen.update(<OuterBoundary innerActive />);

        expect(nativeBack.emit()).toBe(true);
        expect(onCloseOuter).toHaveBeenCalledTimes(1);
        expect(onCloseInner).not.toHaveBeenCalled();
    });

    it('consumes Back through a current guest-history callback before closing its pane', async () => {
        const { ModalPaneBoundaryView, useModalPaneBoundary } = await import('./ModalPaneBoundary');
        const { useNativeBackLayerBackHandler } = await import('@/components/ui/overlays/NativeBackLayerBoundary');
        const onRequestClose = vi.fn();
        const onGuestBack = vi.fn(() => true);

        function GuestHistory() {
            useNativeBackLayerBackHandler(true, onGuestBack);
            return null;
        }

        function PaneBoundary() {
            const boundary = useModalPaneBoundary({
                active: true,
                label: 'Hosted plugin pane',
                onRequestClose,
            });
            return (
                <ModalPaneBoundaryView {...boundary.overlayProps}>
                    <GuestHistory />
                </ModalPaneBoundaryView>
            );
        }

        const screen = await renderScreen(<PaneBoundary />);
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(nativeBack.emit()).toBe(true);
        expect(onGuestBack).toHaveBeenCalledExactlyOnceWith();
        expect(onRequestClose).not.toHaveBeenCalled();

        await screen.unmount();
    });

    it('falls through from a declined guest-history callback to the pane close owner', async () => {
        const { ModalPaneBoundaryView, useModalPaneBoundary } = await import('./ModalPaneBoundary');
        const { useNativeBackLayerBackHandler } = await import('@/components/ui/overlays/NativeBackLayerBoundary');
        const onRequestClose = vi.fn();
        const onGuestBack = vi.fn(() => false);

        function GuestHistory() {
            useNativeBackLayerBackHandler(true, onGuestBack);
            return null;
        }

        function PaneBoundary() {
            const boundary = useModalPaneBoundary({
                active: true,
                label: 'Hosted plugin pane',
                onRequestClose,
            });
            return (
                <ModalPaneBoundaryView {...boundary.overlayProps}>
                    <GuestHistory />
                </ModalPaneBoundaryView>
            );
        }

        const screen = await renderScreen(<PaneBoundary />);
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(nativeBack.emit()).toBe(true);
        expect(onGuestBack).toHaveBeenCalledExactlyOnceWith();
        expect(onRequestClose).toHaveBeenCalledExactlyOnceWith();

        await screen.unmount();
    });
});
