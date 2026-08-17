import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDirectTransferFinalizeRecovery } from '@/sync/domains/transfers/runtime/transferRuntime/plumbing/directTransferFinalizeRecovery';

import { runTransferFinalizeRecovery } from './runTransferFinalizeRecovery';

const modalShowMock = vi.hoisted(() => vi.fn());
const finalizeDirectImportSessionMock = vi.hoisted(() => vi.fn());
const abortPreparedDirectImportSessionViaMachineRpcMock = vi.hoisted(() => vi.fn());

vi.mock('@/modal', () => ({
    Modal: {
        show: (...args: unknown[]) => modalShowMock(...args),
    },
}));

vi.mock('@/sync/domains/transfers/runtime/transferRuntime/plumbing/directTransferImportClient', () => ({
    abortPreparedDirectImportSessionViaMachineRpc: (...args: unknown[]) =>
        abortPreparedDirectImportSessionViaMachineRpcMock(...args),
    DIRECT_IMPORT_FINALIZE_OUTCOME_INDETERMINATE_ERROR_CODE:
        'DIRECT_IMPORT_FINALIZE_OUTCOME_INDETERMINATE',
    DIRECT_IMPORT_REMOTE_COMMITTED_RESULT_UNUSABLE_ERROR_CODE:
        'DIRECT_IMPORT_REMOTE_COMMITTED_RESULT_UNUSABLE',
    finalizeDirectImportSession: (...args: unknown[]) =>
        finalizeDirectImportSessionMock(...args),
    TRANSFER_FINALIZE_RECOVERY_REQUIRED_ERROR_CODE:
        'TRANSFER_FINALIZE_RECOVERY_REQUIRED',
}));

function createRecovery() {
    return createDirectTransferFinalizeRecovery({
        machineId: 'machine-1',
        serverId: 'server-1',
        uploadId: 'upload-1',
        baseUrl: 'https://machine.example.test/direct/imports/upload-1',
        expiresAt: Date.now() + 60_000,
        parseFinalizeResponse: (response) => response.finalized.path,
    });
}

