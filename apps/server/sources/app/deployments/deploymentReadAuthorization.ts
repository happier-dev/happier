import * as deploymentActionIds from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import * as registryIds from '@happier-dev/protocol/registries/registryActionIdsV1';
import type { ExternalActionExecutionAuthorizationBindingV1 } from '@happier-dev/protocol/actions/externalActionApi';
import type { DeploymentReadAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { ACTION_INVOKE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import type { DeploymentRestartNativeAdmissionV1, DeploymentRestoreNativeAdmissionV1, DeploymentBackupNativeAdmissionV1 } from '@happier-dev/protocol/deployments/deploymentCandidatePublicationV1';
import type { ProjectReadinessActionIdV1 } from '@happier-dev/protocol/actions/projectReadinessActionIdsV1';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { Tx } from '@/storage/inTx';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import { loadDeploymentEnvironmentInTx } from './deploymentEnvironmentService';
import { loadDeploymentTargetRowsInTx, readCurrentManagedDataTargetLinksInTx } from './deploymentTargetLinkService';
import { resolveProjectSourceAccessInTx } from '@/app/projects/sources/projectSourceService';
import type { DeploymentAuthentication } from './deploymentAdmission';
import type { DeploymentContentReference } from './deploymentStoredContent';
import { admitDeploymentStoredContentsInTx } from './deploymentStoredContent';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1, DEPLOYMENT_TARGET_LINK_ARTIFACT_STORED_KIND_V1,
    DEPLOYMENT_RECEIPT_ARTIFACT_STORED_KIND_V1 } from '@happier-dev/protocol';
import type { ProjectSourceOwnerV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';

type DeploymentTargetAuthorization = Readonly<{ ok: true; artifactIds: readonly string[] }>
    | Readonly<{ ok: false; code: 'source_changed' }> | null;

/** Registry demand selects current metadata only; the Environment remains its private-content authority. */
export async function readRegistryAppUpdateAuthorizationInTx(tx: Tx, binding: ExternalActionExecutionAuthorizationBindingV1,
    authentication: DeploymentAuthentication = {},
): Promise<Readonly<{ environmentIds: readonly string[]; artifactIds: readonly string[] }> | null> {
    const admission = binding.registryAppUpdateAdmission;
    if (!admission || binding.actionId !== registryIds.REGISTRY_UPDATES_CHECK_ACTION_ID_V1 || binding.target.kind !== 'machine'
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

/** A finite read spends its signed scope; these reads select content custody, not fresh permission. */
export async function readAdmittedDeploymentReadScopeInTx(tx: Tx,
    admission: Extract<DeploymentReadAdmissionV1, { deploymentId: string }>
        | Extract<DeploymentReadAdmissionV1, { actionId: typeof ACTION_INVOKE_ACTION_ID_V1 }>,
): Promise<Readonly<{ artifactContents: readonly DeploymentContentReference[]; managedControllerMachineId?: string }> | null> {
    const select = { contentArtifactId: true, contentHeaderVersion: true, contentBodyVersion: true } as const;
    if ('action' in admission) {
        const environment = await tx.deploymentEnvironment.findFirst({ where: { id: admission.environmentId,
            revision: admission.expectedRevision, deletedAt: null }, select: { ...select, controllerMachineId: true } });
        const links = environment ? await readCurrentManagedDataTargetLinksInTx(tx, { environmentId: admission.environmentId,
            targetLinkIds: [admission.targetLinkId] }) : null;
        if (!environment || !links || links[0]?.revision !== admission.expectedTargetLinkRevision
            || links[0].pluginId !== admission.action.pluginId) return null;
        const link = await tx.deploymentTargetLink.findFirst({ where: { id: admission.targetLinkId,
            environmentId: admission.environmentId }, select });
        return link ? { artifactContents: [environment, link], managedControllerMachineId: environment.controllerMachineId } : null;
    }
    const [environment, link, receipt] = await Promise.all([
        tx.deploymentEnvironment.findUnique({ where: { id: admission.environmentId }, select }),
        tx.deploymentTargetLink.findFirst({ where: { id: admission.targetLinkId, environmentId: admission.environmentId }, select }),
        tx.deployment.findFirst({ where: { id: admission.deploymentId, environmentId: admission.environmentId,
            targetLinkId: admission.targetLinkId }, select }),
    ]);
    return environment && link && receipt ? { artifactContents: [environment, link, receipt] } : null;
}

/** Resource reads remain Source-authorized. Native occurrence and private builder custody stay with the installed owner. */
export async function readDeploymentReadAuthorizationInTx(tx: Tx, binding: ExternalActionExecutionAuthorizationBindingV1,
    admission: DeploymentReadAdmissionV1, authentication: DeploymentAuthentication = {},
): Promise<DeploymentTargetAuthorization> {
    if ('action' in admission) {
        if (binding.actionId !== admission.actionId || binding.target.kind !== 'machine'
            || binding.target.machineId !== binding.machineId) return null;
        const loaded = await loadDeploymentEnvironmentInTx(tx, binding.accountId, binding.serverIdentityId,
            admission.environmentId, authentication);
        if (!loaded.ok || loaded.row.deletedAt || loaded.row.controllerMachineId !== binding.machineId) return null;
        const controller = await tx.machine.findFirst({ where: { id: binding.machineId,
            installationId: binding.installationId, revokedAt: null, replacedByMachineId: null }, select: { id: true } });
        if (!controller) return null;
        const scope = await readAdmittedDeploymentReadScopeInTx(tx, admission);
        return scope ? { ok: true, artifactIds: scope.artifactContents.map(reference => reference.contentArtifactId) } : null;
    }
    if (admission.actionId !== binding.actionId || binding.target.kind !== 'machine'
        || binding.target.machineId !== binding.machineId || admission.machineId !== binding.machineId
        || 'installationId' in admission && admission.installationId !== binding.installationId) return null;
    if ('projectId' in admission) {
        const source = await resolveProjectSourceAccessInTx(tx, binding.accountId, admission.projectId, authentication);
        if (!source.ok) return null;
        const contents = await Promise.all(admission.environments.map(async demand => {
            const environment = await tx.deploymentEnvironment.findUnique({ where: { id: demand.environmentId } });
            if (!environment || environment.deletedAt || environment.projectSourceId !== admission.projectId
                || environment.controllerMachineId !== admission.machineId || environment.revision !== demand.expectedRevision) return null;
            const links = await loadDeploymentTargetRowsInTx(tx, environment.id);
            const reads = [{ reference: environment, expectedStoredKind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1, access: 'read' as const },
                ...links.map(reference => ({ reference, expectedStoredKind: DEPLOYMENT_TARGET_LINK_ARTIFACT_STORED_KIND_V1, access: 'read' as const }))];
            const failures = await admitDeploymentStoredContentsInTx(tx, binding.accountId, source.owner, reads);
            return failures.some(failure => failure !== null) ? null : reads.map(read => read.reference.contentArtifactId);
        }));
        return contents.some(content => content === null) ? null : { ok: true, artifactIds: contents.flatMap(content => content ?? []) };
    }
    const loaded = await loadDeploymentEnvironmentInTx(tx, binding.accountId, binding.serverIdentityId,
        admission.environmentId, authentication);
    if (!loaded.ok) return null;
    return readDeploymentTargetAuthorizationInTx(tx, loaded.row, admission);
}

/** One metadata selector serves read roots and native member admission after Source authority is decided. */
export async function readDeploymentTargetAuthorizationInTx(tx: Tx,
    environment: Readonly<{ id: string; deletedAt: Date | null; runtimeTargetLinkId: string | null;
        controllerMachineId: string | null; revision: number; contentArtifactId: string;
        contentHeaderVersion: number; contentBodyVersion: number }>,
    admission: Exclude<DeploymentReadAdmissionV1, { actionId: ProjectReadinessActionIdV1 | typeof ACTION_INVOKE_ACTION_ID_V1 }> | DeploymentRestartNativeAdmissionV1
        | DeploymentRestoreNativeAdmissionV1 | Omit<DeploymentRestoreNativeAdmissionV1, 'expectedRevision'> | DeploymentBackupNativeAdmissionV1,
    contentAdmission?: Readonly<{ actorAccountId: string; owner: ProjectSourceOwnerV1 }>,
): Promise<DeploymentTargetAuthorization> {
    const scope = getActionSpec(admission.actionId).deploymentReadScope;
    if (scope?.target === 'current_health') {
        const link = await tx.deploymentTargetLink.findFirst({ where: {
            id: admission.targetLinkId, environmentId: environment.id,
        } });
        if (!link || environment.deletedAt || environment.controllerMachineId !== admission.machineId
            || environment.runtimeTargetLinkId !== link.id
            || link.deletedAt || link.detachedAt || link.role !== 'runtime'
            || link.targetKind !== 'ownServer') return null;
        return { ok: true, artifactIds: [] };
    }
    if (!scope || !('deploymentId' in admission)) return null;
    const [link, receipt] = await Promise.all([
        tx.deploymentTargetLink.findFirst({ where: { id: admission.targetLinkId, environmentId: environment.id },
            include: { machines: true } }),
        tx.deployment.findUnique({ where: { id: admission.deploymentId } }),
    ]);
    const copy = scope.target === 'restore_receipt' && 'source' in admission
        && admission.source.kind === 'repository' && admission.source.origin;
    if (!link || !receipt || !copy && (receipt.environmentId !== environment.id || receipt.targetLinkId !== link.id)) return null;
    if (scope.target !== 'historical_receipt') {
        if (environment.deletedAt || environment.runtimeTargetLinkId !== link.id || link.deletedAt || link.detachedAt
            || link.role !== 'runtime' || link.sourceKind !== 'host' || link.targetKind !== 'ownServer'
            || scope.target !== 'restore_receipt' && link.activeDeploymentId !== receipt.id
            || !copy && !link.machines.some(member => member.machineId === admission.machineId
                && member.installationId === admission.installationId && member.state === 'active')) return null;
    }
    let artifactIds = [environment.contentArtifactId, link.contentArtifactId, receipt.contentArtifactId];
    if (scope.target === 'restore_receipt') {
        const active = link.activeDeploymentId ? await tx.deployment.findFirst({ where: { id: link.activeDeploymentId,
            environmentId: environment.id, targetLinkId: link.id },
            select: { contentArtifactId: true, contentHeaderVersion: true, contentBodyVersion: true } }) : null;
        if (!active) return null;
        if (contentAdmission) {
            const failures = await admitDeploymentStoredContentsInTx(tx, contentAdmission.actorAccountId, contentAdmission.owner, [
                { reference: environment, expectedStoredKind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1, access: 'read' },
                { reference: link, expectedStoredKind: DEPLOYMENT_TARGET_LINK_ARTIFACT_STORED_KIND_V1, access: 'read' },
                ...(copy ? [active] : [receipt, active]).map(reference => ({ reference, expectedStoredKind: DEPLOYMENT_RECEIPT_ARTIFACT_STORED_KIND_V1, access: 'read' as const })),
            ]);
            if (failures.some(failure => failure !== null)) return null;
        }
        artifactIds = [environment.contentArtifactId, link.contentArtifactId,
            ...(copy ? [] : [receipt.contentArtifactId]), active.contentArtifactId];
    }
    // Historical logs deliberately do not infer captured build placement from
    // today's builder or active head. Their native owner proves that private fact.
    if (scope.target !== 'historical_receipt' && 'expectedRevision' in admission && scope.requireEnvironmentRevision
        && admission.expectedRevision !== environment.revision) return { ok: false, code: 'source_changed' };
    return { ok: true, artifactIds };
}

/** An admitted Project read selects current content membership without repeating Source authority. */
export async function readAdmittedProjectReadinessScopeInTx(tx: Tx,
    admission: Extract<DeploymentReadAdmissionV1, { actionId: ProjectReadinessActionIdV1 }>,
): Promise<Readonly<{ artifactContents: readonly DeploymentContentReference[] }>> {
    const artifactContents: DeploymentContentReference[] = [];
    for (const ids of portableQueryChunks({ values: admission.environments.map(item => item.environmentId), bindingsPerValue: 1,
        fixedBindings: 1 })) {
        const environments = await tx.deploymentEnvironment.findMany({ where: { id: { in: [...ids] }, projectSourceId: admission.projectId },
            select: { id: true, contentArtifactId: true, contentHeaderVersion: true, contentBodyVersion: true } });
        artifactContents.push(...environments);
        const links = await tx.deploymentTargetLink.findMany({ where: { environmentId: { in: environments.map(environment => environment.id) } },
            select: { contentArtifactId: true, contentHeaderVersion: true, contentBodyVersion: true } });
        artifactContents.push(...links);
    }
    return { artifactContents };
}
