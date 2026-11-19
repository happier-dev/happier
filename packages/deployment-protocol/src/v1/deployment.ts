import { z } from 'zod/mini';
import { DeploymentReceiptHeaderV1Schema, DeploymentReceiptMetadataV1Schema, DeploymentReceiptListResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DeploymentStateV1Schema, deploymentInProgressStates, DeploymentStepV1Schema } from '@happier-dev/protocol/deployments/deploymentStateV1';
import { DeploymentContentV1Schema } from '@happier-dev/protocol/deployments/deploymentReceiptContentV1';
import { deploymentStoredContentV1Schema } from './storedContent.js';

export { DeploymentStateV1Schema };
export { deploymentInProgressStates };
export type DeploymentStateV1 = z.infer<typeof DeploymentStateV1Schema>;
/** Receipt-derived presentation facts shared by server publication and client reads. */
export function projectDeploymentReceiptActivityV1(state: DeploymentStateV1): Readonly<{ running: boolean; failed: boolean }> {
    return { running: deploymentInProgressStates().includes(state), failed: state === 'failed' };
}
export { DeploymentSourceIntentV1Schema, DeploymentSourceMethodV1Schema, DeploymentPendingTriggerOccurrenceV1Schema, DeploymentPendingDeployIntentV1Schema, DeploymentPendingDeployV1Schema } from '@happier-dev/protocol/deployments/storedAppInputV1';
export type { DeploymentSourceIntentV1, DeploymentSourceMethodV1, DeploymentPendingTriggerOccurrenceV1,
    DeploymentPendingDeployIntentV1, DeploymentPendingDeployV1 } from '@happier-dev/protocol';
export { DeploymentStepV1Schema };
export type DeploymentStepV1 = z.infer<typeof DeploymentStepV1Schema>;
export { DeploymentReceiptFailureV1Schema, type DeploymentReceiptFailureV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
export {
    DeploymentImageV1Schema,
    type DeploymentImageV1,
    OwnServerDeploymentImageArchiveV1Schema,
    type OwnServerDeploymentImageArchiveV1,
    OwnServerDeploymentSourceV1Schema,
    type OwnServerDeploymentSourceV1,
    OwnServerDeploymentRuntimeProjectionV1Schema,
    type OwnServerDeploymentRuntimeProjectionV1,
    OwnServerDeploymentInputBasisV1Schema,
    type OwnServerDeploymentInputBasisV1,
    DeploymentStageLogsV1Schema,
    type DeploymentStageLogV1,
    OwnServerDeploymentDetailsV1Schema,
    type OwnServerDeploymentDetailsV1,
    DeploymentMachineResultV1Schema,
    type DeploymentMachineResultV1,
    DeploymentOwnServerContentV1Schema,
    type DeploymentOwnServerContentV1,
    DeploymentPlatformProvenanceV1Schema,
    type DeploymentPlatformProvenanceV1,
    DeploymentPlatformContentV1Schema,
    type DeploymentPlatformContentV1,
    DeploymentProviderTeardownContentV1Schema,
    type DeploymentProviderTeardownContentV1,
    DeploymentDataTeardownContentV1Schema,
    type DeploymentDataTeardownContentV1,
    DeploymentContentV1Schema,
    type DeploymentContentV1,
} from '@happier-dev/protocol/deployments/deploymentReceiptContentV1';
export const DeploymentStoredContentV1Schema = deploymentStoredContentV1Schema(DeploymentContentV1Schema);
export type DeploymentStoredContentV1 = z.infer<typeof DeploymentStoredContentV1Schema>;
export const DeploymentV1Schema = z.extend(DeploymentReceiptMetadataV1Schema, {
    content: DeploymentStoredContentV1Schema,
});
export type DeploymentV1 = z.infer<typeof DeploymentV1Schema>;
export { DeploymentReceiptHeaderV1Schema };
export type { DeploymentReceiptHeaderV1 } from '@happier-dev/protocol';
export { DeploymentReceiptListResultV1Schema };
export type DeploymentReceiptListResultV1 = z.infer<typeof DeploymentReceiptListResultV1Schema>;

export function isDeploymentSettledV1(state: DeploymentStateV1): boolean {
    return state === 'succeeded' || state === 'running_unverified' || state === 'failed' || state === 'cancelled';
}

/** Successful settled releases remain rollback sources even without verified health. */
export function isDeploymentRollbackSourceEligibleV1(state: DeploymentStateV1): boolean {
    return state === 'succeeded' || state === 'running_unverified';
}

/** Reconciliation observes unknown effects; settled receipts cannot launch another effect. */
export function canTransitionDeploymentV1(from: DeploymentStateV1, to: DeploymentStateV1): boolean {
    if (from === to) return true;
    if (isDeploymentSettledV1(from)) return false;
    if (from === 'outcome_unknown') return to === 'failed' || to === 'cancelled';
    // A provider build may finish between queued status observations.
    return to !== 'queued';
}
