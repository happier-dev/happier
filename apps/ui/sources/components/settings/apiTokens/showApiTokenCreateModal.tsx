import type { CustomModalDismissReason, IModal } from '@/modal';
import { Modal } from '@/modal';
import { t } from '@/text';

import type { ApiTokenSettingsController } from './apiTokenSettingsController';
import { ApiTokenCreateModal } from './ApiTokenCreateModal';

type ApiTokenCreateModalHost = Pick<IModal, 'show' | 'confirm'>;

export function showApiTokenCreateModal(
    controller: ApiTokenSettingsController,
    modal: ApiTokenCreateModalHost = Modal,
): string {
    const confirmRevealDismiss = async (): Promise<boolean> => {
        try {
            return await modal.confirm(
                t('settingsApiTokens.reveal.dismissTitle'),
                t('settingsApiTokens.reveal.dismissBody'),
                {
                    cancelText: t('settingsApiTokens.reveal.copyFirst'),
                    confirmText: t('settingsApiTokens.reveal.savedIt'),
                },
            );
        } catch {
            // The one-time secret warning must never become an inescapable modal if its host fails.
            return true;
        }
    };
    return modal.show({
        component: ApiTokenCreateModal,
        props: { controller },
        closeOnBackdrop: true,
        onDismissRequest: async (reason: CustomModalDismissReason) => await controller.requestRevealDismiss(
            confirmRevealDismiss,
            reason,
        ),
        onHostUnmount: controller.clearReveal,
    });
}
