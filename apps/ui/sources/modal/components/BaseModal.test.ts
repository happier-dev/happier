import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { useModalPortalTarget } from '@/modal/portal/ModalPortalTarget';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/utils/web/radixCjs', () => {
    const React = require('react');
    return {
        requireRadixDialog: () => ({
            Root: (props: any) => React.createElement('DialogRoot', props, props.children),
            Portal: (props: any) => React.createElement('DialogPortal', props, props.children),
            Overlay: (props: any) => React.createElement('DialogOverlay', props, props.children),
            Content: (props: any) => React.createElement('DialogContent', props, props.children),
            Title: (props: any) => React.createElement('DialogTitle', props, props.children),
        }),
        requireRadixDismissableLayer: () => ({
            Branch: (props: any) => React.createElement('DismissableLayerBranch', props, props.children),
            DismissableLayerBranch: (props: any) => React.createElement('DismissableLayerBranch', props, props.children),
        }),
    };
});

vi.mock('react-native', () => {
    const React = require('react');

    class AnimatedValue {
        constructor(_value: number) {}
        interpolate(_config: unknown) {
            return 0;
        }
    }

    const Animated: any = {
        Value: AnimatedValue,
        timing: () => ({ start: (cb?: () => void) => cb?.() }),
        spring: () => ({ start: (cb?: () => void) => cb?.() }),
        View: (props: any) => React.createElement('AnimatedView', props, props.children),
    };

    return {
        View: (props: any) => React.createElement('View', props, props.children),
        TouchableWithoutFeedback: (props: any) => React.createElement('TouchableWithoutFeedback', props, props.children),
        KeyboardAvoidingView: (props: any) => React.createElement('KeyboardAvoidingView', props, props.children),
        Modal: (props: any) => React.createElement('RNModal', props, props.children),
        Animated,
        Platform: {
            OS: 'web',
            select: (options: any) => options.web ?? options.default,
        },
    };
});

vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (styles: any) => styles,
        absoluteFillObject: {},
    },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

function renderBaseModal(
    BaseModal: React.ComponentType<any>,
    props: Record<string, unknown> = {},
    options?: Parameters<typeof renderer.create>[1],
) {
    let tree: ReturnType<typeof renderer.create> | undefined;
    act(() => {
        tree = renderer.create(
            React.createElement(BaseModal, { visible: true, children: React.createElement('Child'), ...props }),
            options,
        );
    });
    return tree;
}

describe('BaseModal (web)', () => {
    it('renders using Radix Dialog instead of react-native Modal', async () => {
        const { BaseModal } = await import('./BaseModal');
        const tree = renderBaseModal(BaseModal);

        expect(tree?.root.findAllByType('DialogRoot' as any).length).toBe(1);
        expect(tree?.root.findAllByType('RNModal' as any).length).toBe(0);
    });

    it('wraps the dialog content in a DismissableLayer Branch (so underlying Vaul/Radix layers don’t dismiss)', async () => {
        const { BaseModal } = await import('./BaseModal');
        const tree = renderBaseModal(BaseModal);

        expect(tree?.root.findAllByType('DismissableLayerBranch' as any).length).toBe(1);
    });

    it('renders a DialogTitle for accessibility', async () => {
        const { BaseModal } = await import('./BaseModal');
        const tree = renderBaseModal(BaseModal);

        expect(tree?.root.findAllByType('DialogTitle' as any).length).toBe(1);
    });

    it('omits the overlay when showBackdrop is false', async () => {
        const { BaseModal } = await import('./BaseModal');
        const tree = renderBaseModal(BaseModal, { showBackdrop: false });

        expect(tree?.root.findAllByType('DialogOverlay' as any).length).toBe(0);
    });

    it('prevents outside dismissal when closeOnBackdrop is false', async () => {
        const { BaseModal } = await import('./BaseModal');

        const tree = renderBaseModal(BaseModal, { closeOnBackdrop: false, onClose: () => {} });

        const content = tree?.root.findAllByType('DialogContent' as any)?.[0];
        expect(content?.props.onPointerDownOutside).toBeTypeOf('function');

        const preventDefault = vi.fn();
        content?.props.onPointerDownOutside({ preventDefault });
        expect(preventDefault).toHaveBeenCalled();
    });

    it('dismisses when clicking the backdrop area (pointer down on the content container itself)', async () => {
        const { BaseModal } = await import('./BaseModal');

        const onClose = vi.fn();
        const tree = renderBaseModal(BaseModal, { onClose });

        const content = tree?.root.findAllByType('DialogContent' as any)?.[0];
        expect(content?.props.onClick).toBeTypeOf('function');

        const target = {};
        content?.props.onClick({ target, currentTarget: target, preventDefault: () => {}, stopPropagation: () => {} });

        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('does not dismiss when clicking inside the modal content', async () => {
        const { BaseModal } = await import('./BaseModal');

        const onClose = vi.fn();
        const tree = renderBaseModal(BaseModal, { onClose });

        const content = tree?.root.findAllByType('DialogContent' as any)?.[0];
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
        const tree = renderBaseModal(BaseModal);

        const container = tree?.root.findAllByType('KeyboardAvoidingView' as any)?.[0];
        expect(container?.props.pointerEvents).not.toBe('box-none');
    });

    it('does not rely on pointerEvents=\"box-none\" on the wrapper around modal children on web', async () => {
        const { BaseModal } = await import('./BaseModal');
        const tree = renderBaseModal(BaseModal);

        const child = tree?.root.findByType('Child' as any);
        const wrapper = (child as any)?.parent;

        expect(wrapper?.type).toBe('div');
        expect(wrapper?.props['data-happy-modal-card-boundary']).toBe('');
    });

    it('dismisses when clicking the centering shell outside the modal card', async () => {
        const { BaseModal } = await import('./BaseModal');

        const onClose = vi.fn();
        const tree = renderBaseModal(BaseModal, { onClose });

        const content = tree?.root.findAllByType('DialogContent' as any)?.[0];
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
            const tree = renderBaseModal(BaseModal);

            expect(bodyStyle.pointerEvents).toBe('auto');

            bodyStyle.pointerEvents = 'none';
            if (observerCallback == null) {
                throw new Error('expected MutationObserver callback');
            }
            (observerCallback as (records: unknown[], observer: unknown) => void)([], {});
            expect(bodyStyle.pointerEvents).toBe('auto');

            act(() => {
                tree?.unmount();
            });

            expect(bodyStyle.pointerEvents).toBe('none');
        } finally {
            (globalThis as any).document = originalDocument;
            (globalThis as any).MutationObserver = originalMutationObserver;
        }
    });

    it('applies zIndexBase to the overlay and content so stacked modals layer correctly', async () => {
        const { BaseModal } = await import('./BaseModal');
        const tree = renderBaseModal(BaseModal, { zIndexBase: 1234 });

        const overlay = tree?.root.findAllByType('DialogOverlay' as any)?.[0];
        const content = tree?.root.findAllByType('DialogContent' as any)?.[0];

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

        renderBaseModal(
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
        const tree = renderBaseModal(BaseModal, { onClose });

        const root = tree?.root.findByType('DialogRoot' as any);
        expect(root?.props.onOpenChange).toBeTypeOf('function');

        act(() => {
            root?.props.onOpenChange(false);
        });

        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
