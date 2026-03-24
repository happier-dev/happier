import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { useModalPortalTarget } from '@/modal/portal/ModalPortalTarget';
import { renderScreen } from '@/dev/testkit';
import { installModalComponentCommonModuleMocks } from './modalComponentTestHelpers';

const reactActEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};

reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

function createRadixHostComponent(tagName: string) {
    return (props: Record<string, unknown>) => {
        const { children, ...rest } = props as Record<string, unknown> & { children?: React.ReactNode };
        return React.createElement(tagName, rest, children);
    };
}

vi.mock('@/utils/web/radixCjs', () => {
    return {
        requireRadixDialog: () => ({
            Root: createRadixHostComponent('DialogRoot'),
            Portal: createRadixHostComponent('DialogPortal'),
            Overlay: createRadixHostComponent('DialogOverlay'),
            Content: createRadixHostComponent('DialogContent'),
            Title: createRadixHostComponent('DialogTitle'),
        }),
        requireRadixDismissableLayer: () => ({
            Branch: createRadixHostComponent('DismissableLayerBranch'),
            DismissableLayerBranch: createRadixHostComponent('DismissableLayerBranch'),
        }),
    };
});

installModalComponentCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    },
});

async function renderBaseModalScreen(
    BaseModal: React.ComponentType<any>,
    props: Record<string, unknown> = {},
    options?: Parameters<typeof renderScreen>[1],
) {
    return renderScreen(React.createElement(BaseModal, { visible: true, children: React.createElement('Child'), ...props }), options);
}

