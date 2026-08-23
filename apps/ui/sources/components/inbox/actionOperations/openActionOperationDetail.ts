import { Modal } from '@/modal';
import { t } from '@/text';

import { ActionOperationDetailModal } from './ActionOperationDetailModal';

/** Canonical imperative entrypoint for launcher receipt binding and Inbox row reopen. */
export function openActionOperationDetail(operationId: string): void {
    Modal.show({
        component: ActionOperationDetailModal,
        props: { operationId },
        closeOnBackdrop: true,
        accessibilityLabel: t('inbox.actionOperations.detailAccessibilityLabel'),
    });
}
