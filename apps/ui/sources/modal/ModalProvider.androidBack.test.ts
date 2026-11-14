import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const backHandlerHarness = vi.hoisted(() => ({
    emitter: null as null | ReturnType<typeof import('@/dev/testkit/mocks/reactNative').createReactNativeBackHandlerEmitter>,
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock, createReactNativeBackHandlerEmitter } = await import('@/dev/testkit/mocks/reactNative');
    // The factory can run more than once per file; keep one platform boundary instance.
    backHandlerHarness.emitter ??= createReactNativeBackHandlerEmitter();
    return createReactNativeNativeMock({ platformOS: 'android' }, {
        BackHandler: backHandlerHarness.emitter.backHandler,
    });
});

vi.mock('./components/WebPromptModal', () => ({
    WebPromptModal: (props: any) => React.createElement('WebPromptModal', props),
}));

vi.mock('./components/CustomModal', () => {
    const React = require('react');
    return {
        CustomModal: ({ config, onClose, visible }: any) =>
            React.createElement(config.component, { ...(config.props ?? {}), onClose, visible }),
    };
});

function ModalA(_props: { onClose: () => void }) {
    return React.createElement('ModalA');
}

function ModalB(_props: { onClose: () => void }) {
    return React.createElement('ModalB');
}

function backEmitter() {
    const emitter = backHandlerHarness.emitter;
    if (!emitter) throw new Error('BackHandler emitter not installed');
    return emitter;
}

async function renderProvider() {
    const { ModalProvider } = await import('./ModalProvider');
    const { Modal } = await import('./ModalManager');
    const screen = await renderScreen(React.createElement(ModalProvider, { children: React.createElement('App') }));
    return { Modal, screen };
}

function pressBack(): boolean {
    let consumed = false;
    act(() => {
        consumed = backEmitter().press();
    });
    return consumed;
}

describe('ModalProvider Android back', () => {
    afterEach(async () => {
        const { Modal } = await import('./ModalManager');
        Modal.setFunctions(() => 'noop', () => {}, () => {});
    });

    it('leaves back to navigation and holds no listener while no modal is open', async () => {
        await renderProvider();

        expect(backEmitter().getListenerCount()).toBe(0);
        expect(pressBack()).toBe(false);
    });

    it('dismisses the open modal through its close path and consumes back, even when backdrop taps are disabled', async () => {
        const { Modal, screen } = await renderProvider();
        const onRequestClose = vi.fn();
        act(() => {
            Modal.show({ component: ModalA, onRequestClose, closeOnBackdrop: false });
        });

        expect(backEmitter().getListenerCount()).toBe(1);
        expect(pressBack()).toBe(true);

        expect(onRequestClose).toHaveBeenCalledTimes(1);
        expect(screen.findByType(ModalA).props.visible).toBe(false);
        expect(backEmitter().getListenerCount()).toBe(0);
        expect(pressBack()).toBe(false);
    });

    it('closes only the topmost modal per press with a single stack listener', async () => {
        const { Modal, screen } = await renderProvider();
        const onRequestCloseA = vi.fn();
        const onRequestCloseB = vi.fn();
        act(() => {
            Modal.show({ component: ModalA, onRequestClose: onRequestCloseA });
            Modal.show({ component: ModalB, onRequestClose: onRequestCloseB });
        });

        expect(backEmitter().getListenerCount()).toBe(1);
        expect(pressBack()).toBe(true);
        expect(onRequestCloseB).toHaveBeenCalledTimes(1);
        expect(onRequestCloseA).not.toHaveBeenCalled();
        expect(screen.findByType(ModalB).props.visible).toBe(false);
        expect(screen.findByType(ModalA).props.visible).toBe(true);

        expect(pressBack()).toBe(true);
        expect(onRequestCloseA).toHaveBeenCalledTimes(1);
        expect(onRequestCloseB).toHaveBeenCalledTimes(1);
    });

    it('resolves a prompt as cancelled when back dismisses it', async () => {
        const { Modal, screen } = await renderProvider();
        let promise!: Promise<string | null>;
        await act(async () => {
            promise = Modal.prompt('Prompt title');
        });

        expect(pressBack()).toBe(true);
        await expect(promise).resolves.toBeNull();
        expect(screen.findAllByType('WebPromptModal' as any)).toHaveLength(0);
    });
});
