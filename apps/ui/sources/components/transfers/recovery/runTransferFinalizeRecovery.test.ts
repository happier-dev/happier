import { beforeEach, describe, expect, it, vi } from 'vitest';

const modalShowMock = vi.hoisted(() => vi.fn());

vi.mock('@/modal', () => ({
    Modal: {
        show: (...args: unknown[]) => modalShowMock(...args),
    },
}));

describe('runTransferFinalizeRecovery', () => {
    beforeEach(() => {
        modalShowMock.mockReset();
    });

    it('invokes only the explicitly selected finalize retry action', async () => {
        const invoke = vi.fn(async () => ({ status: 'finalized' as const, response: { ok: true } }));
        modalShowMock.mockImplementationOnce((config) => {
            config.props.onResolve('retry_finalize');
        });
        const { runTransferFinalizeRecovery } = await import('./runTransferFinalizeRecovery');

        await expect(runTransferFinalizeRecovery({
            recovery: {
                kind: 'transfer_finalize_recovery',
                expiresAt: Date.now() + 60_000,
                actions: ['retry_finalize', 'discard_staged'],
                invoke,
            },
            title: 'Upload needs attention',
            message: 'The upload is staged.',
        })).resolves.toEqual({ status: 'finalized', response: { ok: true } });

        expect(invoke).toHaveBeenCalledTimes(1);
        expect(invoke).toHaveBeenCalledWith('retry_finalize');
    });

    it('retains invocation-local custody by disabling shared modal dismissal', async () => {
        const invoke = vi.fn(async () => ({ status: 'discarded' as const }));
        modalShowMock.mockImplementationOnce((config) => {
            expect(config.closeOnBackdrop).toBe(false);
            expect(config.dismissible).toBe(false);
            expect(config.onRequestClose).toBeUndefined();
            config.props.onResolve('discard_staged');
        });
        const { runTransferFinalizeRecovery } = await import('./runTransferFinalizeRecovery');

        await expect(runTransferFinalizeRecovery({
            recovery: {
                kind: 'transfer_finalize_recovery',
                expiresAt: Date.now() + 60_000,
                actions: ['retry_finalize', 'discard_staged'],
                invoke,
            },
            title: 'Upload needs attention',
            message: 'The upload is staged.',
        })).resolves.toEqual({ status: 'discarded' });
        expect(invoke).toHaveBeenCalledTimes(1);
        expect(invoke).toHaveBeenCalledWith('discard_staged');
    });

    it('keeps the same continuation actionable after another recovery-required result', async () => {
        const invoke = vi.fn()
            .mockResolvedValueOnce({ status: 'recovery_required', error: 'Still staged' })
            .mockResolvedValueOnce({ status: 'discarded' });
        modalShowMock
            .mockImplementationOnce((config) => config.props.onResolve('retry_finalize'))
            .mockImplementationOnce((config) => config.props.onResolve('discard_staged'));
        const { runTransferFinalizeRecovery } = await import('./runTransferFinalizeRecovery');

        await expect(runTransferFinalizeRecovery({
            recovery: {
                kind: 'transfer_finalize_recovery',
                expiresAt: Date.now() + 60_000,
                actions: ['retry_finalize', 'discard_staged'],
                invoke,
            },
            title: 'Upload needs attention',
            message: 'The upload is staged.',
        })).resolves.toEqual({ status: 'discarded' });
        expect(invoke.mock.calls).toEqual([
            ['retry_finalize'],
            ['discard_staged'],
        ]);
    });

    it('re-presents through restored modal hosts after repeated provider churn and invokes only the eventual explicit action', async () => {
        const invoke = vi.fn(async () => ({ status: 'discarded' as const }));
        modalShowMock
            .mockImplementationOnce((config) => {
                config.onHostUnmount();
                return 'route-modal';
            })
            .mockImplementationOnce((config) => {
                config.onHostUnmount();
                return 'nested-modal';
            })
            .mockImplementationOnce((config) => {
                config.props.onResolve('discard_staged');
                return 'outer-modal';
            });
        const { runTransferFinalizeRecovery } = await import('./runTransferFinalizeRecovery');

        await expect(runTransferFinalizeRecovery({
            recovery: {
                kind: 'transfer_finalize_recovery',
                expiresAt: Date.now() + 60_000,
                actions: ['retry_finalize', 'discard_staged'],
                invoke,
            },
            title: 'Upload needs attention',
            message: 'The upload is staged.',
        })).resolves.toEqual({ status: 'discarded' });

        expect(modalShowMock).toHaveBeenCalledTimes(3);
        expect(invoke).toHaveBeenCalledTimes(1);
        expect(invoke).toHaveBeenCalledWith('discard_staged');
    });

    it('settles without a transfer action when no modal host remains after provider unmount', async () => {
        const invoke = vi.fn();
        modalShowMock
            .mockImplementationOnce((config) => {
                config.onHostUnmount();
                return 'route-modal';
            })
            .mockReturnValueOnce('');
        const { runTransferFinalizeRecovery } = await import('./runTransferFinalizeRecovery');

        await expect(runTransferFinalizeRecovery({
            recovery: {
                kind: 'transfer_finalize_recovery',
                expiresAt: Date.now() + 60_000,
                actions: ['retry_finalize', 'discard_staged'],
                invoke,
            },
            title: 'Upload needs attention',
            message: 'The upload is staged.',
        })).resolves.toBeNull();
        expect(modalShowMock).toHaveBeenCalledTimes(2);
        expect(invoke).not.toHaveBeenCalled();
    });
});
