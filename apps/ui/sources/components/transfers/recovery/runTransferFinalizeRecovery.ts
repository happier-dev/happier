import { Modal } from '@/modal';
import type {
    TransferFinalizeRecoveryAction,
    TransferFinalizeRecoveryActionResult,
    TransferFinalizeRecoveryContinuation,
} from '@/sync/domains/transfers/runtime/transferRuntime/plumbing/directTransferFinalizeRecovery';

import { TransferFinalizeRecoveryModal } from './TransferFinalizeRecoveryModal';

const MODAL_HOST_UNMOUNTED = Symbol('transfer-finalize-recovery-modal-host-unmounted');

async function chooseTransferFinalizeRecoveryAction(params: Readonly<{
    title: string;
    message: string;
}>): Promise<
    TransferFinalizeRecoveryAction
    | typeof MODAL_HOST_UNMOUNTED
    | null
> {
    return await new Promise((resolve) => {
        const modalId = Modal.show({
            component: TransferFinalizeRecoveryModal,
            closeOnBackdrop: false,
            dismissible: false,
            onHostUnmount: () => resolve(MODAL_HOST_UNMOUNTED),
            props: {
                title: params.title,
                message: params.message,
                onResolve: resolve,
            },
        });
        if (!modalId) {
            resolve(null);
        }
    });
}

export async function runTransferFinalizeRecovery<TResponse>(params: Readonly<{
    recovery: TransferFinalizeRecoveryContinuation<TResponse>;
    title: string;
    message: string;
}>): Promise<TransferFinalizeRecoveryActionResult<TResponse> | null> {
    while (true) {
        const action = await chooseTransferFinalizeRecoveryAction(params);
        if (!action) return null;
        if (action === MODAL_HOST_UNMOUNTED) continue;
        const result = await params.recovery.invoke(action);
        if (result.status !== 'recovery_required') return result;
    }
}
