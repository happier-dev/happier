import React from 'react';
import { ScrollView, StyleSheet as ReactNativeStyleSheet, Text, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { act } from 'react-test-renderer';
import type { CustomModalInjectedProps } from '../types';
import { BaseModal } from './BaseModal';

const reactActEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};

reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const nativePlatform = vi.hoisted(() => ({ os: 'android' as 'android' | 'ios' }));

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
    // Native ScrollView advertises its orientation even when disabled; model this OS adapter contract.
    const context = React.createContext<{ horizontal: boolean } | null>(null);
    const NativeScrollView = Object.assign(React.forwardRef((props: React.PropsWithChildren<Record<string, unknown>>, ref) =>
        React.createElement('ScrollView', { ...props, ref },
            React.createElement(context.Provider, { value: { horizontal: false } }, props.children))), { Context: context });
    return createReactNativeWebMock({
        ScrollView: NativeScrollView,
        Platform: {
            get OS() { return nativePlatform.os; },
            select: (options: Record<string, unknown>) => options?.[nativePlatform.os] ?? options?.native ?? options?.default,
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

// The native keyboard-controller is the system boundary; keep the modal's real keyboard policy.
vi.mock('react-native-keyboard-controller', () => ({
    KeyboardAvoidingView: (props: React.PropsWithChildren<Record<string, unknown>>) =>
        React.createElement('NativeKeyboardAvoidingView', props, props.children),
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
    it.each(['body', 'overlay'] as const)('advertises only the actual %s scroll owner to native virtualized children', async (scrollHost) => {
        const context = (ScrollView as typeof ScrollView & { Context: React.Context<{ horizontal: boolean } | null> }).Context;
        function CatalogProbe() {
            return React.createElement('CatalogProbe', { scrollContext: React.useContext(context) });
        }
        const screen = await renderScreen(<BaseModal visible scrollHost={scrollHost}><CatalogProbe /></BaseModal>);
        expect(screen.findByType('CatalogProbe').props.scrollContext).toEqual(scrollHost === 'body' ? null : { horizontal: false });
    });
    it.each([['center', 0], ['fullscreen', 16]] as const)('reports the rendered %s viewport without reserving its safe area twice', async (placement, bottomInset) => {
        nativePlatform.os = 'ios';
        const { useModalContentViewport } = await import('../context/ModalBoundaryContext');
        function ViewportProbe() {
            const viewport = useModalContentViewport();
            return <Text>{viewport ? `${viewport.width}x${viewport.height}; bottom=${viewport.bottomInset}` : 'unmeasured'}</Text>;
        }
        const screen = await renderScreen(<BaseModal visible placement={placement}><ViewportProbe /></BaseModal>);
        const scroll = screen.findAll(node => node.props.keyboardShouldPersistTaps === 'handled' && 'contentContainerStyle' in node.props)[0];
        act(() => scroll.props.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 440, height: 860 } } }));
        expect(screen.getTextContent()).toContain(`440x860; bottom=${bottomInset}`);
        act(() => scroll.props.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 440, height: 480 } } }));
        expect(screen.getTextContent()).toContain(`440x480; bottom=${bottomInset}`);
    });
    it('keeps native Back and dialog custody without a motion frame for a stage', async () => {
        const { OverlayMotionFrame } = await import('@/components/ui/overlays/motion/overlayMotion');
        const onClose = vi.fn();
        const screen = await renderScreen(<BaseModal visible motion="none" placement="fullscreen" showBackdrop={false} onClose={onClose}><View /></BaseModal>);
        expect(screen.findAllByType(OverlayMotionFrame)).toHaveLength(0);
        expect(screen.findAll(node => node.props.role === 'dialog').length).toBeGreaterThan(0);
        expect(nativeBackState.pressHardwareBack()).toBe(true);
        expect(onClose).toHaveBeenCalledOnce();
    });
    beforeEach(() => { nativePlatform.os = 'android'; });
    it.each(['android', 'ios'] as const)('retains input custody while its own chrome changes scroll owner on %s', async (platform) => {
        nativePlatform.os = platform;
        const { CustomModal } = await import('./CustomModal');
        const { useModalCardChrome } = await import('./card/useModalCardChrome');
        const retired = vi.fn();
        function InputBody(props: CustomModalInjectedProps) {
            const [draft, setDraft] = React.useState('saved');
            const [card, setCard] = React.useState(true);
            React.useEffect(() => retired, []);
            useModalCardChrome(props.setChrome, React.useMemo(() => card ? {
                kind: 'card' as const, title: 'Inputs', scrollHost: 'body' as const, bodyScroll: 'auto' as const,
            } : null, [card]));
            return React.createElement('InputBody', { value: draft, onChangeText: setDraft, onChromeChange: setCard });
        }
        const screen = await renderScreen(<CustomModal config={{ id: 'input-modal', type: 'custom', component: InputBody }}
            visible onClose={() => {}} />);
        expect(retired).not.toHaveBeenCalled();
        act(() => screen.findByType('InputBody').props.onChangeText('entered'));
        act(() => screen.findByType('InputBody').props.onChromeChange(false));
        expect(screen.findByType('InputBody').props.value).toBe('entered');
        expect(retired).not.toHaveBeenCalled();
        act(() => screen.findByType('InputBody').props.onChromeChange(true));
        expect(screen.findByType('InputBody').props.value).toBe('entered');
        expect(retired).not.toHaveBeenCalled();
        await screen.unmount();
        expect(retired).toHaveBeenCalledOnce();
    });
    it('exposes a named modal-isolated dialog surface', async () => {

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

    it.each([['android', 120], ['android', 1200], ['ios', 120], ['ios', 1200]] as const)(
        'bottom-aligns a %s %i px phone sheet inside its keyboard-resized scroll viewport', async (platform, height) => {
        nativePlatform.os = platform;
        const screen = await renderScreen(
            <BaseModal visible placement="bottom"><View style={{ height }} /></BaseModal>,
        );
        const keyboard = screen.findByType(KeyboardAvoidingView);
        expect(keyboard.props.enabled).toBe(true);
        expect(keyboard.props.behavior).toBe(platform === 'android' ? 'height' : 'padding');
        const scroll = screen.findAll((node) => node.props.keyboardShouldPersistTaps === 'handled' && 'contentContainerStyle' in node.props)[0];
        // flexGrow retains the viewport for short sheets; overflow remains owned by this ScrollView.
        expect(flattenStyleProp(scroll.props.contentContainerStyle)).toMatchObject({ flexGrow: 1, justifyContent: 'flex-end' });
        expect(scroll.props.centerContent).toBe(false);
        expect(flattenStyleProp(scroll.props.style).flex).toBe(1);
    });

    it('keeps centered cards centered instead of applying sheet placement to every modal', async () => {
        const screen = await renderScreen(<BaseModal visible><View style={{ height: 120 }} /></BaseModal>);
        const scroll = screen.findAll((node) => node.props.keyboardShouldPersistTaps === 'handled' && 'contentContainerStyle' in node.props)[0];
        expect(flattenStyleProp(scroll.props.contentContainerStyle).justifyContent).toBe('center');
    });

    it('bottom-aligns a bounded sheet while leaving its body as the sole scroll owner', async () => {
        const screen = await renderScreen(<BaseModal visible placement="bottom" scrollHost="body"><View /></BaseModal>);
        expect(screen.findAll((node) => node.props.keyboardShouldPersistTaps === 'handled')
            .every(node => node.props.scrollEnabled === false)).toBe(true);
        const scroll = screen.findAll((node) => node.props.keyboardShouldPersistTaps === 'handled' && 'contentContainerStyle' in node.props)[0];
        expect(flattenStyleProp(scroll.props.contentContainerStyle)).toMatchObject({ flexGrow: 1, justifyContent: 'flex-end' });
    });

    it('provides a modal-local overlay portal for popovers opened inside the native modal', async () => {
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

    it('leaves the bounded modal body as the only enabled scroll owner', async () => {

        const screen = await renderScreen(
            React.createElement(BaseModal, {
                visible: true,
                scrollHost: 'body',
                children: React.createElement('Child'),
            }),
        );

        expect(screen.findAllByType('ScrollView').every(node => node.props.scrollEnabled === false)).toBe(true);
    });
});
