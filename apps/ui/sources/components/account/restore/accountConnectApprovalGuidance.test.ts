import { describe, expect, it, vi } from 'vitest';

const alertAsyncSpy = vi.hoisted(() => vi.fn());

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { alertAsync: alertAsyncSpy } }).module;
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

describe('account-connect approval guidance', () => {
    it('returns the show-QR recovery action selected through the canonical modal', async () => {
        alertAsyncSpy.mockImplementationOnce(async (_title, _message, buttons) => {
            buttons?.find((button: { text?: string }) => button.text === 'connect.showQrInstead')?.onPress?.();
        });

        const { promptAccountConnectApprovalRequired } = await import('./accountConnectApprovalGuidance');

        await expect(promptAccountConnectApprovalRequired()).resolves.toBe('showQr');
        expect(alertAsyncSpy).toHaveBeenCalledWith(
            'connect.restoreAccount',
            'connect.restoreQrInstructions',
            expect.any(Array),
        );
    });
});
