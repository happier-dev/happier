import { projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { DeploymentEnvironmentDetailV1, DeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol';
import { deploymentRevisionLabelV1, projectDeploymentReceiptSourceFactsV1, projectDeploymentReceiptFactsV1 } from '@happier-dev/deployments';
import { DEPLOYMENT_ROLLBACK_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import type { AccountNoticeRecoveryChoiceV1 } from '@happier-dev/protocol/activity/accountNoticeRecoveryV1';
import { logger } from '@/ui/logger';

/** Share the finite history read with native health admission; no observer or timer is added. */
export async function readDeploymentNoticeHistory(receipts: AsyncIterable<DeploymentReceiptDetailV1> | undefined): Promise<DeploymentReceiptDetailV1[]> {
    const history: DeploymentReceiptDetailV1[] = [];
    try {
        if (receipts) for await (const receipt of receipts) history.push(receipt);
        return history;
    } catch (error) {
        logger.warnLocalFile('[deploymentHealth] Retained history unavailable', {
            failureCause: projectActionFailureCauseV1(error, 'deployment.notice.history', { allowUnknownErrorCode: false }),
        });
        return [];
    }
}

/** The retained-history owner decides eligibility, including already-serving revisions. */
export function deploymentNoticeRollbackChoice(environment: DeploymentEnvironmentDetailV1,
    receipt: DeploymentReceiptDetailV1 | undefined, history: readonly DeploymentReceiptDetailV1[]): AccountNoticeRecoveryChoiceV1 | null {
    const link = environment.targetLinks.find(value => value.targetLink.id === environment.environment.runtimeTargetLinkId)?.targetLink;
    if (!receipt || !link) return null;
    const { retainedRollbackTarget: target } = projectDeploymentReceiptFactsV1(receipt, { receipt: receipt.deployment,
        items: history.map(row => ({ ...row.deployment, source: projectDeploymentReceiptSourceFactsV1(row.content).source })),
        complete: true, runtime: link, targetLinks: environment.targetLinks.map(value => value.targetLink),
        retainPreviousDeployments: environment.content.retainPreviousDeployments });
    if (!target) return null;
    return { actionId: DEPLOYMENT_ROLLBACK_ACTION_ID_V1, label: `Roll back to ${deploymentRevisionLabelV1(target.revision)}`,
        input: { serverId: environment.environment.serverId, environmentId: environment.environment.id,
            expectedRevision: environment.environment.revision, targetLinkId: link.id, expectedTargetLinkRevision: link.revision,
            requestKey: `notice-rollback:${receipt.deployment.id}`, deploymentId: target.deploymentId,
            contentArtifactId: environment.environment.contentArtifactId,
            contentHeaderVersion: environment.environment.contentHeaderVersion, contentBodyVersion: environment.environment.contentBodyVersion } };
}
