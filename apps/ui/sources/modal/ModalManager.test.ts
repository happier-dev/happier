import { beforeEach, describe, expect, it, vi } from 'vitest';

const platformState = { os: 'ios' as 'ios' | 'web' };

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('react-native', () => ({
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
}));

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
});
