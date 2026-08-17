import React from 'react';
import { StyleSheet as ReactNativeStyleSheet } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

const reactActEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};

reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const nativeBackState = vi.hoisted(() => {
    let hardwareBackPressHandler: (() => boolean) | null = null;

    return {
        addEventListener: vi.fn((eventName: string, handler: () => boolean) => {
            if (eventName !== 'hardwareBackPress') {
                return { remove: () => {} };
            }

            hardwareBackPressHandler = handler;
            return {
                remove: () => {
                    if (hardwareBackPressHandler === handler) {
                        hardwareBackPressHandler = null;
                    }
                },
            };
        }),
        pressHardwareBack: () => hardwareBackPressHandler?.() ?? false,
    };
});

function flattenStyleProp(styleProp: unknown): Record<string, unknown> {
    const flattened = ReactNativeStyleSheet.flatten(styleProp as never);
    if (!flattened || typeof flattened !== 'object') return {};
    return flattened as Record<string, unknown>;
}

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            OS: 'android',
            select: (options: Record<string, unknown>) => options?.android ?? options?.native ?? options?.default,
        },
        BackHandler: nativeBackState,
    });
});
vi.mock('react-native-safe-area-context', async () => {
    return {
        useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
        initialWindowMetrics: {
            insets: { top: 24, bottom: 16, left: 10, right: 12 },
            frame: { x: 0, y: 0, width: 0, height: 0 },
        },
    };
});

vi.mock('@/components/ui/keyboardAvoidance', () => ({
    KeyboardAwareModalFrame: (props: React.PropsWithChildren<Record<string, unknown>>) =>
        React.createElement('KeyboardAwareModalFrame', props, props.children),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                overlay: {
                    scrimWizard: 'rgba(0,0,0,0.5)',
                },
            },
        },
    });
});

describe('BaseModal (native)', () => {
    it('exposes a named modal-isolated dialog surface', async () => {
        const { BaseModal } = await import('./BaseModal');

        const screen = await renderScreen(
            React.createElement(BaseModal, {
                visible: true,
                accessibilityLabel: 'Move session',
                children: React.createElement('Child'),
            }),
        );

        const modalSurface = screen.findAll((node) => node.props?.role === 'dialog')?.[0];
        expect(modalSurface?.props.accessibilityLabel).toBe('Move session');
        expect(modalSurface?.props.accessibilityViewIsModal).toBe(true);
    });

    it('pads the keyboard-aware modal frame by the safe area insets', async () => {
        const { BaseModal } = await import('./BaseModal');

        const screen = await renderScreen(
            React.createElement(BaseModal, {
                visible: true,
                children: React.createElement('Child'),
            }),
        );

        const container = screen.findAllByType('KeyboardAwareModalFrame' as any)?.[0];
        const style = flattenStyleProp(container?.props?.style);
        expect(style.paddingTop).toBe(24);
        expect(style.paddingRight).toBe(12);
        expect(style.paddingBottom).toBe(16);
        expect(style.paddingLeft).toBe(10);
    });

    it('provides a modal-local overlay portal for popovers opened inside the native modal', async () => {
        const { BaseModal } = await import('./BaseModal');
        const { useOverlayPortal } = await import('@/components/ui/popover');

        function Child() {
            const portal = useOverlayPortal();
            React.useEffect(() => {
                portal?.setPortalNode('inside-modal', React.createElement('PortalChild', { testID: 'inside-modal-popover' }));
                return () => portal?.removePortalNode('inside-modal');
            }, [portal]);
            return React.createElement('Child');
        }

        const screen = await renderScreen(
            React.createElement(BaseModal, {
                visible: true,
                children: React.createElement(Child),
            }),
        );

        expect(screen.findByTestId('inside-modal-popover')).toBeTruthy();
    });

    it('consumes Android hardware Back through the shared dismissal surface', async () => {
        const { BaseModal } = await import('./BaseModal');
        const onClose = vi.fn();

        await renderScreen(
            React.createElement(BaseModal, {
                visible: true,
                onClose,
                children: React.createElement('Child'),
            }),
        );

        expect(nativeBackState.pressHardwareBack()).toBe(true);
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