describe('runTransferFinalizeRecovery', () => {
    beforeEach(() => {
        modalShowMock.mockReset();
        finalizeDirectImportSessionMock.mockReset();
        abortPreparedDirectImportSessionViaMachineRpcMock.mockReset();
    });

    it('invokes only the explicitly selected finalize retry action', async () => {
        const invoke = vi.fn(async () => ({ status: 'finalized' as const, response: { ok: true } }));
        modalShowMock.mockImplementationOnce((config) => {
            config.props.onResolve('retry_finalize');
            return 'recovery-modal';
        });

        await expect(runTransferFinalizeRecovery({
            recovery: {
                kind: 'transfer_finalize_recovery',
                expiresAt: Date.now() + 60_000,
                actions: ['retry_finalize', 'discard_staged'],
                isActionable: () => false,
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
            return 'recovery-modal';
        });

        await expect(runTransferFinalizeRecovery({
            recovery: {
                kind: 'transfer_finalize_recovery',
                expiresAt: Date.now() + 60_000,
                actions: ['retry_finalize', 'discard_staged'],
                isActionable: () => false,
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
            .mockImplementationOnce((config) => {
                config.props.onResolve('retry_finalize');
                return 'first-modal';
            })
            .mockImplementationOnce((config) => {
                config.props.onResolve('discard_staged');
                return 'second-modal';
            });

        await expect(runTransferFinalizeRecovery({
            recovery: {
                kind: 'transfer_finalize_recovery',
                expiresAt: Date.now() + 60_000,
                actions: ['retry_finalize', 'discard_staged'],
                isActionable: () => invoke.mock.calls.length < 2,
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

    it('re-presents an indeterminate finalize outcome and waits for another explicit Retry before finalizing', async () => {
        finalizeDirectImportSessionMock
            .mockResolvedValueOnce({
                success: false,
                error: 'Direct import finalize outcome is indeterminate after request issuance',
                errorCode: 'DIRECT_IMPORT_FINALIZE_OUTCOME_INDETERMINATE',
            })
            .mockResolvedValueOnce({
                success: true,
                finalized: {
                    success: true,
                    path: '/repo/file.txt',
                    sizeBytes: 4,
                },
                sha256: 'sha256:finalized',
            });
        let chooseSecondAction!: (action: 'retry_finalize') => void;
        modalShowMock
            .mockImplementationOnce((config) => {
                config.props.onResolve('retry_finalize');
                return 'first-modal';
            })
            .mockImplementationOnce((config) => {
                chooseSecondAction = config.props.onResolve;
                return 'second-modal';
            });
        const recovery = createRecovery();

        const result = runTransferFinalizeRecovery({
            recovery,
            title: 'Upload needs attention',
            message: 'The upload is staged.',
        });
        await vi.waitFor(() => expect(modalShowMock).toHaveBeenCalledTimes(2));

        expect(finalizeDirectImportSessionMock).toHaveBeenCalledTimes(1);
        expect(abortPreparedDirectImportSessionViaMachineRpcMock).not.toHaveBeenCalled();

        chooseSecondAction('retry_finalize');
        await expect(result).resolves.toEqual({
            status: 'finalized',
            response: '/repo/file.txt',
        });
        expect(finalizeDirectImportSessionMock).toHaveBeenCalledTimes(2);
        expect(abortPreparedDirectImportSessionViaMachineRpcMock).not.toHaveBeenCalled();
    });

    it('re-presents a transient discard rejection and waits for another explicit Discard before settling', async () => {
        abortPreparedDirectImportSessionViaMachineRpcMock
            .mockRejectedValueOnce(new Error('transport unavailable'))
            .mockResolvedValueOnce({ aborted: true });
        let chooseSecondAction!: (action: 'discard_staged') => void;
        modalShowMock
            .mockImplementationOnce((config) => {
                config.props.onResolve('discard_staged');
                return 'first-modal';
            })
            .mockImplementationOnce((config) => {
                chooseSecondAction = config.props.onResolve;
                return 'second-modal';
            });
        const recovery = createRecovery();

        const result = runTransferFinalizeRecovery({
            recovery,
            title: 'Upload needs attention',
            message: 'The upload is staged.',
        });
        await vi.waitFor(() => expect(modalShowMock).toHaveBeenCalledTimes(2));

        expect(abortPreparedDirectImportSessionViaMachineRpcMock).toHaveBeenCalledTimes(1);
        expect(finalizeDirectImportSessionMock).not.toHaveBeenCalled();

        chooseSecondAction('discard_staged');
        await expect(result).resolves.toEqual({ status: 'discarded' });
        expect(abortPreparedDirectImportSessionViaMachineRpcMock).toHaveBeenCalledTimes(2);
        expect(finalizeDirectImportSessionMock).not.toHaveBeenCalled();
    });

    it('does not re-present after the daemon authoritatively reports the staged session unavailable', async () => {
        abortPreparedDirectImportSessionViaMachineRpcMock.mockResolvedValueOnce({
            aborted: false,
        });
        modalShowMock.mockImplementationOnce((config) => {
            config.props.onResolve('discard_staged');
            return 'only-modal';
        });
        const recovery = createRecovery();

        await expect(runTransferFinalizeRecovery({
            recovery,
            title: 'Upload needs attention',
            message: 'The upload is staged.',
        })).resolves.toEqual({
            status: 'unavailable',
            reason: 'session_unavailable',
            error: 'The staged upload could not be discarded because its session is unavailable',
        });

        expect(modalShowMock).toHaveBeenCalledTimes(1);
        expect(abortPreparedDirectImportSessionViaMachineRpcMock).toHaveBeenCalledTimes(1);
        expect(finalizeDirectImportSessionMock).not.toHaveBeenCalled();
    });

    it('does not re-present after retry discovers that the staged session is missing or expired', async () => {
        finalizeDirectImportSessionMock.mockRejectedValueOnce(
            new Error('Direct import request failed with status 404'),
        );
        modalShowMock.mockImplementationOnce((config) => {
            config.props.onResolve('retry_finalize');
            return 'only-modal';
        });
        const recovery = createRecovery();

        await expect(runTransferFinalizeRecovery({
            recovery,
            title: 'Upload needs attention',
            message: 'The upload is staged.',
        })).resolves.toEqual({
            status: 'unavailable',
            reason: 'session_unavailable',
            error: 'The staged upload is no longer available',
        });

        expect(modalShowMock).toHaveBeenCalledTimes(1);
        expect(finalizeDirectImportSessionMock).toHaveBeenCalledTimes(1);
        expect(abortPreparedDirectImportSessionViaMachineRpcMock).not.toHaveBeenCalled();
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

        await expect(runTransferFinalizeRecovery({
            recovery: {
                kind: 'transfer_finalize_recovery',
                expiresAt: Date.now() + 60_000,
                actions: ['retry_finalize', 'discard_staged'],
                isActionable: () => false,
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

        await expect(runTransferFinalizeRecovery({
            recovery: {
                kind: 'transfer_finalize_recovery',
                expiresAt: Date.now() + 60_000,
                actions: ['retry_finalize', 'discard_staged'],
                isActionable: () => true,
                invoke,
            },
            title: 'Upload needs attention',
            message: 'The upload is staged.',
        })).resolves.toBeNull();
        expect(modalShowMock).toHaveBeenCalledTimes(2);
        expect(invoke).not.toHaveBeenCalled();
    });
});
