import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { useModalPortalTarget } from '@/modal/portal/ModalPortalTarget';
import { renderScreen } from '@/dev/testkit';

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

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    class MockAnimatedValue {
        value: number;

        constructor(value: number) {
            this.value = value;
        }

        interpolate(config: Record<string, unknown>) {
            return config;
        }

        setValue(nextValue: number) {
            this.value = nextValue;
        }
    }

    return createReactNativeWebMock(
        {
            View: (props: any) => React.createElement('View', props, props.children),
            TouchableWithoutFeedback: (props: any) => React.createElement('TouchableWithoutFeedback', props, props.children),
            KeyboardAvoidingView: (props: any) => React.createElement('KeyboardAvoidingView', props, props.children),
            Modal: (props: any) => React.createElement('RNModal', props, props.children),
            Animated: {
                Value: MockAnimatedValue,
                timing: () => ({ start: (cb?: () => void) => cb?.() }),
                spring: () => ({ start: (cb?: () => void) => cb?.() }),
                View: (props: any) => React.createElement('AnimatedView', props, props.children),
            },
            Platform: {
                OS: 'web',
                select: (options: any) => options.web ?? options.default,
            },
        }
    );
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

async function renderBaseModalScreen(
    BaseModal: React.ComponentType<any>,
    props: Record<string, unknown> = {},
    options?: Parameters<typeof renderScreen>[1],
) {
    return renderScreen(React.createElement(BaseModal, { visible: true, children: React.createElement('Child'), ...props }), options);
}

async function renderBaseModalTree(
    BaseModal: React.ComponentType<any>,
    props: Record<string, unknown> = {},
    options?: renderer.TestRendererOptions,
) {
    let tree: renderer.ReactTestRenderer | undefined;
    await act(async () => {
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
            const tree = await renderBaseModalTree(BaseModal);

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

        await renderBaseModalTree(
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
