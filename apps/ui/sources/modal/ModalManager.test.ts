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
            label: string;
            onClose: () => void;
        }>;

        function ChromeModal(props: ChromeModalProps) {
            return React.createElement('ChromeModal', props);
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
                label: 'browse',
            },
            chrome: {
                kind: 'card',
                title: 'Browse provider sessions',
                subtitle: 'Pick a session',
                layout: 'fill',
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

        // @ts-expect-error - invalid props must remain rejected by the type surface.
        Modal.update<ChromeModalProps>(modalId, { missing: true });

        act(() => {});
    });
});
