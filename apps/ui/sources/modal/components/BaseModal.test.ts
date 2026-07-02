import React from 'react';
import { Animated, StyleSheet as ReactNativeStyleSheet } from 'react-native';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { useModalPortalTarget } from '@/modal/portal/ModalPortalTarget';
import { renderScreen } from '@/dev/testkit';
import { installModalComponentCommonModuleMocks } from './modalComponentTestHelpers';

const reactActEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};

reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const localSettingState = vi.hoisted(() => ({
    uiBackdropBlurEnabled: true,
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/state/storage')>();
    return {
        ...actual,
        useLocalSetting: ((name: string) => {
            if (name === 'uiBackdropBlurEnabled') {
                return localSettingState.uiBackdropBlurEnabled;
            }
            return null;
        }) as typeof import('@/sync/domains/state/storage')['useLocalSetting'],
    };
});

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

vi.mock('react-native-keyboard-controller', () => ({
    KeyboardAvoidingView: (props: React.PropsWithChildren<Record<string, unknown>>) =>
        React.createElement('KeyboardAvoidingView', props, props.children),
}));

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

function flattenStyleProp(styleProp: unknown): Record<string, unknown> {
    const flattened = ReactNativeStyleSheet.flatten(styleProp as never);
    if (!flattened || typeof flattened !== 'object') return {};
    return flattened as Record<string, unknown>;
}

function findNodeWithStyle(
    screen: Awaited<ReturnType<typeof renderBaseModalScreen>>,
    predicate: (style: Record<string, unknown>) => boolean,
) {
    return screen.findAll((node) => predicate(flattenStyleProp((node.props as any)?.style)))?.[0];
}

describe('BaseModal (web)', () => {
    it('uses an auto-placement content container (centers when short; top when overflowing)', async () => {
        const { BaseModal } = await import('./BaseModal');
        const screen = await renderBaseModalScreen(BaseModal);

        expect(screen.findAllByType('KeyboardAvoidingView' as any)).toHaveLength(0);
        const container = findNodeWithStyle(screen, (style) => style.minHeight === '100%');
        const style = flattenStyleProp(container?.props?.style);
        expect(style.minHeight).toBe('100%');
        expect(style.justifyContent).toBe('center');
    });

    it('supports a top-aligned web placement mode for fullscreen-like screens nested in the modal shell', async () => {
        const { BaseModal } = await import('./BaseModal');
        const screen = await renderBaseModalScreen(BaseModal, { webPlacement: 'top' });

        expect(screen.findAllByType('KeyboardAvoidingView' as any)).toHaveLength(0);
        const container = findNodeWithStyle(screen, (style) => style.minHeight === '100%');
        const style = flattenStyleProp(container?.props?.style);
        expect(style.minHeight).toBe('100%');
        expect(style.justifyContent).toBe('flex-start');

        const child = screen.findByType('Child' as any);
        const contentWrapper = (child as any)?.parent?.parent;
        const contentStyle = flattenStyleProp(contentWrapper?.props?.style);
        expect(contentStyle.flex).toBe(1);
        expect(contentStyle.alignItems).toBe('stretch');
    });

    it('renders a plain web dialog shell instead of react-native Modal', async () => {
        const { BaseModal } = await import('./BaseModal');
        const screen = await renderBaseModalScreen(BaseModal);

        const dialogShell = screen.findAll((node) => (node.props as any)?.role === 'dialog');
        expect(dialogShell).toHaveLength(1);
        expect((dialogShell[0]?.props as any)?.['aria-modal']).toBe('true');
        expect(screen.findAllByType('RNModal' as any).length).toBe(0);
        expect(screen.findAllByType('DialogRoot' as any).length).toBe(0);
    });

    it('wraps the dialog content in a DismissableLayer Branch (so underlying Vaul/Radix layers don’t dismiss)', async () => {
        const { BaseModal } = await import('./BaseModal');
        const screen = await renderBaseModalScreen(BaseModal);

        expect(screen.findAllByType('DismissableLayerBranch' as any).length).toBe(1);
    });

    it('marks the web portal host as a modal card boundary (so portaled popovers don’t trigger backdrop dismissal)', async () => {
        const { BaseModal } = await import('./BaseModal');
        const screen = await renderBaseModalScreen(BaseModal);

        const portalHosts = screen.findAll((node) => {
            const props = node.props as any;
            return props && typeof props === 'object' && 'data-happy-modal-portal-host' in props;
        });
        expect(portalHosts).toHaveLength(1);
        expect((portalHosts[0] as any).props['data-happy-modal-card-boundary']).toBeDefined();
    });

    it('labels the web dialog shell for accessibility', async () => {
        const { BaseModal } = await import('./BaseModal');
        const screen = await renderBaseModalScreen(BaseModal);

        const dialogShell = screen.findAll((node) => (node.props as any)?.role === 'dialog')?.[0];
        expect((dialogShell?.props as any)?.['aria-label']).toBe('common.dialog');
    });

    it('renders a scrollable modal overlay container so the overlay owns overflow (no nested scroll hosts by default)', async () => {
        const { BaseModal } = await import('./BaseModal');
        const screen = await renderBaseModalScreen(BaseModal);

        const scrollViews = screen.findAllByType('ScrollView' as any);
        expect(scrollViews).toHaveLength(0);

        const dialogShell = screen.findAll((node) => (node.props as any)?.role === 'dialog')?.[0];
        expect((dialogShell?.props as any)?.style?.overflowY).toBe('auto');
    });

    it('omits the overlay when showBackdrop is false', async () => {
        const { BaseModal } = await import('./BaseModal');
        const screen = await renderBaseModalScreen(BaseModal, { showBackdrop: false });

        expect(screen.findAllByType('DialogOverlay' as any).length).toBe(0);
    });

    it('uses a full-opacity themed blurred modal backdrop on web', async () => {
        const { BaseModal } = await import('./BaseModal');
        const screen = await renderBaseModalScreen(BaseModal);

        const overlay = screen.findAll((node) => {
            const style = flattenStyleProp((node.props as any)?.style);
            return style.backdropFilter === 'blur(2px)' || style.WebkitBackdropFilter === 'blur(2px)';
        })?.[0];
        const style = flattenStyleProp((overlay?.props as any)?.style);

        expect(style.WebkitBackdropFilter).toBe('blur(2px)');
        expect(style.backdropFilter).toBe('blur(2px)');
        expect(style.backgroundColor).toBe('rgba(255, 255, 255, 0.52)');
        expect(style.opacity).toBeUndefined();
        expect(String(style.transition)).not.toContain('opacity');
    });

    it('omits backdrop blur styles when blur is disabled in local appearance settings', async () => {
        localSettingState.uiBackdropBlurEnabled = false;
        const { BaseModal } = await import('./BaseModal');
        const screen = await renderBaseModalScreen(BaseModal);

        const overlay = screen.findAll((node) => {
            const style = flattenStyleProp((node.props as any)?.style);
            return style.backgroundColor === 'rgba(255, 255, 255, 0.68)' && style.position === 'fixed';
        })?.[0];
        const style = flattenStyleProp((overlay?.props as any)?.style);
        expect(style.backgroundColor).toBe('rgba(255, 255, 255, 0.68)');
        expect(style.backdropFilter).toBeUndefined();
        expect(style.WebkitBackdropFilter).toBeUndefined();
        expect(String(style.transition ?? '')).not.toContain('backdrop-filter');
        expect(String(style.transition ?? '')).not.toContain('-webkit-backdrop-filter');

        localSettingState.uiBackdropBlurEnabled = true;
    });

    it('keeps transforms off the fixed-position shell while animating an inner content frame', async () => {
        const { BaseModal } = await import('./BaseModal');
        const screen = await renderBaseModalScreen(BaseModal, { showBackdrop: false });

        const dialogShell = screen.findAll((node) => (node.props as any)?.role === 'dialog')?.[0];
        expect(dialogShell).toBeTruthy();
        expect((dialogShell?.props as any)?.style?.transform).toBeUndefined();

        const nodesWithScaleTransform = screen.findAll((node) => {
            const style = (node.props as any)?.style;
            if (!Array.isArray(style)) return false;
            const transformStyle = style.find((entry: any) => entry && typeof entry === 'object' && 'transform' in entry);
            const transform = transformStyle?.transform;
            if (!Array.isArray(transform)) return false;
            return transform.some((entry: any) => entry && typeof entry === 'object' && 'scale' in entry);
        });

        expect(nodesWithScaleTransform.length).toBeGreaterThan(0);
    });

    it('prevents outside dismissal when closeOnBackdrop is false', async () => {
        const { BaseModal } = await import('./BaseModal');
        const onClose = vi.fn();

        const screen = await renderBaseModalScreen(BaseModal, { closeOnBackdrop: false, onClose });

        const dialogShell = screen.findAll((node) => (node.props as any)?.role === 'dialog')?.[0];
        expect((dialogShell?.props as any)?.onClick).toBeTypeOf('function');

        (dialogShell?.props as any)?.onClick({
            target: { closest: () => null },
            currentTarget: {},
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
        });
        expect(onClose).toHaveBeenCalledTimes(0);
    });

    it('dismisses when clicking outside the modal card boundary (backdrop click)', async () => {
        const { BaseModal } = await import('./BaseModal');

        const onClose = vi.fn();
        const screen = await renderBaseModalScreen(BaseModal, { onClose });

        const dialogShell = screen.findAll((node) => (node.props as any)?.role === 'dialog')?.[0];
        expect((dialogShell?.props as any)?.onClick).toBeTypeOf('function');

        const target = { closest: () => null };
        (dialogShell?.props as any)?.onClick({ target, currentTarget: {}, preventDefault: () => {}, stopPropagation: () => {} });

        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('does not dismiss when clicking inside the modal card boundary', async () => {
        const { BaseModal } = await import('./BaseModal');

        const onClose = vi.fn();
        const screen = await renderBaseModalScreen(BaseModal, { onClose });

        const dialogShell = screen.findAll((node) => (node.props as any)?.role === 'dialog')?.[0];
        expect((dialogShell?.props as any)?.onClick).toBeTypeOf('function');

        const currentTarget = {};
        const innerTarget = { closest: () => ({}) };
        (dialogShell?.props as any)?.onClick({ target: innerTarget, currentTarget, preventDefault: () => {}, stopPropagation: () => {} });
        expect(onClose).toHaveBeenCalledTimes(0);
    });

    it('does not rely on pointerEvents=\"box-none\" on the centering container on web', async () => {
        const { BaseModal } = await import('./BaseModal');
        const screen = await renderBaseModalScreen(BaseModal);

        expect(screen.findAllByType('KeyboardAvoidingView' as any)).toHaveLength(0);
        const container = findNodeWithStyle(screen, (style) => style.minHeight === '100%');
        expect(container?.props.pointerEvents).not.toBe('box-none');
    });

    it('does not render an extra DOM wrapper around modal children on web', async () => {
        const { BaseModal } = await import('./BaseModal');
        const screen = await renderBaseModalScreen(BaseModal);

        const child = screen.findByType('Child' as any);
        expect((child as any)?.parent?.type).not.toBe('div');
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
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
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

        const overlay = screen.findAllByType(Animated.View as any)?.[0];
        const dialogShell = screen.findAll((node) => (node.props as any)?.role === 'dialog')?.[0];

        expect(flattenStyleProp(overlay?.props?.style).zIndex).toBe(1234);
        expect((dialogShell?.props as any)?.style?.zIndex).toBe(1235);
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

    it('keeps the portal-host ref callback stable across rerenders (avoids ref/setState loops on web)', async () => {
        const { BaseModal } = await import('./BaseModal');

        const screen = await renderBaseModalScreen(BaseModal);

        const findPortalHost = () => screen.find((node) => {
            return node.type === 'div' && node.props?.['data-happy-modal-portal-host'] !== undefined;
        });

        const host = findPortalHost() as any;
        const initialRef = host?.props?.ref;
        expect(typeof initialRef).toBe('object');

        act(() => {
            screen.tree.update(React.createElement(BaseModal, {
                visible: true,
                showBackdrop: false,
                children: React.createElement('Child'),
            }));
        });

        const hostAfterUpdate = findPortalHost() as any;
        expect(hostAfterUpdate?.props?.ref).toBe(initialRef);
    });

    it('calls onClose when Escape is pressed on web', async () => {
        const { BaseModal } = await import('./BaseModal');
        const onClose = vi.fn();
        const originalDocument = (globalThis as any).document;
        const listeners = new Map<string, ((event: { key: string; preventDefault: () => void; stopPropagation: () => void }) => void)[]>();
        (globalThis as any).document = {
            body: { style: { pointerEvents: 'auto' } },
            activeElement: null,
            addEventListener: (type: string, callback: (event: { key: string; preventDefault: () => void; stopPropagation: () => void }) => void) => {
                listeners.set(type, [...(listeners.get(type) ?? []), callback]);
            },
            removeEventListener: vi.fn(),
        };

        try {
            await renderBaseModalScreen(BaseModal, { onClose });
            act(() => {
                for (const callback of listeners.get('keydown') ?? []) {
                    callback({ key: 'Escape', preventDefault: vi.fn(), stopPropagation: vi.fn() });
                }
            });
        } finally {
            (globalThis as any).document = originalDocument;
        }

        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
