import { projectDeploymentReceiptActivityV1, type DeploymentReceiptHeaderV1 } from '@happier-dev/deployment-protocol/v1';

/** Presentation facts only. Receipt state remains the lifecycle authority. */
export type DeploymentChipV1 = Readonly<{
    environmentId: string;
    deploymentId: string;
    targetLinkId: string;
    actionOperationId: string;
    operation: DeploymentReceiptHeaderV1['operation'];
    state: DeploymentReceiptHeaderV1['state'];
    running: boolean;
    failed: boolean;
}>;

export type DeploymentActivityV1 = Readonly<{ running: boolean; failed: boolean }>;

export { projectDeploymentReceiptActivityV1 };

export function projectDeploymentChipV1(receipt: DeploymentReceiptHeaderV1): DeploymentChipV1 {
    return { environmentId: receipt.environmentId, deploymentId: receipt.id, targetLinkId: receipt.targetLinkId,
        actionOperationId: receipt.actionOperationId, operation: receipt.operation, state: receipt.state,
        ...projectDeploymentReceiptActivityV1(receipt.state) };
}
