import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

const platformState = { os: 'ios' as 'ios' | 'web' };

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
                        get OS() {
                                    return platformState.os;
                                },
                        select: (options: any) => options[platformState.os] ?? options.default,
                    },
                    Alert: {
                        alert: vi.fn(),
                        prompt: vi.fn(),
                    },
                }
    );
});

describe('Modal.prompt', () => {
    beforeEach(() => {
        platformState.os = 'ios';
    });

    it('uses the app modal prompt on iOS (not Alert.prompt)', async () => {
        const { Modal } = await import('./ModalManager');
        const { Alert } = await import('react-native');

        let lastModalConfig: any = null;
        Modal.setFunctions(
            (config) => {
                lastModalConfig = config;
                return 'prompt-1';
            },
            () => {},
            () => {},
        );

        const promise = Modal.prompt('Title', 'Message');

        expect((Alert as any).prompt).not.toHaveBeenCalled();
        expect(lastModalConfig?.type).toBe('prompt');

        Modal.resolvePrompt('prompt-1', 'hello');
        await expect(promise).resolves.toBe('hello');
    });

    it('uses native Alert.alert for iOS confirms', async () => {
        const { Modal } = await import('./ModalManager');
        const { Alert } = await import('react-native');

        const alertSpy = (Alert as any).alert as ReturnType<typeof vi.fn>;
        alertSpy.mockClear();

        const promise = Modal.confirm('Confirm title', 'Confirm message', { confirmText: 'Yes' });

        expect(alertSpy).toHaveBeenCalledTimes(1);
        const confirmCall = alertSpy.mock.calls[0] as any[];
        const buttons = confirmCall[2] as Array<{ onPress?: () => void }>;
        buttons[1]?.onPress?.();

        await expect(promise).resolves.toBe(true);
    });

    it('dismisses an invocation-owned confirmation on iOS when that invocation retires', async () => {
        const { Modal } = await import('./ModalManager');
        const { Alert } = await import('react-native');
        vi.mocked(Alert.alert).mockClear();
        const visible = new Set<string>();
        const unregister = Modal.registerProvider({
            showModal: () => { visible.add('owned-confirm'); return 'owned-confirm'; },
            hideModal: id => { visible.delete(id); },
            hideAllModals: () => { visible.clear(); },
            updateCustomModalProps: () => {},
        });
        const controller = new AbortController();
        try {
            const pending = Modal.confirm('Install agent', '', { confirmText: 'Install', signal: controller.signal });
            expect(Alert.alert).not.toHaveBeenCalled();
            expect(visible.has('owned-confirm')).toBe(true);
            controller.abort();
            await expect(pending).resolves.toBe(false);
            expect(visible.size).toBe(0);
            Modal.resolveConfirm('owned-confirm', true);
        } finally { unregister(); }
    });

    it('does not show an already retired confirmation or dismiss an accepted one on later retirement', async () => {
        const { Modal } = await import('./ModalManager');
        platformState.os = 'web';
        const showModal = vi.fn(() => 'accepted-confirm');
        const hideModal = vi.fn();
        const unregister = Modal.registerProvider({ showModal, hideModal, hideAllModals: () => {}, updateCustomModalProps: () => {} });
        try {
            const retired = new AbortController();
            retired.abort();
            await expect(Modal.confirm('Install agent', '', { signal: retired.signal })).resolves.toBe(false);
            expect(showModal).not.toHaveBeenCalled();
            const controller = new AbortController();
            const pending = Modal.confirm('Install agent', '', { signal: controller.signal });
            Modal.resolveConfirm('accepted-confirm', true);
            await expect(pending).resolves.toBe(true);
            controller.abort();
            expect(hideModal).not.toHaveBeenCalled();
        } finally { unregister(); }
    });

    it('keeps structured irreversible consequences in the app confirmation on iOS', async () => {
        const { Modal } = await import('./ModalManager');
        const { Alert } = await import('react-native');
        vi.mocked(Alert.alert).mockClear();
        let modalType: string | null = null;
        Modal.setFunctions((config) => { modalType = config.type; return 'archive-confirm'; }, () => {}, () => {});
        const promise = Modal.confirm('Archive Team', 'Kept\nLinks stop', {
            messageParagraphs: [{ text: 'Kept' }, { text: 'Links stop', irreversible: true }],
            destructive: true,
        });
        expect(Alert.alert).not.toHaveBeenCalled();
        expect(modalType).toBe('confirm');
        Modal.resolveConfirm('archive-confirm', false);
        await expect(promise).resolves.toBe(false);
    });

    it('uses custom modal alert path on web', async () => {
        platformState.os = 'web';

        const { Modal } = await import('./ModalManager');
        const { Alert } = await import('react-native');

        const alertSpy = (Alert as any).alert as ReturnType<typeof vi.fn>;
        alertSpy.mockClear();

        let modalType: string | null = null;
        Modal.setFunctions(
            (config) => {
                modalType = config.type;
                return 'alert-1';
            },
            () => {},
            () => {},
        );

        Modal.alert('Title', 'Message');

        expect(alertSpy).not.toHaveBeenCalled();
        expect(modalType).toBe('alert');
    });

    it('supports awaiting alerts via alertAsync on web', async () => {
        platformState.os = 'web';

        const { Modal } = await import('./ModalManager');
        const { Alert } = await import('react-native');

        const alertSpy = (Alert as any).alert as ReturnType<typeof vi.fn>;
        alertSpy.mockClear();

        let modalType: string | null = null;
        Modal.setFunctions(
            (config) => {
                modalType = config.type;
                return 'alert-async-1';
            },
            () => {},
            () => {},
        );

        const promise = (Modal as any).alertAsync('Title', 'Message');

        expect(alertSpy).not.toHaveBeenCalled();
        expect(modalType).toBe('alert');

        (Modal as any).resolveAlert('alert-async-1');
        await expect(promise).resolves.toBeUndefined();
    });

    it('supports awaiting alerts via alertAsync on iOS', async () => {
        const { Modal } = await import('./ModalManager');
        const { Alert } = await import('react-native');

        const alertSpy = (Alert as any).alert as ReturnType<typeof vi.fn>;
        alertSpy.mockClear();

        const onPressSpy = vi.fn();
        const promise = (Modal as any).alertAsync('Title', 'Message', [{ text: 'OK', onPress: onPressSpy }]);

        expect(alertSpy).toHaveBeenCalledTimes(1);
        const call = alertSpy.mock.calls[0] as any[];
        const buttons = call[2] as Array<{ onPress?: () => void }>;
        buttons[0]?.onPress?.();

        expect(onPressSpy).toHaveBeenCalledTimes(1);
        await expect(promise).resolves.toBeUndefined();
    });

    it('accepts chrome-backed custom modal props and keeps typed updates intact', async () => {
        const { Modal } = await import('./ModalManager');

        type ChromeModalProps = Readonly<{
            onClose: () => void;
        }> & (Readonly<{ mode: 'label'; label: string }> | Readonly<{ mode: 'count'; count: number }>);

        function ChromeModal(_props: ChromeModalProps) {
            return null;
        }

        let lastConfig: any = null;
        Modal.setFunctions(
            (config) => {
                lastConfig = config;
                return 'chrome-1';
            },
            () => {},
            () => {},
        );

        const modalId = Modal.show({
            component: ChromeModal,
            props: {
                mode: 'label',
                label: 'browse',
            },
            chrome: {
                kind: 'card',
                title: 'Browse provider sessions',
                subtitle: 'Pick a session',
                dimensions: {
                    size: 'lg',
                },
            },
        });

        expect(modalId).toBe('chrome-1');
        expect(lastConfig?.chrome?.kind).toBe('card');
        expect(lastConfig?.chrome?.title).toBe('Browse provider sessions');
        expect(lastConfig?.chrome?.dimensions?.size).toBe('lg');

        Modal.update<ChromeModalProps>(modalId, { label: 'updated' });
        Modal.show({ component: ChromeModal, props: { mode: 'count', count: 2 } });
        expect(lastConfig?.props).toEqual({ mode: 'count', count: 2 });

        // @ts-expect-error -- union arms remain exclusive after removing injected props.
        Modal.update<ChromeModalProps>(modalId, { mode: 'count', label: 'invalid' });

        // @ts-expect-error - invalid props must remain rejected by the type surface.
        Modal.update<ChromeModalProps>(modalId, { missing: true });

        act(() => {});
    });
});
