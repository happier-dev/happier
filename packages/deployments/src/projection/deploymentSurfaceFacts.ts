import { projectDeploymentReceiptActivityV1, type DeploymentReceiptHeaderV1 } from '@happier-dev/deployments/contracts/v1';

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

/** Missing counts denote a peer that exposes only the boolean activity projection. */
export type DeploymentActivityV1 = Readonly<{ running: boolean; failed: boolean; attentionCount?: number;
    /** Readable Environments with at least one deploy attempt. */
    environmentCount?: number }>;

export { projectDeploymentReceiptActivityV1 };

export function projectDeploymentChipV1(receipt: DeploymentReceiptHeaderV1): DeploymentChipV1 {
    return { environmentId: receipt.environmentId, deploymentId: receipt.id, targetLinkId: receipt.targetLinkId,
        actionOperationId: receipt.actionOperationId, operation: receipt.operation, state: receipt.state,
        ...projectDeploymentReceiptActivityV1(receipt.state) };
}