describe('BaseModal (web)', () => {
    it('renders using Radix Dialog instead of react-native Modal', async () => {
        const { BaseModal } = await import('./BaseModal');
        const screen = await renderBaseModalScreen(BaseModal);

        expect(screen.findAllByType('DialogRoot' as any).length).toBe(1);
        expect(screen.findAllByType('RNModal' as any).length).toBe(0);
    });

    it('wraps the dialog content in a DismissableLayer Branch (so underlying Vaul/Radix layers don’t dismiss)', async () => {
        const { BaseModal } = await import('./BaseModal');
        const screen = await renderBaseModalScreen(BaseModal);

        expect(screen.findAllByType('DismissableLayerBranch' as any).length).toBe(1);
    });

    it('renders a DialogTitle for accessibility', async () => {
        const { BaseModal } = await import('./BaseModal');
        const screen = await renderBaseModalScreen(BaseModal);

        expect(screen.findAllByType('DialogTitle' as any).length).toBe(1);
    });

    it('omits the overlay when showBackdrop is false', async () => {
        const { BaseModal } = await import('./BaseModal');
        const screen = await renderBaseModalScreen(BaseModal, { showBackdrop: false });

        expect(screen.findAllByType('DialogOverlay' as any).length).toBe(0);
    });

    it('prevents outside dismissal when closeOnBackdrop is false', async () => {
        const { BaseModal } = await import('./BaseModal');

        const screen = await renderBaseModalScreen(BaseModal, { closeOnBackdrop: false, onClose: () => {} });

        const content = screen.findAllByType('DialogContent' as any)?.[0];
        expect(content?.props.onPointerDownOutside).toBeTypeOf('function');

        const preventDefault = vi.fn();
        content?.props.onPointerDownOutside({ preventDefault });
        expect(preventDefault).toHaveBeenCalled();
    });

    it('dismisses when clicking the backdrop area (pointer down on the content container itself)', async () => {
        const { BaseModal } = await import('./BaseModal');

        const onClose = vi.fn();
        const screen = await renderBaseModalScreen(BaseModal, { onClose });

        const content = screen.findAllByType('DialogContent' as any)?.[0];
        expect(content?.props.onClick).toBeTypeOf('function');

        const target = {};
        content?.props.onClick({ target, currentTarget: target, preventDefault: () => {}, stopPropagation: () => {} });

        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('does not dismiss when clicking inside the modal content', async () => {
        const { BaseModal } = await import('./BaseModal');

        const onClose = vi.fn();
        const screen = await renderBaseModalScreen(BaseModal, { onClose });

        const content = screen.findAllByType('DialogContent' as any)?.[0];
        expect(content?.props.onClick).toBeTypeOf('function');

        const currentTarget = {};
        const innerTarget = {
            closest: vi.fn().mockReturnValue({}),
        };
        content?.props.onClick({ target: innerTarget, currentTarget, preventDefault: () => {}, stopPropagation: () => {} });

        expect(innerTarget.closest).toHaveBeenCalledWith('[data-happy-modal-card-boundary]');
        expect(onClose).toHaveBeenCalledTimes(0);
    });

    it('does not rely on pointerEvents=\"box-none\" on the centering container on web', async () => {
        const { BaseModal } = await import('./BaseModal');
        const screen = await renderBaseModalScreen(BaseModal);

        const container = screen.findAllByType('KeyboardAvoidingView' as any)?.[0];
        expect(container?.props.pointerEvents).not.toBe('box-none');
    });

    it('does not rely on pointerEvents=\"box-none\" on the wrapper around modal children on web', async () => {
        const { BaseModal } = await import('./BaseModal');
        const screen = await renderBaseModalScreen(BaseModal);

        const child = screen.findByType('Child' as any);
        const wrapper = (child as any)?.parent;

        expect(wrapper?.type).toBe('div');
        expect(wrapper?.props['data-happy-modal-card-boundary']).toBe('');
    });

    it('dismisses when clicking the centering shell outside the modal card', async () => {
        const { BaseModal } = await import('./BaseModal');

        const onClose = vi.fn();
        const screen = await renderBaseModalScreen(BaseModal, { onClose });

        const content = screen.findAllByType('DialogContent' as any)?.[0];
        expect(content?.props.onClick).toBeTypeOf('function');

        const outsideTarget = {
            closest: vi.fn().mockReturnValue(null),
        };

        content?.props.onClick({
            target: outsideTarget,
            currentTarget: {},
            preventDefault: () => {},
            stopPropagation: () => {},
        });

        expect(outsideTarget.closest).toHaveBeenCalledWith('[data-happy-modal-card-boundary]');
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('forces document.body pointer events back to auto while a web modal is visible and restores them on unmount', async () => {
        const { BaseModal } = await import('./BaseModal');

        const originalDocument = (globalThis as any).document;
        const originalMutationObserver = (globalThis as any).MutationObserver;
        const bodyStyle = { pointerEvents: 'none' };
        type ObserverCallback = (records: unknown[], observer: unknown) => void;
        let observerCallback: ObserverCallback | null = null;

        class FakeMutationObserver {
            constructor(callback: ObserverCallback) {
                observerCallback = callback;
            }

            observe() {}

            disconnect() {}
        }

        (globalThis as any).document = {
            body: {
                style: bodyStyle,
            },
        };
        (globalThis as any).MutationObserver = FakeMutationObserver;

        try {
            const screen = await renderBaseModalScreen(BaseModal);

            expect(bodyStyle.pointerEvents).toBe('auto');

            bodyStyle.pointerEvents = 'none';
            if (observerCallback == null) {
                throw new Error('expected MutationObserver callback');
            }
            (observerCallback as (records: unknown[], observer: unknown) => void)([], {});
            expect(bodyStyle.pointerEvents).toBe('auto');

            await screen.unmount();

            expect(bodyStyle.pointerEvents).toBe('none');
        } finally {
            (globalThis as any).document = originalDocument;
            (globalThis as any).MutationObserver = originalMutationObserver;
        }
    });

    it('applies zIndexBase to the overlay and content so stacked modals layer correctly', async () => {
        const { BaseModal } = await import('./BaseModal');
        const screen = await renderBaseModalScreen(BaseModal, { zIndexBase: 1234 });

        const overlay = screen.findAllByType('DialogOverlay' as any)?.[0];
        const content = screen.findAllByType('DialogContent' as any)?.[0];

        expect(overlay?.props.style?.zIndex).toBe(1234);
        expect(content?.props.style?.zIndex).toBe(1235);
    });

    it('provides a modal portal target to descendants (so popovers can portal inside the dialog subtree)', async () => {
        const { BaseModal } = await import('./BaseModal');

        const portalHostMock = { nodeType: 1 } as any;
        let observedTarget: any = undefined;

        function Probe() {
            observedTarget = useModalPortalTarget();
            return React.createElement('Probe');
        }

        await renderBaseModalScreen(
            BaseModal,
            { children: React.createElement(Probe) },
            {
                createNodeMock: (element: any) => {
                    if (element?.props?.['data-happy-modal-portal-host'] !== undefined) {
                        return portalHostMock;
                    }
                    return null;
                },
            },
        );

        expect(observedTarget).toBe(portalHostMock);
    });

    it('calls onClose when Radix reports onOpenChange(false)', async () => {
        const { BaseModal } = await import('./BaseModal');
        const onClose = vi.fn();
        const screen = await renderBaseModalScreen(BaseModal, { onClose });

        const root = screen.findByType('DialogRoot' as any);
        expect(root?.props.onOpenChange).toBeTypeOf('function');

        act(() => {
            root?.props.onOpenChange(false);
        });

        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
