import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { DeploymentReceiptResultV1Schema, DeploymentBackupRestoreResultV1Schema, DeploymentEnvironmentCreateResultV1Schema,
    DeploymentBindingsSetResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1, DEPLOYMENT_DEPLOY_ACTION_ID_V1, DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1,
    DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';

/** Built-in deployment effects use the incumbent immutable Workflow result capture. */
export function prepareWorkflowDeploymentResultCapture(actionId: string): ((output: JsonValue) => JsonValue | undefined) | undefined {
    if (actionId === DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1) return output => {
        const parsed = DeploymentBindingsSetResultV1Schema.safeParse(output);
        return parsed.success && parsed.data.ok ? parsed.data : undefined;
    };
    if (actionId === DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1) return output => {
        const parsed = DeploymentEnvironmentCreateResultV1Schema.safeParse(output);
        return parsed.success && parsed.data.ok ? parsed.data : undefined;
    };
    if (actionId === DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1) return output => {
        const parsed = DeploymentBackupRestoreResultV1Schema.safeParse(output);
        return parsed.success ? parsed.data : undefined;
    };
    if (actionId !== DEPLOYMENT_DEPLOY_ACTION_ID_V1) return;
    return output => {
        const parsed = DeploymentReceiptResultV1Schema.safeParse(output);
        if (!parsed.success || !parsed.data.ok || !('state' in parsed.data)
            || parsed.data.state !== 'succeeded' || !parsed.data.previewCleanup) return;
        return parsed.data;
    };
}
