import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';
import { installModalComponentCommonModuleMocks } from './modalComponentTestHelpers';
import { ModalCardFrame } from './card/ModalCardFrame';
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

function DeepEqualChromeModal(props: CustomModalInjectedProps) {
    const renderCountRef = React.useRef(0);
    renderCountRef.current += 1;

    const [step, setStep] = React.useState(0);

    React.useEffect(() => {
        if (step !== 0) return;
        props.setChrome?.({
            kind: 'card',
            title: 'Deep equal chrome',
            dimensions: { size: 'md', width: 560, maxHeightRatio: 0.9 },
        });
        setStep(1);
    }, [props.setChrome, step]);

    React.useEffect(() => {
        if (step !== 1) return;
        props.setChrome?.({
            kind: 'card',
            title: 'Deep equal chrome',
            dimensions: { size: 'md', width: 560, maxHeightRatio: 0.9 },
        });
    }, [props.setChrome, step]);

    return React.createElement('DeepEqualChromeModal', { renderCount: renderCountRef.current });
}

async function renderCustomModal(config: Omit<CustomModalConfig<any>, 'id'>, onClose = vi.fn()) {
    const { CustomModal } = await import('./CustomModal');
    return renderScreen(React.createElement(CustomModal, { config: { id: 'test-modal', ...config }, onClose }));
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
                title: 'Browse provider sessions',
                subtitle: 'Pick a session to resume',
                actions: chromeActions,
                footer: chromeFooter,
                closeButtonTestID: 'chrome-close',
                layout: 'fill',
                dimensions: {
                    size: 'lg',
                },
            },
        }, onClose);

        const modalCardFrame = screen.findByType(ModalCardFrame);

        expect(modalCardFrame.props.title).toBe('Browse provider sessions');
        expect(modalCardFrame.props.subtitle).toBe('Pick a session to resume');
        expect(modalCardFrame.props.actions).toBe(chromeActions);
        expect(modalCardFrame.props.footer).toBe(chromeFooter);
        expect(modalCardFrame.props.closeButtonTestID).toBe('chrome-close');
        expect(modalCardFrame.props.layout).toBe('fill');
        expect(screen.findByType(ChromeModal).props.label).toBe('browse');

        act(() => {
            modalCardFrame.props.onClose();
        });

        expect(onRequestClose).toHaveBeenCalledTimes(1);
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
        expect(modalCardFrame.props.layout).toBe('fit');
        expect(screen.findByType(SelfChromeModal).props.label).toBe('self');
    });

    it('dedupes repeated setChrome calls that are deep-equal (avoids extra rerenders)', async () => {
        const screen = await renderCustomModal({
            type: 'custom',
            component: DeepEqualChromeModal,
            props: {},
        });

        await act(async () => {});

        const modal = screen.findByType('DeepEqualChromeModal' as any);
        expect(modal.props.renderCount).toBe(2);
    });
});
