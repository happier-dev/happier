import type { DeploymentEnvironmentDetailV1, DeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol';
import { deploymentRevisionLabelV1 } from '@happier-dev/deployments';
import { DEPLOYMENT_ROLLBACK_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import type { AccountNoticeRecoveryChoiceV1 } from '@happier-dev/protocol/activity/accountNoticeRecoveryV1';

/** The rollout receipt already owns eligibility; notices only serialize its choice. */
export function deploymentNoticeRollbackChoice(environment: DeploymentEnvironmentDetailV1,
    receipt: DeploymentReceiptDetailV1 | undefined): AccountNoticeRecoveryChoiceV1 | null {
    const target = receipt?.content.ownServer?.rollbackTarget;
    if (!target || !receipt) return null;
    const link = environment.targetLinks.find(value => value.targetLink.id === receipt.deployment.targetLinkId)?.targetLink;
    if (!link) return null;
    return { actionId: DEPLOYMENT_ROLLBACK_ACTION_ID_V1, label: `Roll back to ${deploymentRevisionLabelV1(target.revision)}`,
        input: { serverId: environment.environment.serverId, environmentId: environment.environment.id,
            expectedRevision: environment.environment.revision, targetLinkId: link.id, expectedTargetLinkRevision: link.revision,
            requestKey: `notice-rollback:${receipt.deployment.id}`, deploymentId: target.deploymentId,
            contentArtifactId: environment.environment.contentArtifactId,
            contentHeaderVersion: environment.environment.contentHeaderVersion, contentBodyVersion: environment.environment.contentBodyVersion } };
}
