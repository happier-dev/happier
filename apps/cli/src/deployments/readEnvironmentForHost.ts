import type { ActionExecutorContext, DeploymentEnvironmentGetResultV1Schema } from '@happier-dev/protocol';
import { readDeploymentEnvironmentArtifactV1, type DeploymentArtifactDocumentV1 } from '@happier-dev/deployment-protocol';
import { deploymentBackupPolicyV1, type DeploymentBackupPolicyV1 } from '@happier-dev/protocol/deployments/deploymentBackupActionsV1';
import { deploymentBackupTargetOperands, selectDeploymentRuntimeTargetLinkV1 } from '@happier-dev/deployments';

/** One exact selected Environment opener for native preparation and read-only template demand. */
export async function readDeploymentEnvironmentForHost(
    request: Readonly<{ environmentId: string; context: ActionExecutorContext; backupPolicy?: DeploymentBackupPolicyV1 }>,
    host: Readonly<{
        readMetadata(request: Readonly<{ environmentId: string; context: ActionExecutorContext }>):
            Promise<Extract<import('zod/mini').infer<typeof DeploymentEnvironmentGetResultV1Schema>, { ok: true }>>;
        open(artifactId: string, context: ActionExecutorContext): Promise<DeploymentArtifactDocumentV1 | null>;
        assertCurrent(context: ActionExecutorContext): Promise<void>;
    }>,
) {
    const detail = await host.readMetadata(request);
    if (detail.environment.id !== request.environmentId || !detail.environment.capabilities.read) {
        throw Object.assign(new Error('deployment_access_denied'), { code: 'deployment_access_denied' });
    }
    const opened = await host.open(detail.environment.contentArtifactId, request.context);
    const content = readDeploymentEnvironmentArtifactV1(detail.environment, opened);
    if (!content.ok) throw Object.assign(new Error(content.error), { code: content.error });
    await host.assertCurrent(request.context);
    const backup = content.content.backup;
    const backupTarget = request.backupPolicy && backup && !('notNeeded' in backup)
        ? deploymentBackupTargetOperands({ environment: detail.environment,
            runtimeTargetLink: selectDeploymentRuntimeTargetLinkV1({ environment: detail.environment,
                targetLinks: detail.targetLinks.map(targetLink => ({ targetLink })) }) }, backup) : null;
    if (request.backupPolicy && !backupTarget)
        throw Object.assign(new Error('deployment_unavailable'), { code: 'deployment_unavailable' });
    return { environment: detail.environment, content: content.content, targetLinks: detail.targetLinks,
        ...(backupTarget && backup && !('notNeeded' in backup) ? {
            backupTarget: { serverId: detail.environment.serverId, ...backupTarget }, backupPolicy: deploymentBackupPolicyV1(backup),
        } : {}),
        ...(detail.savedSecretRevisions === undefined ? {} : { savedSecretRevisions: detail.savedSecretRevisions }),
        ...(detail.secretScope === undefined ? {} : { secretScope: detail.secretScope }),
        ...(detail.controller ? { controller: detail.controller } : {}) };
}
