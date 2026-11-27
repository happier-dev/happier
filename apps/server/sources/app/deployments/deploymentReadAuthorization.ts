import * as deploymentActionIds from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import * as registryIds from '@happier-dev/protocol/registries/registryActionIdsV1';
import type { ExternalActionExecutionAuthorizationBindingV1 } from '@happier-dev/protocol/actions/externalActionApi';
import type { DeploymentReadAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { readExternalActionBindingAuthority, type ExternalActionBindingAuthorityV1 } from '@happier-dev/protocol/actions/externalActionBindingAuthority';
import { DatabaseAgentLevelV1Schema } from '@happier-dev/protocol/deployments/deploymentEnvironmentDeployerV1';
import { resolveDatabaseRequesterKindV1, summarizeDatabaseAccessV1 } from '@happier-dev/databases/access';
import { readDeploymentDatabaseReadAccessSetupV1 } from '@happier-dev/protocol/deployments/deploymentReadAdmissionV1';
import { ACTION_INVOKE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import type { DeploymentRestartNativeAdmissionV1, DeploymentRestoreNativeAdmissionV1, DeploymentBackupNativeAdmissionV1 } from '@happier-dev/protocol/deployments/deploymentCandidatePublicationV1';
import type { ProjectReadinessActionIdV1 } from '@happier-dev/protocol/actions/projectReadinessActionIdsV1';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { createDeploymentReadScopeV1 } from '@happier-dev/protocol/actions/specs/deploymentReadScope';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { DATABASE_CAPTURE_CLEAR_ACTION_ID_V1, DATABASE_CAPTURE_STATUS_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIdsDatabaseV1';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import type { Tx } from '@/storage/inTx';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import { loadDeploymentEnvironmentInTx, readDeploymentDatabasePolicyInTx, readDeploymentPreviewTemplateEnvironmentId } from './deploymentEnvironmentService';
import { loadDeploymentTargetRowsInTx, readCurrentManagedDataTargetLinksInTx } from './deploymentTargetLinkService';
import { resolveProjectSourceAccessInTx, resolveProjectSourcesAccessInTx } from '@/app/projects/sources/projectSourceService';
import { canEditDeploymentEnvironmentData, projectDeploymentRuntimeInstallationReplacedFailure, type DeploymentAuthentication } from './deploymentAdmission';
import type { DeploymentContentReference } from './deploymentStoredContent';
import { admitDeploymentStoredContentsInTx } from './deploymentStoredContent';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1, DEPLOYMENT_TARGET_LINK_ARTIFACT_STORED_KIND_V1,
    DEPLOYMENT_RECEIPT_ARTIFACT_STORED_KIND_V1 } from '@happier-dev/protocol';
import type { ProjectSourceOwnerV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { hasDeploymentReceiptContentV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';

type DeploymentTargetAuthorization = Readonly<{ ok: true; artifactIds: readonly string[];
    deploymentDatabaseAccess?: ExternalActionExecutionAuthorizationBindingV1['deploymentDatabaseAccess'];
    deploymentTelemetryRead?: ExternalActionExecutionAuthorizationBindingV1['deploymentTelemetryRead'] }>
    | Readonly<{ ok: false; code: 'source_changed' | 'source_access_denied' }>
    | Readonly<{ ok: false; placement: ActionExecuteFailure }> | null;

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
    admission: Readonly<{ environmentId: string; deploymentId: string; targetLinkId?: string }>
        | Extract<DeploymentReadAdmissionV1, { databaseTarget: unknown }>,
): Promise<Readonly<{ artifactContents: readonly DeploymentContentReference[]; managedControllerMachineId?: string }> | null> {
    const select = { contentArtifactId: true, contentHeaderVersion: true, contentBodyVersion: true } as const;
    const databaseTarget = 'databaseTarget' in admission ? admission.databaseTarget : undefined;
    if ('action' in admission && databaseTarget?.kind === 'managed_deployment') {
        const environment = await tx.deploymentEnvironment.findFirst({ where: { id: admission.environmentId,
            deletedAt: null },
            select: { ...select, controllerMachineId: true } });
        const links = environment ? await readCurrentManagedDataTargetLinksInTx(tx, { environmentId: admission.environmentId,
            targetLinkIds: [admission.targetLinkId] }) : null;
        if (!environment || !links || !links[0]
            || links[0].pluginId !== databaseTarget.contribution.pluginId) return null;
        const link = await tx.deploymentTargetLink.findFirst({ where: { id: admission.targetLinkId,
            environmentId: admission.environmentId }, select: { ...select, contributionLocalId: true } });
        if (!link || link.contributionLocalId !== databaseTarget.contribution.contributionId) return null;
        return { artifactContents: [environment, link], managedControllerMachineId: environment.controllerMachineId };
    }
    const deploymentId = databaseTarget?.kind === 'deployment_service' ? databaseTarget.deploymentId
        : 'deploymentId' in admission ? admission.deploymentId : undefined;
    if (!deploymentId) return null;
    // The exact receipt selects its own link; an omitted id never reaches a lookup (Prisma reads undefined as no filter).
    const [environment, receipt] = await Promise.all([
        tx.deploymentEnvironment.findUnique({ where: { id: admission.environmentId }, select }),
        tx.deployment.findFirst({ where: { id: deploymentId, environmentId: admission.environmentId },
            select: { ...select, targetLinkId: true } }),
    ]);
    if (!environment || !receipt || !hasDeploymentReceiptContentV1(receipt)
        || admission.targetLinkId !== undefined && receipt.targetLinkId !== admission.targetLinkId) return null;
    const link = await tx.deploymentTargetLink.findFirst({ where: { id: receipt.targetLinkId, environmentId: admission.environmentId }, select });
    return link ? { artifactContents: [environment, link, receipt] } : null;
}

/** Resource reads remain Source-authorized. Native occurrence and private builder custody stay with the installed owner. */
export async function readDeploymentReadAuthorizationInTx(tx: Tx, binding: ExternalActionExecutionAuthorizationBindingV1,
    admission: DeploymentReadAdmissionV1, authentication: DeploymentAuthentication = {},
    callerAuthority?: ExternalActionBindingAuthorityV1,
): Promise<DeploymentTargetAuthorization> {
    if ('action' in admission) {
        if (binding.actionId !== admission.actionId || binding.target.kind !== 'machine'
            || binding.target.machineId !== binding.machineId) return null;
        if ('telemetryCollector' in admission) {
            if (admission.telemetryCollector.serverId !== binding.serverIdentityId) return null;
            const { environmentIds } = admission.telemetryCollector;
            const actionId = formatQualifiedPluginActionId(admission.action);
            if (actionId === DATABASE_CAPTURE_CLEAR_ACTION_ID_V1) {
                const [environmentId] = environmentIds;
                if (!environmentId || environmentIds.length !== 1) return null;
                const loaded = await loadDeploymentEnvironmentInTx(tx, binding.accountId, binding.serverIdentityId, environmentId, authentication);
                if (!loaded.ok || loaded.row.deletedAt || loaded.row.telemetryMachineId !== binding.machineId
                    || !loaded.admission.canManage) return { ok: false, code: 'source_access_denied' };
                const row = loaded.row;
                const policy = await readDeploymentDatabasePolicyInTx(tx, row);
                if (!policy) return { ok: false, code: 'source_access_denied' };
                const previewTemplateEnvironmentId = readDeploymentPreviewTemplateEnvironmentId(row);
                return { ok: true, artifactIds: [], deploymentTelemetryRead: [{
                    environmentId, revision: row.revision, capabilities: { metrics: row.telemetryMetricsEnabled,
                        appLlmCost: row.telemetryAppLlmCostEnabled, exceptions: row.telemetryExceptionsEnabled },
                    clearApproval: { purpose: row.purpose, dataAgentAccess: policy.dataAgentAccess,
                        ...(previewTemplateEnvironmentId ? { previewTemplateEnvironmentId } : {}),
                        ...(row.previewCompanionOfEnvironmentId ? { previewCompanionOfEnvironmentId: row.previewCompanionOfEnvironmentId } : {}) },
                }] };
            }
            const includeAssignment = actionId === DATABASE_CAPTURE_STATUS_ACTION_ID_V1;
            const rows = new Map<string, { projectSourceId: string; revision: number; telemetryMetricsEnabled: boolean;
                telemetryAppLlmCostEnabled: boolean; telemetryExceptionsEnabled: boolean; telemetryTokenHash?: string | null }>();
            for (const ids of portableQueryChunks({ values: environmentIds, bindingsPerValue: 1, fixedBindings: 1 })) {
                for (const row of await tx.deploymentEnvironment.findMany({
                    where: { id: { in: [...ids] }, telemetryMachineId: binding.machineId, deletedAt: null },
                    select: { id: true, projectSourceId: true, revision: true, telemetryMetricsEnabled: true,
                        telemetryAppLlmCostEnabled: true, telemetryExceptionsEnabled: true, telemetryTokenHash: includeAssignment },
                })) rows.set(row.id, row);
            }
            if (rows.size !== environmentIds.length) return null;
            // As with the batch Environment access read, R16 resolves each
            // Source once for these Environment rows and keeps a retained Source's authority.
            const sources = await resolveProjectSourcesAccessInTx(tx, binding.accountId,
                [...new Set([...rows.values()].map(row => row.projectSourceId))], authentication, { includeDeleted: true });
            const facts = environmentIds.map(environmentId => {
                const row = rows.get(environmentId);
                if (!row || !sources.get(row.projectSourceId)?.ok) return null;
                return { environmentId, revision: row.revision, capabilities: { metrics: row.telemetryMetricsEnabled,
                    appLlmCost: row.telemetryAppLlmCostEnabled, exceptions: row.telemetryExceptionsEnabled },
                    ...(includeAssignment ? { assignmentStamped: typeof row.telemetryTokenHash === 'string' } : {}) };
            });
            return facts.every(fact => fact !== null) ? { ok: true, artifactIds: [], deploymentTelemetryRead: facts } : null;
        }
        const loaded = await loadDeploymentEnvironmentInTx(tx, binding.accountId, binding.serverIdentityId,
            admission.environmentId, authentication);
        if (!loaded.ok || loaded.row.deletedAt) return null;
        const setup = readDeploymentDatabaseReadAccessSetupV1(admission);
        if (setup && !loaded.admission.canManage) return null;
        let deploymentDatabaseAccess: ExternalActionExecutionAuthorizationBindingV1['deploymentDatabaseAccess'];
        if ('databaseTarget' in admission) {
            const target = admission.databaseTarget;
            if (target.environment.serverId !== binding.serverIdentityId || target.environment.projectSourceId !== loaded.row.projectSourceId
                || target.environment.environmentId !== admission.environmentId || target.targetLinkId !== admission.targetLinkId) return null;
            const policy = await readDeploymentDatabasePolicyInTx(tx, loaded.row);
            const agentLevel = DatabaseAgentLevelV1Schema.safeParse(policy?.dataAgentAccess);
            const requester = resolveDatabaseRequesterKindV1({ agentCaller: false,
                authority: readExternalActionBindingAuthority(binding, callerAuthority) });
            if (!policy || !agentLevel.success || !requester) return null;
            deploymentDatabaseAccess = { agentLevel: agentLevel.data, policyEnvironmentId: policy.id, policyRevision: policy.revision,
                summary: summarizeDatabaseAccessV1({ requester, agentAccess: agentLevel.data,
                    person: { mayWrite: canEditDeploymentEnvironmentData(loaded.admission, policy), editingOff: policy.dataEditorMode === 'off' } }) };
            if (target.kind === 'deployment_service') {
                const selected = await readDeploymentTargetAuthorizationInTx(tx, loaded.row, {
                    actionId: ACTION_INVOKE_ACTION_ID_V1, environmentId: admission.environmentId,
                    deploymentId: target.deploymentId, targetLinkId: target.targetLinkId,
                    machineId: binding.machineId, installationId: binding.installationId,
                }, undefined, binding);
                return selected?.ok ? { ...selected, deploymentDatabaseAccess } : selected;
            }
        }
        if (loaded.row.controllerMachineId !== binding.machineId) return null;
        const controller = await tx.machine.findFirst({ where: { id: binding.machineId,
            installationId: binding.installationId, revokedAt: null, replacedByMachineId: null }, select: { id: true } });
        if (!controller) return null;
        // The Environment database listing reads only this admitted Environment on its controller.
        if ('databaseEnvironment' in admission) return admission.databaseEnvironment.serverId === binding.serverIdentityId
            && admission.databaseEnvironment.projectSourceId === loaded.row.projectSourceId ? { ok: true, artifactIds: [] } : null;
        const scope = await readAdmittedDeploymentReadScopeInTx(tx, admission);
        return scope ? { ok: true, artifactIds: scope.artifactContents.map(reference => reference.contentArtifactId),
            ...(deploymentDatabaseAccess ? { deploymentDatabaseAccess } : {}) } : null;
    }
    if (admission.actionId !== binding.actionId || binding.target.kind !== 'machine'
        || binding.target.machineId !== binding.machineId
        // A compact platform log read names no Machine; an explicit selector must be the executing one.
        || 'machineId' in admission && admission.machineId !== binding.machineId
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
    return readDeploymentTargetAuthorizationInTx(tx, loaded.row, admission, undefined, binding);
}

/** One metadata selector serves read roots and native member admission after Source authority is decided. */
export async function readDeploymentTargetAuthorizationInTx(tx: Tx,
    environment: Readonly<{ id: string; deletedAt: Date | null; runtimeTargetLinkId: string | null;
        controllerMachineId: string | null; revision: number; contentArtifactId: string;
        contentHeaderVersion: number; contentBodyVersion: number }>,
    admission: Exclude<DeploymentReadAdmissionV1, { actionId: ProjectReadinessActionIdV1 | typeof ACTION_INVOKE_ACTION_ID_V1 }> | DeploymentRestartNativeAdmissionV1
        | DeploymentRestoreNativeAdmissionV1 | Omit<DeploymentRestoreNativeAdmissionV1, 'expectedRevision'> | DeploymentBackupNativeAdmissionV1
        | Readonly<{ actionId: typeof ACTION_INVOKE_ACTION_ID_V1 | typeof deploymentActionIds.DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1; environmentId: string; deploymentId: string;
            targetLinkId: string; machineId: string; installationId: string }>,
    contentAdmission?: Readonly<{ actorAccountId: string; owner: ProjectSourceOwnerV1 }>,
    installedMachine?: Readonly<{ machineId: string; installationId: string }>,
    /** The restore mint admitted this installation as the person's own copy restore recipient: it opens its own
     * copy seal of the source backup credential, so it need not be a source member. */
    copySealRecipient?: true,
): Promise<DeploymentTargetAuthorization> {
    const scope = admission.actionId === ACTION_INVOKE_ACTION_ID_V1 ? createDeploymentReadScopeV1()
        : getActionSpec(admission.actionId).deploymentReadScope;
    if (scope?.target === 'current_health') {
        // Home admits who may read this runtime link's health on its controller;
        // the controller's health owner answers what each target kind can report.
        const link = await tx.deploymentTargetLink.findFirst({ where: {
            id: admission.targetLinkId, environmentId: environment.id,
        } });
        if (!link || environment.deletedAt || environment.controllerMachineId !== admission.machineId
            || environment.runtimeTargetLinkId !== link.id
            || link.deletedAt || link.detachedAt || link.role !== 'runtime') return null;
        return { ok: true, artifactIds: [] };
    }
    if (!scope || !('deploymentId' in admission)) return null;
    // An omitted link resolves from the exact receipt; it never reaches a lookup as undefined (a Prisma wildcard).
    const receipt = await tx.deployment.findUnique({ where: { id: admission.deploymentId } });
    const targetLinkId = admission.targetLinkId ?? receipt?.targetLinkId;
    const link = receipt && targetLinkId ? await tx.deploymentTargetLink.findFirst({ where: { id: targetLinkId, environmentId: environment.id },
        include: { machines: true } }) : null;
    const copy = scope.target === 'restore_receipt' && 'source' in admission
        && admission.source.kind === 'repository' && admission.source.origin;
    if (!link || !receipt || !copy && (receipt.environmentId !== environment.id || receipt.targetLinkId !== link.id)) return null;
    if (scope.target !== 'historical_receipt') {
        if (environment.deletedAt || environment.runtimeTargetLinkId !== link.id || link.deletedAt || link.detachedAt
            || link.role !== 'runtime' || link.sourceKind !== 'host' || link.targetKind !== 'ownServer'
            || scope.target !== 'restore_receipt' && link.activeDeploymentId !== receipt.id) return null;
    }
    const receiptContents = !copy && hasDeploymentReceiptContentV1(receipt) ? [receipt] : [];
    if (!copy && !receiptContents.length) return null;
    if (scope.target !== 'historical_receipt' && !copy) {
        const member = link.machines.find(member => member.machineId === admission.machineId && member.state === 'active');
        if (!member) {
            if (!copySealRecipient) return null;
        } else if (member.installationId !== admission.installationId) {
            if (installedMachine?.machineId !== member.machineId || installedMachine.installationId !== admission.installationId) return null;
            return { ok: false, placement: projectDeploymentRuntimeInstallationReplacedFailure({ machineId: member.machineId, retiredInstallationId: member.installationId }) };
        }
    }
    let artifactIds = [environment.contentArtifactId, link.contentArtifactId, ...receiptContents.map(row => row.contentArtifactId)];
    if (scope.target === 'restore_receipt') {
        const active = link.activeDeploymentId ? await tx.deployment.findFirst({ where: { id: link.activeDeploymentId,
            environmentId: environment.id, targetLinkId: link.id },
            select: { contentArtifactId: true, contentHeaderVersion: true, contentBodyVersion: true } }) : null;
        if (!active || !hasDeploymentReceiptContentV1(active)) return null;
        if (contentAdmission) {
            const failures = await admitDeploymentStoredContentsInTx(tx, contentAdmission.actorAccountId, contentAdmission.owner, [
                { reference: environment, expectedStoredKind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1, access: 'read' },
                { reference: link, expectedStoredKind: DEPLOYMENT_TARGET_LINK_ARTIFACT_STORED_KIND_V1, access: 'read' },
                ...[...receiptContents, active].map(reference => ({ reference, expectedStoredKind: DEPLOYMENT_RECEIPT_ARTIFACT_STORED_KIND_V1, access: 'read' as const })),
            ]);
            if (failures.some(failure => failure !== null)) return null;
        }
        artifactIds.push(active.contentArtifactId);
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
