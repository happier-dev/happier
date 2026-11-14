import type { readDeploymentEnvironmentForHost } from './readEnvironmentForHost';
import type { WorkflowInvocationListResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import type { z } from 'zod/mini';
import { DeploymentBackupRestoreInputV1Schema, DeploymentBackupRestoreResultV1Schema } from '@happier-dev/protocol/deployments/deploymentBackupRestoreV1';
import { DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1, DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1,
    DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { DeploymentEnvironmentCreateActionInputV1Schema, DeploymentEnvironmentCreateResultV1Schema,
    DeploymentBindingsSetResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DeploymentBindingsPatchInputV1Schema } from '@happier-dev/protocol/deployments/deploymentBindingPatchV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { EnvironmentVariableBindingInputV1 } from '@happier-dev/protocol';
import { readPreviewTemplateNativeDataForHost } from './templates/previewCreate';

/** A later PR event requires the original native copy and companion connection to finish. */
export async function readPreviewCopyReadinessForHost(
    child: Pick<Awaited<ReturnType<typeof readDeploymentEnvironmentForHost>>, 'environment' | 'content'>,
    readInvocations: (input: Readonly<{ runId: string; cursor?: string }>) => Promise<z.infer<typeof WorkflowInvocationListResultV1Schema>>,
    companionChild?: Pick<Awaited<ReturnType<typeof readDeploymentEnvironmentForHost>>, 'environment' | 'content'> | null,
): Promise<boolean> {
    const expected = readPreviewTemplateNativeDataForHost(child.content);
    const runId = child.content.previewCreationRunId;
    if (!runId) return !expected.length && !companionChild;
    if (companionChild && (companionChild.environment.previewCompanionOfEnvironmentId !== child.environment.id
        || companionChild.environment.serverId !== child.environment.serverId)) return false;
    let companionRequired = Boolean(companionChild);
    let companionData: readonly Readonly<{ service: string; database: string }>[] = [];
    let companionBindings: readonly EnvironmentVariableBindingInputV1[] = [];
    const connections: z.infer<typeof DeploymentBindingsPatchInputV1Schema>[] = [];
    const restored = new Set<string>();
    const restoreKey = (environmentId: string, runtimeTargetLinkId: string | undefined, service: string, database: string) =>
        JSON.stringify([environmentId, runtimeTargetLinkId, service, database]);
    let cursor: string | undefined;
    do {
        const page = await readInvocations({ runId, ...(cursor ? { cursor } : {}) });
        for (const invocation of page.invocationDetails ?? []) {
            const execution = invocation.progress.execution;
            if (invocation.index.runId !== runId || execution?.kind !== 'action') continue;
            if (execution.actionId === DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1) {
                const input = DeploymentEnvironmentCreateActionInputV1Schema.safeParse(execution.input);
                if (!input.success || input.data.serverId !== child.environment.serverId) continue;
                const output = DeploymentEnvironmentCreateResultV1Schema.safeParse(execution.output);
                const header = child.environment;
                const mainInput = input.data.purpose === 'preview' && input.data.preview
                    && input.data.preview.templateEnvironmentId === header.previewTemplateEnvironmentId
                    && input.data.preview.pullRequestId === header.previewPullRequestId
                    && input.data.preview.runtimeTargetLinkId === header.previewTargetLinkId;
                if (mainInput && invocation.index.lifecycle !== 'completed') return false;
                if (invocation.index.lifecycle !== 'completed' || !output.success || !output.data.ok) continue;
                if (output.data.environmentId === header.id) companionRequired ||= output.data.previewCompanionRequired === true;
                if (companionChild && input.data.previewCompanionOfEnvironmentId === header.id
                    && output.data.environmentId === companionChild.environment.id
                    && output.data.runtimeTargetLinkId === companionChild.environment.runtimeTargetLinkId) {
                    companionData = output.data.previewNativeData ?? [];
                    companionBindings = output.data.previewNativeBindings ?? [];
                }
                continue;
            }
            if (invocation.index.lifecycle === 'completed' && execution.actionId === DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1) {
                const input = DeploymentBindingsPatchInputV1Schema.safeParse(execution.input);
                const output = DeploymentBindingsSetResultV1Schema.safeParse(execution.output);
                if (input.success && input.data.serverId === child.environment.serverId
                    && input.data.environmentId === child.environment.id && output.success && output.data.ok
                    && output.data.environmentId === child.environment.id) connections.push(input.data);
                continue;
            }
            if (invocation.index.lifecycle !== 'completed' || execution.actionId !== DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1) continue;
            const input = DeploymentBackupRestoreInputV1Schema.safeParse(execution.input);
            const output = DeploymentBackupRestoreResultV1Schema.safeParse(execution.output);
            if (!input.success || input.data.mode !== 'confirm'
                || input.data.source.kind !== 'repository' || !input.data.source.origin
                || input.data.destination?.kind !== 'database' || !output.success
                || output.data.kind !== 'restored' || input.data.serverId !== child.environment.serverId) continue;
            const destination = input.data.destination;
            restored.add(restoreKey(input.data.environmentId, input.data.targetLinkId, destination.service, destination.database));
        }
        cursor = page.nextCursor;
    } while (cursor);
    if (companionRequired && (!companionChild || !companionData.length || !companionBindings.length
        || !connections.some(connection => companionBindings.every(expected =>
            connection.set.some(binding => sameStrictJsonValue(binding, expected)))))) return false;
    return expected.every(target => restored.has(restoreKey(child.environment.id, child.environment.runtimeTargetLinkId, target.service, target.database)))
        && companionData.every(target => restored.has(restoreKey(companionChild!.environment.id,
            companionChild!.environment.runtimeTargetLinkId, target.service, target.database)));
}
