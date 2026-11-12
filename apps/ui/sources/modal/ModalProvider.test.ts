import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { useOverlayPortal } from '@/components/ui/popover';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => key,
    });
});

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                Platform: {
                    OS: 'web',
                    select: (options: any) => options.web ?? options.default,
                },
                Alert: {
                    alert: vi.fn(),
                    prompt: vi.fn(),
                },
            }
    );
});

vi.mock('./components/WebAlertModal', () => ({
    WebAlertModal: (props: any) => React.createElement('WebAlertModal', props),
}));

vi.mock('./components/WebPromptModal', () => ({
    WebPromptModal: (props: any) => React.createElement('WebPromptModal', props),
}));

vi.mock('./components/CustomModal', () => {
    const React = require('react');
    return {
        CustomModal: ({ config, onClose, showBackdrop, visible, zIndexBase }: any) =>
            React.createElement(
                React.Fragment,
                null,
                React.createElement('Backdrop', { showBackdrop, visible, zIndexBase }),
                React.createElement(config.component, { ...(config.props ?? {}), onClose, visible }),
            ),
    };
});

function DummyModalA(_props: { onClose: () => void }) {
    return React.createElement('DummyModalA');
}

function DummyModalB(_props: { onClose: () => void }) {
    return React.createElement('DummyModalB');
}

function DummyModalWithLabel(props: { onClose: () => void; label: string }) {
    return React.createElement('DummyModalWithLabel', { label: props.label });
}

async function renderProvider(modules: { ModalProvider: React.ComponentType<{ children: React.ReactNode }> }) {
    return renderScreen(React.createElement(modules.ModalProvider, { children: React.createElement('App') }));
}

async function renderProviderWithChildren(
    modules: { ModalProvider: React.ComponentType<{ children: React.ReactNode }> },
    children: React.ReactNode,
) {
    return renderScreen(React.createElement(modules.ModalProvider, { children }));
}

function showCustomModal(Modal: { show: (config: { component: React.ComponentType<{ onClose: () => void }> }) => string }, component: React.ComponentType<{ onClose: () => void }>) {
    act(() => {
        Modal.show({ component });
    });
}

