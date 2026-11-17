import { DeploymentReceiptEventSourceConfigV1ProtocolSchema as source,
    DeploymentReceiptChangedEventV1ProtocolSchema as changed,
    DeploymentReceiptOutcomeEventV1ProtocolSchema as outcome,
    DeploymentReceiptEventSetupV1ProtocolSchema as setup,
    DeploymentFailedEventV1ProtocolSchema as failed, DeploymentRollbackCompletedEventV1ProtocolSchema as rolledBack,
} from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type { ProtocolComposableSchema } from '../protocol/protocolFacade.js';
import type { DeploymentReceiptEventSourceConfigV1, DeploymentReceiptEventSetupV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';

export { DEPLOYMENT_RECEIPT_EVENT_REFS_V1, DEPLOYMENT_RECEIPT_CHANGED_EVENT_REF_V1,
    readDeploymentAccountChangeV1, readDeploymentReceiptEventFailureV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
export { deploymentInProgressStates } from '@happier-dev/protocol/deployments/deploymentStateV1';
export type { DeploymentReceiptEventSourceConfigV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
export const DeploymentReceiptEventSourceConfigV1ProtocolSchema: ProtocolComposableSchema<DeploymentReceiptEventSourceConfigV1> = source;
export const DeploymentReceiptEventSetupV1ProtocolSchema: ProtocolComposableSchema<DeploymentReceiptEventSetupV1> = setup;
export const DeploymentFailedEventV1ProtocolSchema = failed;
export const DeploymentRollbackCompletedEventV1ProtocolSchema = rolledBack;
export const DeploymentReceiptOutcomeEventV1ProtocolSchema = outcome;
export const DeploymentReceiptChangedEventV1ProtocolSchema = changed;

export { DEPLOYMENT_DEPLOY_ACTION_ID_V1, DEPLOYMENT_BACKUP_RUN_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
