import { Modal } from '@/modal';

import { SessionHandoffFailureRecoveryModal } from './SessionHandoffFailureRecoveryModal';
import type { SessionHandoffRecoveryPlan } from '@/sync/domains/sessionHandoff/recoveryPlan';

export async function openSessionHandoffFailureRecoveryModal(params: Readonly<{
    title: string;
    message: string;
    details?: string;
    recovery: SessionHandoffRecoveryPlan;
}>): Promise<'restart_on_source' | 'keep_stopped' | null> {
    return await new Promise((resolve) => {
        Modal.show({
            component: SessionHandoffFailureRecoveryModal,
            closeOnBackdrop: false,
            props: {
                ...params,
                onResolve: resolve,
            },
            onRequestClose: () => resolve(null),
        });
    });
}