describe('ModalProvider', () => {
    beforeEach(() => {
        vi.useRealTimers();
    });

    afterEach(async () => {
        const { Modal } = await import('./ModalManager');
        Modal.setFunctions(() => 'noop', () => {}, () => {});
        vi.useRealTimers();
    });

    it('keeps earlier custom modals mounted when stacking', async () => {
        const { ModalProvider } = await import('./ModalProvider');
        const { Modal } = await import('./ModalManager');
        const screen = await renderProvider({ ModalProvider });
        showCustomModal(Modal, DummyModalA);
        showCustomModal(Modal, DummyModalB);

        expect(screen.findAllByType(DummyModalA).length).toBe(1);
        expect(screen.findAllByType(DummyModalB).length).toBe(1);
    });

    it('only enables the backdrop on the top-most modal', async () => {
        const { ModalProvider } = await import('./ModalProvider');
        const { Modal } = await import('./ModalManager');
        const screen = await renderProvider({ ModalProvider });
        showCustomModal(Modal, DummyModalA);
        showCustomModal(Modal, DummyModalB);

        const backdrops = screen.findAllByType('Backdrop' as any);
        expect(backdrops.filter((b: any) => Boolean(b.props.showBackdrop)).length).toBe(1);
    });

    it('assigns a higher zIndexBase to the top-most modal so its backdrop layers above earlier modals', async () => {
        const { ModalProvider } = await import('./ModalProvider');
        const { Modal } = await import('./ModalManager');
        const screen = await renderProvider({ ModalProvider });
        showCustomModal(Modal, DummyModalA);
        showCustomModal(Modal, DummyModalB);

        const backdrops = screen.findAllByType('Backdrop' as any);
        const top = backdrops.find((b: any) => Boolean(b.props.showBackdrop));
        const bottom = backdrops.find((b: any) => !Boolean(b.props.showBackdrop));

        expect(top).toBeDefined();
        expect(bottom).toBeDefined();
        expect(typeof top?.props.zIndexBase).toBe('number');
        expect(typeof bottom?.props.zIndexBase).toBe('number');
        expect(top?.props.zIndexBase).toBeGreaterThan(bottom?.props.zIndexBase);
    });

    it('layers screen-level overlay portals below custom modals', async () => {
        const { ModalProvider } = await import('./ModalProvider');
        const { Modal } = await import('./ModalManager');
        const screen = await renderProviderWithChildren({ ModalProvider }, React.createElement(ScreenPortalProbe));

        showCustomModal(Modal, DummyModalA);

        const portalHost = screen.tree.root.find((node: any) => (
            node?.type === 'View'
            && node?.props?.collapsable === false
            && node?.props?.style?.[1]?.zIndex === 90000
        ));
        const backdrop = screen.findAllByType('Backdrop' as any)[0];
        expect(portalHost.props.style[1].zIndex).toBeLessThan(backdrop.props.zIndexBase);
        expect(screen.findByTestId('screen-portal-node')).toBeTruthy();
    });

    it('exposes modal keyboard-lift suppression while the modal stack is active', async () => {
        const { ModalProvider, useModal } = await import('./ModalProvider');
        const { Modal } = await import('./ModalManager');

        function SuppressionProbe() {
            const modal = useModal();
            return React.createElement('SuppressionProbe', {
                suppressed: modal.isKeyboardLiftSuppressedByModal,
            });
        }

        const screen = await renderScreen(
            React.createElement(
                ModalProvider,
                null,
                React.createElement(SuppressionProbe),
            ),
        );

        showCustomModal(Modal, DummyModalA);

        expect(screen.findByType('SuppressionProbe' as any).props.suppressed).toBe(true);

        act(() => {
            Modal.hideAll();
        });

        expect(screen.findByType('SuppressionProbe' as any).props.suppressed).toBe(false);
    });

    it('keeps a hidden custom modal mounted until the shared modal exit animation can complete', async () => {
        vi.useFakeTimers();
        const { ModalProvider } = await import('./ModalProvider');
        const { Modal } = await import('./ModalManager');
        const screen = await renderProvider({ ModalProvider });

        showCustomModal(Modal, DummyModalA);

        act(() => {
            const modal = screen.findByType(DummyModalA);
            modal?.props.onClose();
        });

        expect(screen.findAllByType(DummyModalA).length).toBe(1);
        expect(screen.findByType(DummyModalA)?.props.visible).toBe(false);

        act(() => {
            vi.advanceTimersByTime(motionTokens.overlay.modal.exitMs - 1);
        });

        expect(screen.findAllByType(DummyModalA).length).toBe(1);

        act(() => {
            vi.advanceTimersByTime(1);
        });

        expect(screen.findAllByType(DummyModalA).length).toBe(0);
    });

    it('returns focus to the imperative opener after a custom modal is removed', async () => {
        vi.useFakeTimers();
        const body = {};
        const opener = {
            isConnected: true,
            focus: vi.fn(),
        };
        const fakeDocument = {
            activeElement: opener as unknown,
            body,
        };
        vi.stubGlobal('document', fakeDocument);

        try {
            const { ModalProvider } = await import('./ModalProvider');
            const { Modal } = await import('./ModalManager');
            const screen = await renderProvider({ ModalProvider });
            showCustomModal(Modal, DummyModalA);
            fakeDocument.activeElement = body;

            act(() => {
                screen.findByType(DummyModalA)?.props.onClose();
                vi.advanceTimersByTime(motionTokens.overlay.modal.exitMs);
            });

            expect(screen.findAllByType(DummyModalA)).toHaveLength(0);
            expect(opener.focus).toHaveBeenCalledTimes(1);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('does not steal focus from a newer connected target when a custom modal closes', async () => {
        vi.useFakeTimers();
        const body = {};
        const opener = { isConnected: true, focus: vi.fn() };
        const newerTarget = { isConnected: true, focus: vi.fn() };
        const fakeDocument = { activeElement: opener as unknown, body };
        vi.stubGlobal('document', fakeDocument);

        try {
            const { ModalProvider } = await import('./ModalProvider');
            const { Modal } = await import('./ModalManager');
            const screen = await renderProvider({ ModalProvider });
            showCustomModal(Modal, DummyModalA);
            fakeDocument.activeElement = newerTarget;

            act(() => {
                screen.findByType(DummyModalA)?.props.onClose();
                vi.advanceTimersByTime(motionTokens.overlay.modal.exitMs);
            });

            expect(opener.focus).not.toHaveBeenCalled();
            expect(newerTarget.focus).not.toHaveBeenCalled();
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('does not focus an imperative opener that disconnected before modal removal', async () => {
        vi.useFakeTimers();
        const body = {};
        const opener = { isConnected: true, focus: vi.fn() };
        const fakeDocument = { activeElement: opener as unknown, body };
        vi.stubGlobal('document', fakeDocument);

        try {
            const { ModalProvider } = await import('./ModalProvider');
            const { Modal } = await import('./ModalManager');
            const screen = await renderProvider({ ModalProvider });
            showCustomModal(Modal, DummyModalA);
            opener.isConnected = false;
            fakeDocument.activeElement = body;

            act(() => {
                screen.findByType(DummyModalA)?.props.onClose();
                vi.advanceTimersByTime(motionTokens.overlay.modal.exitMs);
            });

            expect(opener.focus).not.toHaveBeenCalled();
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('keeps earlier modal mounted and transfers top backdrop when the top modal finishes closing', async () => {
        vi.useFakeTimers();
        const { ModalProvider } = await import('./ModalProvider');
        const { Modal } = await import('./ModalManager');
        const screen = await renderProvider({ ModalProvider });

        showCustomModal(Modal, DummyModalA);
        showCustomModal(Modal, DummyModalB);

        act(() => {
            const topModal = screen.findByType(DummyModalB);
            topModal?.props.onClose();
        });

        expect(screen.findAllByType(DummyModalA).length).toBe(1);
        expect(screen.findAllByType(DummyModalB).length).toBe(1);
        expect(screen.findByType(DummyModalB)?.props.visible).toBe(false);

        act(() => {
            vi.advanceTimersByTime(motionTokens.overlay.modal.exitMs);
        });

        expect(screen.findAllByType(DummyModalA).length).toBe(1);
        expect(screen.findAllByType(DummyModalB).length).toBe(0);
        const backdrops = screen.findAllByType('Backdrop' as any);
        expect(backdrops).toHaveLength(1);
        expect(Boolean(backdrops[0]?.props.showBackdrop)).toBe(true);
    });

    it('unmounts all custom modals when hideAll is invoked', async () => {
        const { ModalProvider } = await import('./ModalProvider');
        const { Modal } = await import('./ModalManager');
        const screen = await renderProvider({ ModalProvider });

        showCustomModal(Modal, DummyModalA);
        showCustomModal(Modal, DummyModalB);

        act(() => {
            Modal.hideAll();
        });

        expect(screen.findAllByType(DummyModalA).length).toBe(0);
        expect(screen.findAllByType(DummyModalB).length).toBe(0);
        expect(screen.findAllByType('Backdrop' as any).length).toBe(0);
    });

    it('returns focus to the earliest durable opener when hideAll removes a modal stack', async () => {
        const body = {};
        const rootOpener = { isConnected: true, focus: vi.fn() };
        const nestedOpener = { isConnected: true, focus: vi.fn() };
        const fakeDocument = { activeElement: rootOpener as unknown, body };
        vi.stubGlobal('document', fakeDocument);

        try {
            const { ModalProvider } = await import('./ModalProvider');
            const { Modal } = await import('./ModalManager');
            await renderProvider({ ModalProvider });
            showCustomModal(Modal, DummyModalA);
            fakeDocument.activeElement = nestedOpener;
            showCustomModal(Modal, DummyModalB);
            nestedOpener.isConnected = false;
            fakeDocument.activeElement = body;

            act(() => {
                Modal.hideAll();
            });

            expect(rootOpener.focus).toHaveBeenCalledTimes(1);
            expect(nestedOpener.focus).not.toHaveBeenCalled();
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('keeps the root opener authoritative when hideAll follows a pending root exit', async () => {
        vi.useFakeTimers();
        const body = {};
        const rootOpener = { isConnected: true, focus: vi.fn() };
        const nestedOpener = { isConnected: true, focus: vi.fn() };
        const fakeDocument = { activeElement: rootOpener as unknown, body };
        vi.stubGlobal('document', fakeDocument);

        try {
            const { ModalProvider } = await import('./ModalProvider');
            const { Modal } = await import('./ModalManager');
            await renderProvider({ ModalProvider });

            let rootModalId = '';
            act(() => {
                rootModalId = Modal.show({ component: DummyModalA });
            });
            fakeDocument.activeElement = nestedOpener;
            showCustomModal(Modal, DummyModalB);

            act(() => {
                Modal.hide(rootModalId);
            });
            nestedOpener.isConnected = false;
            fakeDocument.activeElement = body;

            act(() => {
                Modal.hideAll();
            });

            expect(rootOpener.focus).toHaveBeenCalledTimes(1);
            expect(nestedOpener.focus).not.toHaveBeenCalled();
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('updates props for an open custom modal without remounting it', async () => {
        const { ModalProvider } = await import('./ModalProvider');
        const { Modal } = await import('./ModalManager');
        const screen = await renderProvider({ ModalProvider });

        let modalId = '';
        act(() => {
            modalId = Modal.show({
                component: DummyModalWithLabel,
                props: { label: 'before' },
            });
        });

        expect(screen.findByType('DummyModalWithLabel' as any).props.label).toBe('before');

        act(() => {
            Modal.update(modalId, { label: 'after' });
        });

        expect(screen.findByType('DummyModalWithLabel' as any).props.label).toBe('after');
    });

    it('restores the outer provider after a later nested provider unmounts', async () => {
        const { ModalProvider } = await import('./ModalProvider');
        const { Modal } = await import('./ModalManager');

        let setShowInnerProvider: React.Dispatch<React.SetStateAction<boolean>> | null = null;

        function NestedProviders() {
            const [showInnerProvider, setShowInnerProviderState] = React.useState(false);
            setShowInnerProvider = setShowInnerProviderState;

            return React.createElement(
                ModalProvider,
                null,
                showInnerProvider
                    ? React.createElement(
                        ModalProvider,
                        null,
                        React.createElement(InnerProviderMarker),
                    )
                    : null,
                React.createElement(OuterProviderMarker),
            );
        }

        function InnerProviderMarker() {
            return React.createElement('InnerProviderMarker');
        }

        function OuterProviderMarker() {
            return React.createElement('OuterProviderMarker');
        }

        const screen = await renderScreen(React.createElement(NestedProviders));

        act(() => {
            setShowInnerProvider?.(true);
        });

        act(() => {
            setShowInnerProvider?.(false);
        });

        act(() => {
            Modal.show({ component: DummyModalA });
        });

        expect(screen.findAllByType(DummyModalA)).toHaveLength(1);
    });

    it('keeps inactive nested providers from receiving global modal calls while they stay mounted', async () => {
        const { ModalProvider } = await import('./ModalProvider');
        const { Modal } = await import('./ModalManager');
        const ActiveModalProvider = ModalProvider as React.ComponentType<React.PropsWithChildren<{ active?: boolean }>>;

        let setInnerActive: React.Dispatch<React.SetStateAction<boolean>> | null = null;
        let setShowInnerProvider: React.Dispatch<React.SetStateAction<boolean>> | null = null;

        function NestedProviders() {
            const [innerActive, setInnerActiveState] = React.useState(true);
            const [showInnerProvider, setShowInnerProviderState] = React.useState(false);
            setInnerActive = setInnerActiveState;
            setShowInnerProvider = setShowInnerProviderState;

            return React.createElement(
                ModalProvider,
                null,
                showInnerProvider
                    ? React.createElement(
                        ActiveModalProvider,
                        { active: innerActive },
                        React.createElement(InnerProviderMarker),
                    )
                    : null,
                React.createElement(OuterProviderMarker),
            );
        }

        function InnerProviderMarker() {
            return React.createElement('InnerProviderMarker');
        }

        function OuterProviderMarker() {
            return React.createElement('OuterProviderMarker');
        }

        const screen = await renderScreen(React.createElement(NestedProviders));

        act(() => {
            setShowInnerProvider?.(true);
        });

        act(() => {
            setInnerActive?.(false);
        });

        act(() => {
            Modal.show({ component: DummyModalA });
        });

        expect(screen.findAllByType(DummyModalA)).toHaveLength(1);

        act(() => {
            setShowInnerProvider?.(false);
        });

        expect(screen.findAllByType(DummyModalA)).toHaveLength(1);
    });

    it('notifies a custom modal\'s onRequestClose once when it is dismissed through its close path', async () => {
        const { ModalProvider } = await import('./ModalProvider');
        const { Modal } = await import('./ModalManager');
        const screen = await renderProvider({ ModalProvider });
        const onRequestClose = vi.fn();
        act(() => {
            Modal.show({ component: DummyModalA, onRequestClose });
        });

        act(() => {
            screen.findByType(DummyModalA).props.onClose();
        });

        expect(onRequestClose).toHaveBeenCalledTimes(1);
        expect(screen.findByType(DummyModalA).props.visible).toBe(false);
    });

    it('resolves confirm as false when a web confirm modal closes without an explicit choice', async () => {
        const { ModalProvider } = await import('./ModalProvider');
        const { Modal } = await import('./ModalManager');
        const screen = await renderProvider({ ModalProvider });

        const pending = Symbol('pending');
        let promise!: Promise<boolean>;
        await act(async () => {
            promise = Modal.confirm('Confirm title', 'Confirm body');
        });

        act(() => {
            screen.findByType('WebAlertModal' as any).props.onClose();
        });

        const result = await Promise.race([
            promise,
            new Promise<typeof pending>((resolve) => {
                setTimeout(() => resolve(pending), 0);
            }),
        ]);

        expect(result).toBe(false);
        expect(screen.findAllByType('WebAlertModal' as any)).toHaveLength(0);
    });

    it('resolves prompt as null when a web prompt modal closes without confirmation', async () => {
        const { ModalProvider } = await import('./ModalProvider');
        const { Modal } = await import('./ModalManager');
        const screen = await renderProvider({ ModalProvider });

        const pending = Symbol('pending');
        let promise!: Promise<string | null>;
        await act(async () => {
            promise = Modal.prompt('Prompt title', 'Prompt body');
        });

        act(() => {
            screen.findByType('WebPromptModal' as any).props.onClose();
        });

        const result = await Promise.race([
            promise,
            new Promise<typeof pending>((resolve) => {
                setTimeout(() => resolve(pending), 0);
            }),
        ]);

        expect(result).toBeNull();
        expect(screen.findAllByType('WebPromptModal' as any)).toHaveLength(0);
    });
});

function ScreenPortalProbe() {
    const portal = useOverlayPortal();

    React.useEffect(() => {
        portal?.setPortalNode('screen-node', React.createElement('ScreenPortalNode', {
            testID: 'screen-portal-node',
        }));
        return () => {
            portal?.removePortalNode('screen-node');
        };
    }, [portal]);

    return React.createElement('App');
}
