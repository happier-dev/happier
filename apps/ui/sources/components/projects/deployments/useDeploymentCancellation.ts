import type { DeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol/v1';
import { Modal } from '@/modal';
import { t } from '@/text';
import type { createDeploymentActions } from './deploymentActions';
import type { DeploymentReviewHandle } from './DeploymentEnvironmentDetail';
import { useDeploymentPress } from './deploymentActionOutcome';

/** Receipt and removal recovery share the server's cancellation facts and the same Stop Action. */
export function useDeploymentCancellation(input: Readonly<{
    receipt: DeploymentReceiptDetailV1 | null;
    cancel: ReturnType<typeof createDeploymentActions>['cancel'] | null;
    review: DeploymentReviewHandle;
    onOpenReceipt: (deploymentId: string) => void;
    onRequest?: () => void;
}>) {
    const press = useDeploymentPress(input.review, input.onOpenReceipt);
    const canCancel = input.cancel !== null && input.receipt?.cancellable === true;
    const cancelRequested = press.outcome?.kind === 'receipt' || press.outcome?.kind === 'started';
    const requestCancel = () => {
        const { cancel, receipt } = input;
        if (!cancel || !receipt || !canCancel) return;
        input.onRequest?.();
        void press.press(() => cancel({ environmentId: receipt.deployment.environmentId,
            deploymentId: receipt.deployment.id, expectedReceiptRevision: receipt.deployment.revision }), { openReceipt: false });
    };
    const pressCancel = () => {
        const consequence = input.receipt?.cancellationConsequence;
        if (!consequence) { requestCancel(); return; }
        Modal.alert(t('projects.deployments.receipt.cancelAskTitle'),
            consequence.kind === 'service-down-until-rollback'
                ? t('projects.deployments.receipt.cancelStopped') : t('projects.deployments.receipt.cancelMayStop'), [
                { text: t('projects.deployments.receipt.cancelKeepGoing'), style: 'cancel' },
                { text: t('projects.deployments.receipt.cancelAnyway'), style: 'destructive', onPress: requestCancel },
            ]);
    };
    return { press, canCancel, cancelRequested, pressCancel };
}
