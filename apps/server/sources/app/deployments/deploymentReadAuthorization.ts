import type { ExternalActionExecutionAuthorizationBindingV1 } from '@happier-dev/protocol/actions/externalActionApi';
import type { DeploymentReadAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import type { DeploymentRestartNativeAdmissionV1, DeploymentRestoreNativeAdmissionV1, DeploymentBackupNativeAdmissionV1 } from '@happier-dev/protocol/deployments/deploymentCandidatePublicationV1';
import { isDeploymentBackupActionIdV1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import type { Tx } from '@/storage/inTx';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import { loadDeploymentEnvironmentInTx } from './deploymentEnvironmentService';
import type { DeploymentAuthentication } from './deploymentAdmission';
import type { DeploymentContentReference } from './deploymentStoredContent';

/** Registry demand selects current metadata only; the Environment remains its private-content authority. */
export async function readRegistryAppUpdateAuthorizationInTx(tx: Tx, binding: ExternalActionExecutionAuthorizationBindingV1,
    authentication: DeploymentAuthentication = {},
): Promise<Readonly<{ environmentIds: readonly string[]; artifactIds: readonly string[] }> | null> {
    const admission = binding.registryAppUpdateAdmission;
    if (!admission || binding.actionId !== 'registries.updates.check' || binding.target.kind !== 'machine'
        || binding.target.machineId !== binding.machineId) return null;
    const rows = await Promise.all(admission.environments.map(async demand => {
        const loaded = await loadDeploymentEnvironmentInTx(tx, binding.accountId, binding.serverIdentityId,
            demand.environmentId, authentication);
        return loaded.ok && !loaded.row.deletedAt && loaded.row.revision === demand.expectedRevision ? loaded.row : null;
    }));
    if (rows.some(row => row === null)) return null;
    return { environmentIds: rows.flatMap(row => row ? [row.id] : []),
        artifactIds: rows.flatMap(row => row ? [row.contentArtifactId] : []) };
}

/** Finite registry work keeps its admitted Environments; only their current Artifact membership is selected here. */
export async function readAdmittedRegistryAppUpdateScopeInTx(tx: Tx,
    admission: NonNullable<ExternalActionExecutionAuthorizationBindingV1['registryAppUpdateAdmission']>,
): Promise<Readonly<{ environmentIds: readonly string[]; artifactContents: readonly DeploymentContentReference[] }>> {
    const environmentIds = admission.environments.map(demand => demand.environmentId);
    const artifactContents: DeploymentContentReference[] = [];
    for (const ids of portableQueryChunks({ values: environmentIds, bindingsPerValue: 1 })) {
        artifactContents.push(...await tx.deploymentEnvironment.findMany({ where: { id: { in: [...ids] } },
            select: { contentArtifactId: true, contentHeaderVersion: true, contentBodyVersion: true } }));
    }
    return { environmentIds, artifactContents };
}

/** Resource reads remain Source-authorized. Native occurrence and private builder custody stay with the installed owner. */
export async function readDeploymentReadAuthorizationInTx(tx: Tx, binding: ExternalActionExecutionAuthorizationBindingV1,
    admission: DeploymentReadAdmissionV1, authentication: DeploymentAuthentication = {},
): Promise<Readonly<{ artifactIds: readonly string[] }> | null> {
    if (admission.actionId !== binding.actionId || binding.target.kind !== 'machine'
        || binding.target.machineId !== binding.machineId || admission.machineId !== binding.machineId
        || admission.actionId !== 'deployments.health.current' && admission.installationId !== binding.installationId) return null;
    const loaded = await loadDeploymentEnvironmentInTx(tx, binding.accountId, binding.serverIdentityId,
        admission.environmentId, authentication);
    if (!loaded.ok) return null;
    return readDeploymentTargetAuthorizationInTx(tx, loaded.row, admission);
}

/** One metadata selector serves read roots and native member admission after Source authority is decided. */
export async function readDeploymentTargetAuthorizationInTx(tx: Tx,
    environment: Readonly<{ id: string; deletedAt: Date | null; runtimeTargetLinkId: string | null;
        controllerMachineId: string | null; revision: number; contentArtifactId: string }>,
    admission: DeploymentReadAdmissionV1 | DeploymentRestartNativeAdmissionV1 | DeploymentRestoreNativeAdmissionV1 | DeploymentBackupNativeAdmissionV1,
): Promise<Readonly<{ artifactIds: readonly string[] }> | null> {
    if (admission.actionId === 'deployments.health.current') {
        const link = await tx.deploymentTargetLink.findFirst({ where: {
            id: admission.targetLinkId, environmentId: environment.id,
        } });
        if (!link || environment.deletedAt || environment.controllerMachineId !== admission.machineId
            || environment.runtimeTargetLinkId !== link.id
            || link.deletedAt || link.detachedAt || link.role !== 'runtime'
            || link.targetKind !== 'ownServer') return null;
        return { artifactIds: [] };
    }
    const [link, receipt] = await Promise.all([
        tx.deploymentTargetLink.findFirst({ where: { id: admission.targetLinkId, environmentId: environment.id },
            include: { machines: true } }),
        tx.deployment.findUnique({ where: { id: admission.deploymentId } }),
    ]);
    if (!link || !receipt || receipt.environmentId !== environment.id || receipt.targetLinkId !== link.id) return null;
    if (admission.actionId !== 'deployments.logs.read') {
        if (environment.deletedAt || environment.runtimeTargetLinkId !== link.id || link.deletedAt || link.detachedAt
            || link.role !== 'runtime' || link.sourceKind !== 'host' || link.targetKind !== 'ownServer'
            || admission.actionId !== 'deployments.backups.restore' && link.activeDeploymentId !== receipt.id
            || !link.machines.some(member => member.machineId === admission.machineId
                && member.installationId === admission.installationId && member.state === 'active')
            || ('expectedRevision' in admission && (admission.actionId === 'deployments.drift.read'
                || admission.actionId === 'deployments.backups.restore' || isDeploymentBackupActionIdV1(admission.actionId)))
                && admission.expectedRevision !== environment.revision) return null;
    }
    if (admission.actionId === 'deployments.backups.restore') {
        const active = link.activeDeploymentId ? await tx.deployment.findFirst({ where: { id: link.activeDeploymentId,
            environmentId: environment.id, targetLinkId: link.id }, select: { contentArtifactId: true } }) : null;
        if (!active) return null;
        return { artifactIds: [environment.contentArtifactId, link.contentArtifactId, receipt.contentArtifactId, active.contentArtifactId] };
    }
    // Historical logs deliberately do not infer captured build placement from
    // today's builder or active head. Their native owner proves that private fact.
    return { artifactIds: [environment.contentArtifactId, link.contentArtifactId, receipt.contentArtifactId] };
}
