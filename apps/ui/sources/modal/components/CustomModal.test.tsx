import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';
import { installModalComponentCommonModuleMocks } from './modalComponentTestHelpers';
import { ModalCardFrame } from './card/ModalCardFrame';
import { useModalCardChrome } from './card/useModalCardChrome';
import type { CustomModalInjectedProps, CustomModalConfig } from '../types';

const reactActEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};

reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

installModalComponentCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            useWindowDimensions: () => ({ width: 1200, height: 760 }),
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    },
});

vi.mock('./BaseModal', () => ({
    BaseModal: ({ children, ...props }: any) => React.createElement('BaseModal', props, children),
}));

function RawModal(props: CustomModalInjectedProps & Readonly<{ label: string }>) {
    return React.createElement('RawModal', props);
}

function ChromeModal(
    props: CustomModalInjectedProps & Readonly<{
        label: string;
    }>,
) {
    return React.createElement('ChromeModal', props);
}

function SelfChromeModal(props: CustomModalInjectedProps & Readonly<{ label: string }>) {
    React.useEffect(() => {
        props.setChrome?.({
            kind: 'card',
            title: 'Self chrome',
            dimensions: { size: 'md' },
        });
    }, [props.setChrome]);
    return React.createElement('SelfChromeModal', props);
}

function PatchChromeModal(props: CustomModalInjectedProps & Readonly<{ label: string }>) {
    React.useLayoutEffect(() => {
        props.setChrome?.({
            kind: 'card',
            footer: React.createElement('PatchedFooter'),
        });
    }, [props.setChrome]);
    return React.createElement('PatchChromeModal', props);
}

function CallbackChromeModal(
    props: CustomModalInjectedProps & Readonly<{ label: string; onAction: () => void }>,
) {
    useModalCardChrome(props.setChrome, React.useMemo(() => ({
        kind: 'card' as const,
        footer: React.createElement('FooterAction', { onPress: props.onAction }),
    }), [props.onAction]));
    return React.createElement('CallbackChromeModal', props);
}

function ViewportMarginChromeModal(
    props: CustomModalInjectedProps & Readonly<{ label: string; verticalMargin: number }>,
) {
    useModalCardChrome(props.setChrome, React.useMemo(() => ({
        kind: 'card' as const,
        title: 'Viewport margin chrome',
        dimensions: {
            size: 'md' as const,
            viewportMargin: { horizontal: 12, vertical: props.verticalMargin },
        },
    }), [props.verticalMargin]));
    return React.createElement('ViewportMarginChromeModal', props);
}

function LegacyOnRequestCloseModal(
    props: CustomModalInjectedProps & Readonly<{ label: string; onRequestClose: () => void }>,
) {
    return React.createElement('LegacyOnRequestCloseModal', props);
}

async function renderCustomModal(config: Omit<CustomModalConfig<any>, 'id'>, onClose = vi.fn()) {
    const { CustomModal } = await import('./CustomModal');
    return renderScreen(React.createElement(CustomModal, { config: { id: 'test-modal', ...config }, onClose, visible: true }));
}

