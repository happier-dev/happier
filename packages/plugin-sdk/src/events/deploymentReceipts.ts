import { DeploymentReceiptEventSourceConfigV1ProtocolSchema as source,
    DeploymentReceiptOutcomeEventV1ProtocolSchema as outcome,
    DeploymentReceiptEventSetupV1ProtocolSchema as setup,
    DeploymentFailedEventV1ProtocolSchema as failed, DeploymentRollbackCompletedEventV1ProtocolSchema as rolledBack,
} from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type { ProtocolComposableSchema } from '../protocol/protocolFacade.js';
import type { DeploymentReceiptEventSourceConfigV1, DeploymentReceiptEventSetupV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';

export { DEPLOYMENT_RECEIPT_EVENT_REFS_V1, readDeploymentReceiptEventFailureV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
export { deploymentInProgressStates } from '@happier-dev/protocol/deployments/deploymentStateV1';
export type { DeploymentReceiptEventSourceConfigV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
export const DeploymentReceiptEventSourceConfigV1ProtocolSchema: ProtocolComposableSchema<DeploymentReceiptEventSourceConfigV1> = source;
export const DeploymentReceiptEventSetupV1ProtocolSchema: ProtocolComposableSchema<DeploymentReceiptEventSetupV1> = setup;
export const DeploymentFailedEventV1ProtocolSchema = failed;
export const DeploymentRollbackCompletedEventV1ProtocolSchema = rolledBack;
export const DeploymentReceiptOutcomeEventV1ProtocolSchema = outcome;
