import { deploymentInProgressStates, type DeploymentStateV1 } from '@happier-dev/deployment-protocol/v1';
import type { DeploymentReadDemandV1 } from './deploymentReadControllerTypes.js';

export function isDeploymentReadDemandActiveV1(demand: DeploymentReadDemandV1): boolean {
    return demand.mounted && demand.visible && demand.focused;
}

export function isDeploymentReceiptObservationEligibleV1(state: DeploymentStateV1): boolean {
    return deploymentInProgressStates().includes(state);
}
