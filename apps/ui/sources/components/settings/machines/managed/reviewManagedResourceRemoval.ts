import type { ManagedResourceDependencyV1, ManagedResourceDispositionV1 } from '@happier-dev/protocol/machines/managed/managedDependencyV1';

import { Modal, type IModal } from '@/modal';
import { t } from '@/text';

/** Native owners supply non-secret recovery facts and validate these exact expectations on retry. */
export async function reviewManagedResourceRemoval(
    resources: readonly ManagedResourceDependencyV1[],
    modal: Pick<IModal, 'confirm'> = Modal,
): Promise<ManagedResourceDispositionV1[] | null> {
    const dispositions = resources.map((resource): ManagedResourceDispositionV1 => ({
        managedId: resource.managedId,
        expectedIntentRevision: resource.intentRevision,
        expectedAllocation: resource.allocation,
        ...(resource.resource ? { expectedResource: resource.resource } : {}),
        ...(resource.nativeOperationRef ? { expectedNativeOperationRef: resource.nativeOperationRef } : {}),
        ...(resource.recovery ? { expectedRecovery: resource.recovery } : {}),
        responsibility: 'manual',
    }));
    const confirmed = await modal.confirm(
        t('managedCleanup.reviewTitle'),
        `${t('managedCleanup.removalReview')}\n\n${resources.map(resource => JSON.stringify(resource, null, 2)).join('\n\n')}`,
        {
            confirmText: t('managedCleanup.acceptManual'),
            cancelText: t('common.cancel'),
            destructive: true,
        },
    );
    return confirmed ? dispositions : null;
}
