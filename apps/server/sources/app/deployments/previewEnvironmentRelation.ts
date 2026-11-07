import type { DeploymentEnvironmentCreateStorageInputV1 } from '@happier-dev/protocol';
import type { Tx } from '@/storage/inTx';
import { deploymentFailure, type DeploymentAuthentication } from './deploymentAdmission';
import { loadDeploymentEnvironmentInTx, lockDeploymentEnvironmentInTx } from './deploymentEnvironmentService';

/** Prepared child relations derive from the same currently managed template and its saved admission Automation. */
export async function admitPreviewEnvironmentRelationInTx(tx: Tx, actorAccountId: string,
    input: DeploymentEnvironmentCreateStorageInputV1, authentication: DeploymentAuthentication,
) {
    if (input.purpose === 'standard') {
        return input.preview ? deploymentFailure('deployment_invalid') : { ok: true as const, relation: {} };
    }
    const preview = input.preview;
    if (!preview) return deploymentFailure('deployment_invalid');
    await lockDeploymentEnvironmentInTx(tx, preview.templateEnvironmentId);
    const template = await loadDeploymentEnvironmentInTx(tx, actorAccountId, input.serverId,
        preview.templateEnvironmentId, authentication);
    if (!template.ok) return template;
    if (!template.admission.canManage || template.row.deletedAt || template.row.purpose !== 'standard'
        || !template.admission.source.repository
        || template.row.projectSourceId !== input.projectSourceId
        || template.row.revision !== preview.expectedTemplateRevision
        || template.row.runtimeTargetLinkId !== preview.runtimeTargetLinkId) {
        return deploymentFailure('deployment_conflict');
    }
    const link = await tx.deploymentTargetLink.findFirst({ where: { id: preview.runtimeTargetLinkId,
        environmentId: template.row.id, role: 'runtime', deletedAt: null, detachedAt: null }, select: { id: true } });
    if (!link) return deploymentFailure('deployment_conflict');
    const admission = await tx.automation.findFirst({ where: { deploymentEnvironmentId: template.row.id,
        deploymentPreviewRole: 'preview_admission', enabled: true, deletedAt: null }, select: { id: true } });
    if (!admission) return deploymentFailure('deployment_conflict');
    const relation = { previewTemplateEnvironmentId: template.row.id, previewRepositoryId: input.projectSourceId,
        previewPullRequestId: preview.pullRequestId, previewTargetLinkId: link.id };
    const existing = await tx.deploymentEnvironment.findFirst({ where: { ...relation, deletedAt: null }, select: { id: true } });
    return existing ? deploymentFailure('deployment_conflict') : { ok: true as const, relation };
}
