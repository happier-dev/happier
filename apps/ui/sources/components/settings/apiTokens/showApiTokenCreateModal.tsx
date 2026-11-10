import type { CustomModalDismissReason, IModal } from '@/modal';
import type { ReactNode } from 'react';
import { Modal } from '@/modal';
import { t } from '@/text';

import type { ApiTokenSettingsController } from './apiTokenSettingsController';
import { ApiTokenCreateModal, type ApiTokenRevealCopy } from './ApiTokenCreateModal';

type ApiTokenCreateModalHost = Pick<IModal, 'show' | 'confirm'>;

export function showApiTokenCreateModal(
    controller: ApiTokenSettingsController,
    modal: ApiTokenCreateModalHost = Modal,
    onHostUnmount?: () => void,
    options?: Readonly<{ revealAccessory?: ReactNode; revealCopy?: ApiTokenRevealCopy }>,
): string {
    return modal.show({
        component: ApiTokenCreateModal,
        props: { controller, ...options },
        closeOnBackdrop: true,
        ...createApiTokenModalLifecycle(controller, modal, onHostUnmount),
    });
}

/** Domain-specific token sheets retain the same one-time reveal dismissal and cleanup. */
export function createApiTokenModalLifecycle(
    controller: ApiTokenSettingsController,
    modal: Pick<IModal, 'confirm'>,
    onHostUnmount?: () => void,
): Readonly<{ onDismissRequest(reason: CustomModalDismissReason): Promise<boolean>; onHostUnmount(): void }> {
    if (!controller.getState().reveal) void controller.refreshEncryptionAvailability();
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
    return {
        onDismissRequest: async (reason: CustomModalDismissReason) => await controller.requestRevealDismiss(
            confirmRevealDismiss,
            reason,
        ),
        onHostUnmount: () => {
            controller.clearReveal();
            onHostUnmount?.();
        },
    };
}

/**
 * Edit an existing token's access in the same modal. Nothing opens when the token is no longer
 * listed; closing without saving discards the edit.
 */
export function showApiTokenEditAccessModal(
    controller: ApiTokenSettingsController,
    tokenId: string,
    modal: Pick<IModal, 'show'> = Modal,
): string | null {
    if (!controller.beginAccessEdit(tokenId)) return null;
    return modal.show({
        component: ApiTokenCreateModal,
        props: { controller, mode: 'editAccess' as const },
        closeOnBackdrop: true,
        onDismissRequest: async () => {
            controller.cancelAccessEdit();
            return true;
        },
        onHostUnmount: controller.cancelAccessEdit,
    });
}