describe('CustomModal', () => {
    it('preserves the raw rendering path when no chrome is requested', async () => {
        const screen = await renderCustomModal({
            type: 'custom',
            component: RawModal,
            props: { label: 'raw' },
        });

        expect(screen.findAllByType(ModalCardFrame as any)).toHaveLength(0);
        expect(screen.findByType('RawModal' as any).props.label).toBe('raw');
        expect(typeof screen.findByType('RawModal' as any).props.onClose).toBe('function');
    });

    it('wraps chrome-backed modals in ModalCardFrame and closes through the shared handler', async () => {
        const onClose = vi.fn();
        const onRequestClose = vi.fn();
        const chromeLeading = React.createElement('ChromeLeading');
        const chromeActions = React.createElement('ChromeActions');
        const chromeFooter = React.createElement('ChromeFooter');

        const screen = await renderCustomModal({
            type: 'custom',
            component: ChromeModal,
            props: {
                label: 'browse',
            },
            onRequestClose,
            chrome: {
                kind: 'card',
                leading: chromeLeading,
                title: 'Browse provider sessions',
                subtitle: 'Pick a session to resume',
                actions: chromeActions,
                footer: chromeFooter,
                closeButtonTestID: 'chrome-close',
                scrollHost: 'body',
                bodyScroll: 'auto',
                dimensions: {
                    size: 'lg',
                },
            },
        }, onClose);

        const modalCardFrame = screen.findByType(ModalCardFrame);

        expect(modalCardFrame.props.leading).toBe(chromeLeading);
        expect(modalCardFrame.props.title).toBe('Browse provider sessions');
        expect(modalCardFrame.props.subtitle).toBe('Pick a session to resume');
        expect(modalCardFrame.props.actions).toBe(chromeActions);
        expect(modalCardFrame.props.footer).toBe(chromeFooter);
        expect(modalCardFrame.props.closeButtonTestID).toBe('chrome-close');
        expect(modalCardFrame.props.scrollHost).toBe('body');
        expect(modalCardFrame.props.bodyScroll).toBe('auto');
        expect(screen.findByType(ChromeModal).props.label).toBe('browse');
        expect(screen.findByType('BaseModal' as any).props.accessibilityLabel).toBe('Browse provider sessions');

        act(() => {
            modalCardFrame.props.onClose();
        });

        expect(onRequestClose).toHaveBeenCalledTimes(1);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('lets a non-dismissible custom modal close only through its component action', async () => {
        const onClose = vi.fn();
        const onRequestClose = vi.fn();
        const screen = await renderCustomModal({
            type: 'custom',
            component: ChromeModal,
            props: { label: 'recovery' },
            dismissible: false,
            onRequestClose,
            chrome: {
                kind: 'card',
                title: 'Recovery required',
                closeButtonTestID: 'recovery-close',
            },
        }, onClose);

        expect(screen.findByType(ModalCardFrame).props.onClose).toBeUndefined();

        act(() => {
            screen.findByType('BaseModal' as any).props.onClose();
        });
        expect(onRequestClose).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();

        act(() => {
            screen.findByType(ChromeModal).props.onClose();
        });
        expect(onRequestClose).not.toHaveBeenCalled();
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('allows custom modals to opt into card chrome dynamically', async () => {
        const screen = await renderCustomModal({
            type: 'custom',
            component: SelfChromeModal,
            props: { label: 'self' },
        });

        const modalCardFrame = screen.findByType(ModalCardFrame);
        expect(modalCardFrame.props.title).toBe('Self chrome');
        expect(modalCardFrame.props.scrollHost).toBeUndefined();
        expect(screen.findByType(SelfChromeModal).props.label).toBe('self');
    });

    it('merges card chrome updates with existing chrome by default', async () => {
        const screen = await renderCustomModal({
            type: 'custom',
            component: PatchChromeModal,
            props: { label: 'patch' },
            chrome: {
                kind: 'card',
                title: 'Base title',
                subtitle: 'Base subtitle',
                actions: React.createElement('BaseActions'),
                testID: 'base-test',
                scrollHost: 'body',
                dimensions: { size: 'lg' },
            },
        });

        const modalCardFrame = screen.findByType(ModalCardFrame);
        expect(modalCardFrame.props.title).toBe('Base title');
        expect(modalCardFrame.props.subtitle).toBe('Base subtitle');
        expect(modalCardFrame.props.actions?.type).toBe('BaseActions');
        expect(modalCardFrame.props.scrollHost).toBe('body');
        expect(modalCardFrame.props.footer?.type).toBe('PatchedFooter');
    });

    it('republishes chrome when only callback props change so footer actions stay fresh', async () => {
        const firstAction = vi.fn();
        const secondAction = vi.fn();
        const { CustomModal } = await import('./CustomModal');

        const screen = await renderScreen(React.createElement(CustomModal, {
            config: {
                id: 'test-modal',
                type: 'custom',
                component: CallbackChromeModal,
                props: {
                    label: 'callback',
                    onAction: firstAction,
                },
            },
            onClose: vi.fn(),
            visible: true,
        }));

        await screen.update(React.createElement(CustomModal, {
            config: {
                id: 'test-modal',
                type: 'custom',
                component: CallbackChromeModal,
                props: {
                    label: 'callback',
                    onAction: secondAction,
                },
            },
            onClose: vi.fn(),
            visible: true,
        }));

        const modalCardFrame = screen.findByType(ModalCardFrame);
        expect(modalCardFrame.props.footer?.props.onPress).toBe(secondAction);
    });

    it('republishes chrome when only viewport margin dimensions change', async () => {
        const { CustomModal } = await import('./CustomModal');
        const onClose = vi.fn();

        const screen = await renderScreen(React.createElement(CustomModal, {
            config: {
                id: 'test-modal',
                type: 'custom',
                component: ViewportMarginChromeModal,
                props: {
                    label: 'viewport',
                    verticalMargin: 12,
                },
            },
            onClose,
            visible: true,
        }));

        await screen.update(React.createElement(CustomModal, {
            config: {
                id: 'test-modal',
                type: 'custom',
                component: ViewportMarginChromeModal,
                props: {
                    label: 'viewport',
                    verticalMargin: 80,
                },
            },
            onClose,
            visible: true,
        }));

        const modalCardFrame = screen.findByType(ModalCardFrame);
        expect(modalCardFrame.props.dimensions).toEqual(expect.objectContaining({
            viewportMargin: { horizontal: 12, vertical: 80 },
        }));
    });

    it('does not invoke legacy `props.onRequestClose` when dismissing', async () => {
        const onClose = vi.fn();
        const onRequestClose = vi.fn();
        const legacyOnRequestClose = vi.fn();

        const screen = await renderCustomModal({
            type: 'custom',
            component: LegacyOnRequestCloseModal,
            props: {
                label: 'legacy',
                onRequestClose: legacyOnRequestClose,
            },
            onRequestClose,
        }, onClose);

        act(() => {
            screen.findByType('BaseModal' as any).props.onClose();
        });

        expect(onRequestClose).toHaveBeenCalledTimes(1);
        expect(legacyOnRequestClose).toHaveBeenCalledTimes(0);
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
