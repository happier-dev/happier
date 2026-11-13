import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import * as deploymentActionIds from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import * as managedIds from '@happier-dev/protocol/machines/managed/actionIdsV1';
import * as sourceActionIds from '@happier-dev/protocol/actions/specs/projectSourcesActionIdsV1';
import { DeploymentApprovalEnvironmentInputV1Schema } from '@happier-dev/protocol/deployments/deploymentApprovalScopeV1';
import { z } from '@happier-dev/protocol/zodRuntimePolicy';
import { lazyZodSchema } from '@happier-dev/protocol/lazyZodSchema';
import { DeploymentEnvironmentCreateInputV1Schema } from '@happier-dev/protocol/deployments/deploymentEnvironmentCreateV1';
import { DeploymentEnvironmentUpdateInputV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { deploymentPreparationOperationForActionV1, type ExternalActionExecutionAuthorizationBindingV1,
    type DeploymentPreparationAdmissionV1, type ReviewedActionChildHttpProofV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { ManagedControlAdmissionInputV1Schema, ManagedListInputV1Schema,
    managedMachineActionEndpointPathV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { Tx } from '@/storage/inTx';
import { readProjectSourceOwnerInTx, readProjectSourceCustodyInTx, resolveProjectSourceAccessInTx, canManageProjectSourceOwnerInTx } from '@/app/projects/sources/projectSourceService';
import { MACHINE_SERVICE_ADOPT_ACTION_ID, MACHINE_SERVICE_ADOPT_CREATE_ROLE_V1,
    MACHINE_SERVICE_ADOPT_BINDINGS_ROLE_V1 } from '@happier-dev/protocol/local/services/actionIdsV1';
import { loadDeploymentEnvironmentInTx, lockDeploymentEnvironmentInTx, readCreatedDeploymentEnvironmentIdInTx,
    type DeploymentEnvironmentRow } from './deploymentEnvironmentService';
import { admitDeploymentMachineInTx, type DeploymentAuthentication } from './deploymentAdmission';
import { readPreviewCompanionMainInTx } from './previewEnvironmentRelation';
import { DeploymentDomainAddAdmissionInputV1Schema, DeploymentEnvironmentCreateStorageInputV1Schema, DeploymentTargetLinkInputV1Schema,
    DeploymentDeployAdmissionInputV1Schema, DeploymentEnvironmentGetInputV1Schema, DeploymentEnvironmentListInputV1Schema, DeploymentDomainCapturedPlacementsV1Schema,
    DeploymentTargetLinksListInputV1Schema,
    ArtifactJsonCreateHttpInputV1Schema, ArtifactJsonUpdateHttpInputV1Schema, DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1,
    DEPLOYMENT_RECEIPT_ARTIFACT_STORED_KIND_V1,
    DEPLOYMENT_TARGET_LINK_ARTIFACT_STORED_KIND_V1, hasDeploymentEnvironmentContentPatchV1 } from '@happier-dev/protocol';
import { deploymentOperationForRootActionV1, deploymentChildEffectActionIdForRootV1 } from '@happier-dev/protocol';
import { DEPLOYMENT_DEPLOY_ACTION_ID_V1, DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1,
    DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1, DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1, DEPLOYMENT_PUBLISH_PREPARE_ACTION_ID_V1,
    DEPLOYMENT_BACKUP_CONFIGURE_ACTION_ID_V1, DEPLOYMENT_BACKUP_PRUNE_ACTION_ID_V1, DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1,
    DEPLOYMENT_ENVIRONMENT_MOVE_TO_REPOSITORY_ACTION_ID_V1, DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1, DEPLOYMENT_ENVIRONMENT_LIST_ACTION_ID_V1,
    DEPLOYMENT_PREPARATION_READ_ACTION_IDS_V1, isDeploymentDomainAddActionIdV1,
    isDeploymentDomainMetadataReadActionIdV1, isDeploymentMembershipActionIdV1,
    isDeploymentReceiptReadActionIdV1,
    type DeploymentDomainMetadataReadActionIdV1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { createDeploymentCandidatePublicationV1, createDeploymentLinkContentArtifactIdV1,
    createDeploymentDomainContentArtifactIdV1, isDeploymentDomainNativeAdmissionV1,
    createDeploymentEnvironmentContentArtifactIdV1, isDeploymentEnvironmentUpdateNativeAdmissionV1, isDeploymentBackupConfigureNativeAdmissionV1,
    computeDeploymentEnvironmentUpdateInputDigestV1, computeDeploymentEnvironmentUpdateMetadataDigestV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { DEPLOYMENT_DOMAIN_ARTIFACT_STORED_KIND_V1 } from '@happier-dev/protocol/artifacts/deploymentArtifactKindsV1';
import { DeploymentEnvironmentTemplateSetInputV1Schema, DeploymentBindingsSetStorageInputV1Schema,
    DeploymentEnvironmentUpdateStorageInputV1Schema, DeploymentEnvironmentBackupSetInputV1Schema, EnvironmentSecretLaunchAdmissionInputV1Schema,
    EnvironmentSecretAdmissionRequestV1Schema, getDeploymentTargetLinkLineageV1 } from '@happier-dev/deployment-protocol';
import { ProjectAccountRowReadRequestV1Schema, ProjectAccountRowListRequestV1Schema, ProjectAccountRowMutationRequestV1Schema,
    PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { PROJECT_SOURCE_READ_ACTION_ID_V1, PROJECT_SOURCE_UPDATE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/specs/projectSourcesActionIdsV1';
import { ProjectSourcesReadInputV1Schema, ProjectSourcesUpdateInputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';

import { DeploymentEnvironmentContentCasV1Schema } from '@happier-dev/protocol/deployments/deploymentArtifactContentReferenceV1';
import type { ProjectSourceOwnerV1, ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { readProjectDeploymentDefaultsContentInTx } from '@/app/projects/projectDeploymentDefaultsService';
import { readArtifactAccessGrantsForAdmittedCustodyInTx,
    type ArtifactMutationTransactionGuard } from '@/app/artifacts/artifactAccessService';
import { ArtifactAccessGrantSetInputV1Schema, ArtifactRecipientKeyEnvelopeCommitInputV1Schema,
    type ArtifactAccessGrantSetInputV1 } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { deploymentTargetLinkInventoryWhere } from './deploymentTargetLinkReadService';
import { resolveMachineAdmissionsInTx } from '@/app/machines/machineAccess';
import { projectManagedMachine } from '@/app/machines/managed/managedMachineProjection';
import { redactManagedMachineCredentialReferences, type ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';

function readDeclaredPreparationScope(binding: ExternalActionExecutionAuthorizationBindingV1, child?: ReviewedActionChildHttpProofV1, effectActionId?: string) {
    const action = ActionIdSchema.safeParse(binding.actionId);
    return action.success ? getActionSpec(action.data).deploymentPreparationScope?.(binding, child, effectActionId) : undefined;
}

type TemplateAdmission = Extract<DeploymentPreparationAdmissionV1, { operation: 'template' }>;
type SetupDeployment = Extract<DeploymentPreparationAdmissionV1, { operation: 'setup' }>['deployments'][number];
type CreateAdmission = Extract<DeploymentPreparationAdmissionV1, { operation: 'create' }>;

type AdmittedDeploymentOperandKind = 'environment' | 'source' | 'artifact' | 'deployment' | 'targetLink' | 'domain' | 'machine';

const DEPLOYMENT_TRANSPORT_OPERAND_KEYS = new Set(['serverId', 'requestId', 'requestKey', 'cursor', 'revision', 'expectedRevision',
    'contentHeaderVersion', 'contentBodyVersion', 'actionId', 'installationId']);
const DEPLOYMENT_OPERAND_NAMES: readonly (readonly [AdmittedDeploymentOperandKind, readonly string[]])[] = [
    ['environment', ['environment']], ['source', ['source', 'projectSource', 'project']], ['artifact', ['artifact', 'contentArtifact']],
    ['deployment', ['deployment', 'receipt']], ['targetLink', ['targetLink']], ['domain', ['domain']], ['machine', ['machine', 'machineTargets']],
];

/** Names a signed operand by its key, or by its parent object for a nested `{ id }`. */
function classifyDeploymentOperand(key: string, parent: string): AdmittedDeploymentOperandKind | 'transport' | 'unknown' {
    if (DEPLOYMENT_TRANSPORT_OPERAND_KEYS.has(key)) return 'transport';
    const name = key === 'id' ? parent : key;
    for (const [kind, bases] of DEPLOYMENT_OPERAND_NAMES) {
        for (const base of bases) {
            const capitalized = `${base[0]!.toUpperCase()}${base.slice(1)}`;
            if (name === base || name === `${base}Id` || name === `${base}Ids` || name.endsWith(`${capitalized}Id`)
                || name.endsWith(`${capitalized}Ids`)) return kind;
        }
    }
    return key === 'id' || key.endsWith('Id') || key.endsWith('Ids') ? 'unknown' : 'transport';
}

function collectDeploymentOperands(value: unknown, visit: (kind: ReturnType<typeof classifyDeploymentOperand>, id: string) => void,
    key = '', parent = ''): void {
    if (typeof value === 'string') { visit(classifyDeploymentOperand(key, parent), value); return; }
    if (Array.isArray(value)) { for (const item of value) collectDeploymentOperands(item, visit, key, parent); return; }
    if (value && typeof value === 'object') {
        for (const [childKey, child] of Object.entries(value)) collectDeploymentOperands(child, visit, childKey, key);
    }
}

/**
 * The one admitted deployment scope: every Environment, Source, Artifact and
 * Machine operand the signed root (or its accepted receipt) names, expanded only
 * through rows those Environments own. Declared read transports consume it.
 */
export async function readAdmittedDeploymentScopeInTx(tx: Tx,
    binding: ExternalActionExecutionAuthorizationBindingV1,
    acceptedEnvironmentId?: string, readActionId?: string, setupReceiverMachineId?: string, operands?: unknown, preparationEffectRead = false,
): Promise<Readonly<{ environmentIds: ReadonlySet<string>; sourceIds: ReadonlySet<string>;
    artifactIds: ReadonlySet<string>; machineIds: ReadonlySet<string>;
    deploymentIds?: ReadonlySet<string>; receiptTargets?: readonly { environmentId: string; targetLinkId: string }[]; preparationSource?: ProjectSourceV1 }> | null> {
    const seeds = { environment: new Set<string>(), source: new Set<string>(), artifact: new Set<string>(),
        deployment: new Set<string>(), targetLink: new Set<string>(), domain: new Set<string>(), machine: new Set<string>() };
    const preparation = binding.deploymentPreparationAdmission;
    const selectedPreparation = preparation?.operation === 'setup' && setupReceiverMachineId !== undefined
        ? { ...preparation, catalogSources: preparation.catalogSources?.filter(selected => selected.machineId === setupReceiverMachineId),
            deployments: preparation.deployments.filter(selected => selected.machineId === setupReceiverMachineId) } : preparation;
    const admissions = [selectedPreparation, binding.deploymentNativeAdmission,
        binding.deploymentReadAdmission, binding.deploymentLinkAdmission, binding.registryAppUpdateAdmission].filter(admission => admission !== undefined);
    if (admissions.length === 0 && binding.environmentId === undefined && acceptedEnvironmentId === undefined) return null;
    for (const admission of admissions) collectDeploymentOperands(admission, (kind, id) => {
        if (kind !== 'transport' && kind !== 'unknown') seeds[kind].add(id);
    });
    const nativeAdmission = binding.deploymentNativeAdmission;
    const defaults = binding.actionId === DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1
        && isDeploymentEnvironmentUpdateNativeAdmissionV1(nativeAdmission) && nativeAdmission.defaultsFor !== undefined;
    // A template's children (bindings, link, update) read the Environment mint admitted or this root
    // created, with or without a deploy intent; deploy-only reads gate on the intent at their own arm.
    const resolvedEnvironmentId = preparationEffectRead ? preparation?.operation === 'template'
        ? await readTemplateEnvironmentId(tx, binding, preparation)
        : preparation?.operation === 'create' ? await readPreviewCreateEnvironmentIdInTx(tx, binding, preparation) : null
        : binding.environmentId ?? (preparation?.operation === 'create'
        ? await readPreviewCreateEnvironmentIdInTx(tx, binding, preparation)
        : preparation?.operation === 'template' ? await readTemplateEnvironmentId(tx, binding, preparation) : null);
    if (resolvedEnvironmentId) seeds.environment.add(resolvedEnvironmentId);
    if (defaults && readActionId === DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1
        && !await readConfigurationDefaultsEnvironmentInTx(tx, binding)) seeds.environment.clear();
    if (acceptedEnvironmentId !== undefined) seeds.environment.add(acceptedEnvironmentId);
    if (selectedPreparation?.operation === 'setup' && readActionId === DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1) {
        const environmentId = operands && typeof operands === 'object' && 'environmentId' in operands ? operands.environmentId : undefined;
        const selected = selectedPreparation.deployments.find(selected => selected.environment.id === environmentId);
        // Mint admitted this signed selection; its later reads are steps of that work, not new admissions.
        if (!selected) seeds.environment.clear();
    }
    const native = binding.deploymentNativeAdmission;
    const backup = native && 'kind' in native && (native.kind === 'backup' || native.kind === 'restore') ? native : undefined;
    const pruneHistory = backup?.kind === 'backup' && backup.actionId === DEPLOYMENT_BACKUP_PRUNE_ACTION_ID_V1;
    // Environment identity is already signed; expand owned rows only when the read needs them.
    if (readActionId === DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1 && !backup) {
        if (preparation?.operation === 'template' || preparation?.operation === 'create') {
            seeds.environment.clear();
            if (resolvedEnvironmentId) seeds.environment.add(resolvedEnvironmentId);
            // The root reads its allocation and only sources named by its admitted input.
            // A storage child spends the allocation alone.
            if (preparation.operation === 'create' && !preparationEffectRead) {
                if (preparation.preview) seeds.environment.add(preparation.preview.templateEnvironmentId);
                if (preparation.copyFrom) seeds.environment.add(preparation.copyFrom.environmentId);
            }
        }
        if (preparation?.operation === 'prepare') {
            for (const id of seeds.environment) if (id !== preparation.environment?.id) seeds.environment.delete(id);
        }
        // A deploy-family root over an admitted preview reads the template it was derived from
        // (the daemon's preview admission), as every other read below does.
        const deployFamily = deploymentOperationForRootActionV1(binding.actionId);
        if (!preparation && (deployFamily === 'deploy' || deployFamily === 'rollback' || deployFamily === 'promote')
            && seeds.environment.size > 0) {
            const previews = await tx.deploymentEnvironment.findMany({ where: { id: { in: [...seeds.environment] }, purpose: 'preview',
                deletedAt: null }, select: { previewTemplateEnvironmentId: true } });
            for (const preview of previews) if (preview.previewTemplateEnvironmentId) seeds.environment.add(preview.previewTemplateEnvironmentId);
        }
        return { environmentIds: seeds.environment, sourceIds: seeds.source, artifactIds: seeds.artifact, machineIds: seeds.machine };
    }
    let environments = await tx.deploymentEnvironment.findMany({ where: { id: { in: [...seeds.environment] } },
        select: { id: true, projectSourceId: true, contentArtifactId: true, controllerMachineId: true, buildMachineId: true,
            previewTemplateEnvironmentId: true, purpose: true, deletedAt: true,
            targetLinks: { select: { id: true, predecessorTargetLinkId: true, contentArtifactId: true, activeDeploymentId: true, machineId: true, machines: { select: { machineId: true } } } },
            domains: { select: { id: true, contentArtifactId: true,
                ...(backup ? { capturedPlacements: true, state: true, deletedAt: true } : {}) } } } });
    let deploymentIds: Set<string> | undefined;
    let receiptTargets: { environmentId: string; targetLinkId: string }[] | undefined;
    if (backup) {
        const targets = [{ environmentId: backup.environmentId, targetLinkId: backup.targetLinkId }];
        if (backup.kind === 'restore' && backup.source.kind === 'repository' && backup.source.origin) {
            targets.push({ environmentId: backup.source.origin.environmentId, targetLinkId: backup.source.origin.targetLinkId });
        }
        receiptTargets = targets;
        deploymentIds = pruneHistory ? undefined : new Set([backup.deploymentId]);
        environments = environments.filter(environment => {
            const destination = environment.id === backup.environmentId
                ? environment.targetLinks.find(link => link.id === backup.targetLinkId) : undefined;
            if (destination?.activeDeploymentId) deploymentIds?.add(destination.activeDeploymentId);
            return targets.some(target => target.environmentId === environment.id
                && environment.targetLinks.some(link => link.id === target.targetLinkId));
        });
        if (pruneHistory) {
            const environment = environments.find(environment => environment.id === backup.environmentId);
            const links = environment?.targetLinks.map(link => ({ id: link.id, environmentId: environment.id,
                predecessorTargetLinkId: link.predecessorTargetLinkId ?? undefined })) ?? [];
            const selected = links.find(link => link.id === backup.targetLinkId);
            receiptTargets = selected ? [...getDeploymentTargetLinkLineageV1(selected, links)]
                .map(targetLinkId => ({ environmentId: backup.environmentId, targetLinkId })) : [];
        }
    }
    const receiptRead = readActionId !== undefined && isDeploymentReceiptReadActionIdV1(readActionId);
    if (preparation?.operation === 'create' && (receiptRead || preparationEffectRead)) {
        const environmentId = await readPreviewCreateEnvironmentIdInTx(tx, binding, preparation);
        environments = environments.filter(environment => environment.id === environmentId);
    }
    if (preparation?.operation === 'template' && (receiptRead || readActionId === DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1)) {
        const environmentId = await readTemplateEnvironmentId(tx, binding, preparation);
        environments = environments.filter(environment => environment.id === environmentId);
    }
    const membershipDomainRead = readActionId !== undefined && isDeploymentDomainMetadataReadActionIdV1(readActionId)
        && isDeploymentMembershipActionIdV1(binding.actionId, preparation);
    if (membershipDomainRead) environments = environments.filter(environment => environment.id === resolvedEnvironmentId);
    const environmentIds = new Set(environments.map(environment => environment.id));
    if (membershipDomainRead && readActionId === deploymentActionIds.DEPLOYMENT_DOMAIN_GET_ACTION_ID_V1 && preparation?.operation === 'create'
        && preparation.preview) environmentIds.add(preparation.preview.templateEnvironmentId);
    const sourceIds = new Set(seeds.source);
    const artifactIds = new Set(seeds.artifact);
    const machineIds = new Set(seeds.machine);
    if (pruneHistory && receiptTargets && receiptTargets.length > 0) {
        const requestedArtifactIds = new Set<string>();
        collectDeploymentOperands(operands, (kind, id) => { if (kind === 'artifact') requestedArtifactIds.add(id); });
        if (requestedArtifactIds.size > 0) {
            // Prune opens only demanded history documents, never the entire receipt inventory.
            const receipts = await tx.deployment.findMany({ where: { environmentId: backup.environmentId,
                targetLinkId: { in: receiptTargets.map(target => target.targetLinkId) },
                contentArtifactId: { in: [...requestedArtifactIds] } },
                select: { contentArtifactId: true } });
            for (const receipt of receipts) {
                artifactIds.add(receipt.contentArtifactId);
            }
        }
    }
    for (const environment of environments) {
        // A preview reads the template Environment it was derived from.
        if (environment.previewTemplateEnvironmentId && !receiptRead && !binding.deploymentReadAdmission && !binding.registryAppUpdateAdmission
            && (readActionId === undefined || readActionId !== DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1
                && (!membershipDomainRead || readActionId === deploymentActionIds.DEPLOYMENT_DOMAIN_GET_ACTION_ID_V1 && environment.purpose === 'preview'
                    && !environment.deletedAt && deploymentOperationForRootActionV1(binding.actionId, binding.deploymentPreparationAdmission) !== 'teardown')))
            environmentIds.add(environment.previewTemplateEnvironmentId);
        sourceIds.add(environment.projectSourceId);
        artifactIds.add(environment.contentArtifactId);
        machineIds.add(environment.controllerMachineId);
        if (environment.buildMachineId) machineIds.add(environment.buildMachineId);
        for (const link of environment.targetLinks) {
            if (backup && !receiptTargets?.some(target => target.environmentId === environment.id && target.targetLinkId === link.id)) continue;
            artifactIds.add(link.contentArtifactId);
            if (link.machineId) machineIds.add(link.machineId);
            for (const member of link.machines) machineIds.add(member.machineId);
        }
        for (const domain of environment.domains) {
            if (!backup) { artifactIds.add(domain.contentArtifactId); continue; }
            if (domain.deletedAt || domain.state === 'removing') continue;
            const captures = DeploymentDomainCapturedPlacementsV1Schema.safeParse(domain.capturedPlacements);
            if (!captures.success) continue;
            for (const capture of captures.data) {
                if (!capture.desired || !receiptTargets?.some(target => target.environmentId === capture.placement.environmentId
                    && target.targetLinkId === capture.placement.targetLinkId)) continue;
                artifactIds.add(capture.content.contentArtifactId);
            }
        }
    }
    // Teardown consumes captured workload content, not repository Source preparation.
    if (readActionId === PROJECT_SOURCE_READ_ACTION_ID_V1
        && deploymentOperationForRootActionV1(binding.actionId, preparation) === 'teardown') sourceIds.clear();
    if (selectedPreparation?.operation === 'setup' && readActionId === PROJECT_SOURCE_READ_ACTION_ID_V1) {
        sourceIds.clear();
        for (const selected of selectedPreparation.catalogSources ?? []) sourceIds.add(selected.source.id);
    }
    if (preparation?.operation === 'create' && readActionId === PROJECT_SOURCE_READ_ACTION_ID_V1 && !preparation.newProject) {
        sourceIds.clear();
        const copiedSourceId = environments.find(environment => environment.id === preparation.copyFrom?.environmentId)?.projectSourceId;
        if (preparation.source) sourceIds.add(preparation.source.id);
        if (copiedSourceId) sourceIds.add(copiedSourceId);
    }
    if (preparation?.operation === 'prepare' && readActionId === PROJECT_SOURCE_READ_ACTION_ID_V1) {
        sourceIds.clear();
        if (preparation.source) sourceIds.add(preparation.source.id);
    }
    let preparationSource: ProjectSourceV1 | undefined;
    const admission = binding.deploymentPreparationAdmission;
    if (preparation?.operation === 'create' && preparation.newProject && readActionId === PROJECT_SOURCE_READ_ACTION_ID_V1) {
        preparationSource = (await readAdmittedCreateDeploymentEnvironmentCustodyInTx(tx, binding))?.source;
        sourceIds.clear();
        if (preparationSource) sourceIds.add(preparationSource.id);
    }
    if (readActionId === PROJECT_SOURCE_READ_ACTION_ID_V1
        && (defaults || admission?.operation === 'template' || admission?.operation === 'catalog')) {
        const source = await (async () => {
            let source: ProjectSourceV1 | undefined;
            if (defaults) {
                const environment = await readConfigurationDefaultsEnvironmentInTx(tx, binding);
                if (!environment) return undefined;
                source = (await readProjectSourceCustodyInTx(tx, environment.projectSourceId))?.source;
            } else if (admission?.operation === 'template') {
                const scope = await readAdmittedTemplateInstantiationScopeInTx(tx, binding, admission);
                if (!scope) return undefined;
                source = scope.source;
                if (!source && admission.newProject && scope.environment) {
                    source = (await readProjectSourceCustodyInTx(tx, scope.environment.projectSourceId))?.source;
                }
            } else if (admission?.operation === 'catalog') {
                if (binding.actionId !== DEPLOYMENT_PUBLISH_PREPARE_ACTION_ID_V1 || admission.machineId !== binding.machineId
                    || admission.installationId !== binding.installationId) return undefined;
                if (admission.source) {
                    const custody = await readProjectSourceCustodyInTx(tx, admission.source.id);
                    if (!custody || custody.source.revision !== admission.source.revision
                        || custody.owner.kind === 'account' && custody.owner.accountId !== binding.accountId) return undefined;
                    source = custody.source;
                } else if (admission.newProject) {
                    const environmentId = await readCreatedDeploymentEnvironmentIdInTx(tx, binding.accountId, admission.newProject.requestKey);
                    const environment = environmentId ? await tx.deploymentEnvironment.findUnique({ where: { id: environmentId }, select: { projectSourceId: true } }) : null;
                    const custody = environment ? await readProjectSourceCustodyInTx(tx, environment.projectSourceId) : null;
                    if (!custody || custody.owner.kind === 'account' && custody.owner.accountId !== binding.accountId) return undefined;
                    source = custody.source;
                } else return undefined;
            }
            if (!source) return undefined;
            return source;
        })();
        preparationSource = source;
        sourceIds.clear();
        if (source) sourceIds.add(source.id);
    }
    return { environmentIds, sourceIds, artifactIds, machineIds,
        ...(deploymentIds ? { deploymentIds } : {}), ...(receiptTargets ? { receiptTargets } : {}),
        ...(preparationSource ? { preparationSource } : {}) };
}

/**
 * Each declared read operand must name a row inside the admitted scope; a read
 * naming none is refused. `null` means the root carries no deployment scope.
 */
export async function isDeploymentReadOperandInAdmittedScopeInTx(tx: Tx,
    binding: Parameters<typeof readAdmittedDeploymentScopeInTx>[1], operands: unknown, acceptedEnvironmentId?: string,
    operandKind?: AdmittedDeploymentOperandKind, readActionId?: string, setupReceiverMachineId?: string, preparationEffectRead = false,
): Promise<boolean | null> {
    if (readActionId === DEPLOYMENT_ENVIRONMENT_LIST_ACTION_ID_V1) {
        const parsed = DeploymentEnvironmentListInputV1Schema.safeParse(operands);
        if (!parsed.success || parsed.data.serverId !== binding.serverIdentityId) return false;
        const { machineId, cursor, limit } = parsed.data;
        const page = { ...(cursor === undefined ? {} : { cursor }), ...(limit === undefined ? {} : { limit }) };
        const admission = binding.deploymentPreparationAdmission;
        const native = binding.deploymentNativeAdmission;
        const update = binding.actionId === DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1
            && isDeploymentEnvironmentUpdateNativeAdmissionV1(native) && native.defaultsFor === undefined ? native : undefined;
        const create = admission?.operation === 'create' && admission.preview ? admission : undefined;
        if (!create && !update) return false;
        if (machineId === undefined) {
            if (!create?.source || !create.preview || parsed.data.previewRepositoryId !== undefined
                && parsed.data.previewRepositoryId !== create.source.id) return false;
            return sameStrictJsonValue(parsed.data, { serverId: binding.serverIdentityId, projectSourceId: create.source.id,
                previewTemplateEnvironmentId: create.preview.templateEnvironmentId,
                ...(parsed.data.previewRepositoryId === undefined ? {} : { previewRepositoryId: parsed.data.previewRepositoryId }),
                ...(parsed.data.previewRepository === undefined ? {} : { previewRepository: parsed.data.previewRepository }),
                previewPullRequestIds: [create.preview.pullRequestId], ...page });
        }
        if (!sameStrictJsonValue(parsed.data, { serverId: binding.serverIdentityId, machineId, ...page })) return false;
        const environmentId = update?.environmentId ?? (create?.preview
            ? await readPreviewCreateEnvironmentIdInTx(tx, binding, create) ?? create.preview.templateEnvironmentId : null);
        if (!environmentId) return false;
        const environment = await tx.deploymentEnvironment.findUnique({ where: { id: environmentId },
            select: { buildMachineId: true, runtimeTargetLinkId: true } });
        if (!environment) return false;
        if ((update?.previewPlacement?.buildMachineId ?? environment.buildMachineId) === machineId) return true;
        const targetLinkId = update?.previewPlacement?.runtimeTargetLinkId ?? environment.runtimeTargetLinkId;
        return targetLinkId !== null && await tx.deploymentTargetLinkMachine.findFirst({
            where: { targetLinkId, targetLink: { environmentId }, machineId, state: 'active' }, select: { machineId: true },
        }) !== null;
    }
    if (binding.actionId === deploymentActionIds.DEPLOYMENT_TARGET_LINK_ACTION_ID_V1 && !binding.deploymentLinkAdmission) return false;
    if (readActionId && binding.serverIdentityId && operands && typeof operands === 'object'
        && 'serverId' in operands && operands.serverId !== binding.serverIdentityId) return false;
    if (operands && typeof operands === 'object' && 'projection' in operands && operands.projection === 'approvalScope'
        && 'environmentId' in operands && operands.environmentId !== binding.environmentId) return false;
    const scope = await readAdmittedDeploymentScopeInTx(tx, binding, acceptedEnvironmentId, readActionId, setupReceiverMachineId, operands, preparationEffectRead);
    if (!scope) return null;
    const owned = { deployment: [] as string[], targetLink: [] as string[], domain: [] as string[] };
    let constrained = false;
    let inScope = true;
    collectDeploymentOperands(operands, (classified, id) => {
        const kind = classified === 'unknown' && operandKind ? operandKind : classified;
        if (kind === 'transport') return;
        constrained = true;
        if (kind === 'unknown') inScope = false;
        else if (kind === 'deployment' || kind === 'targetLink' || kind === 'domain') owned[kind].push(id);
        else if (!({ environment: scope.environmentIds, source: scope.sourceIds, artifact: scope.artifactIds,
            machine: scope.machineIds })[kind].has(id)) inScope = false;
    });
    if (!constrained || !inScope) return false;
    const environmentIds = [...scope.environmentIds];
    // Read admissions can select one receipt or one health target inside an Environment.
    // These restrictions belong here, alongside the shared operand membership decision.
    const read = binding.deploymentReadAdmission;
    if (read && 'environmentId' in read) {
        if (owned.deployment.some(id => read.actionId === deploymentActionIds.DEPLOYMENT_HEALTH_CURRENT_ACTION_ID_V1 || !('deploymentId' in read) || id !== read.deploymentId)) return false;
        if (readActionId === deploymentActionIds.DEPLOYMENT_DOMAIN_GET_ACTION_ID_V1 && read.actionId === deploymentActionIds.DEPLOYMENT_HEALTH_CURRENT_ACTION_ID_V1) {
            return await tx.deploymentDomain.count({ where: { id: { in: owned.domain },
                environmentId: read.environmentId, targetLinkId: read.targetLinkId, deletedAt: null } }) === new Set(owned.domain).size;
        }
    }
    if (scope.deploymentIds && owned.deployment.some(id => !scope.deploymentIds!.has(id))) return false;
    const [deployments, targetLinks, domains] = await Promise.all([
        owned.deployment.length === 0 ? 0 : tx.deployment.count({ where: { id: { in: owned.deployment }, environmentId: { in: environmentIds },
            ...(binding.deploymentNativeAdmission && 'kind' in binding.deploymentNativeAdmission && binding.deploymentNativeAdmission.kind === 'promote' ? { OR: [
                { environmentId: binding.deploymentNativeAdmission.environmentId },
                { environmentId: binding.deploymentNativeAdmission.sourceEnvironmentId, id: binding.deploymentNativeAdmission.sourceDeploymentId },
            ] } : scope.receiptTargets ? { OR: [...scope.receiptTargets] } : {}) } }),
        owned.targetLink.length === 0 ? 0 : tx.deploymentTargetLink.count({ where: { id: { in: owned.targetLink }, environmentId: { in: environmentIds } } }),
        owned.domain.length === 0 ? 0 : tx.deploymentDomain.count({ where: { id: { in: owned.domain }, environmentId: { in: environmentIds } } }),
    ]);
    return deployments === new Set(owned.deployment).size && targetLinks === new Set(owned.targetLink).size
        && domains === new Set(owned.domain).size;
}

/** The Project Source read transport, which the generic Account operation binder does not declare. */
export function readDeploymentSourceReadOperands(serverIdentityId: string,
    proof: Readonly<{ method: string; path: string; body?: unknown; routeInput?: unknown }>): Readonly<{ serverId: string; sourceId: string }> | null {
    const url = new URL(proof.path, 'http://home.invalid');
    const match = /^\/v1\/projects\/sources\/([^/?#]+)$/u.exec(url.pathname);
    if (!match || proof.method.toUpperCase() !== 'GET' || proof.body !== undefined || url.hash !== ''
        || url.searchParams.size !== 1 || url.searchParams.get('serverId') !== serverIdentityId) return null;
    try {
        const source = ProjectSourcesReadInputV1Schema.safeParse({ serverId: url.searchParams.get('serverId'), sourceId: decodeURIComponent(match[1]) });
        return source.success && match[1] === encodeURIComponent(source.data.sourceId)
            && (proof.routeInput === undefined || sameStrictJsonValue(proof.routeInput,
                { serverId: source.data.serverId, id: source.data.sourceId })) ? source.data : null;
    } catch { return null; }
}

/** Decode the existing Environment read transports, then spend the one admitted scope. */
export async function isDeploymentEnvironmentHttpReadInAdmittedScopeInTx(tx: Tx,
    binding: ExternalActionExecutionAuthorizationBindingV1,
    proof: Readonly<{ method: string; path: string; body?: unknown; routeInput?: unknown }>,
    approvalProjection = false, setupReceiverMachineId?: string, preparationEffectRead = false,
): Promise<boolean> {
    if (proof.method.toUpperCase() !== 'GET' || proof.body !== undefined) return false;
    const url = new URL(proof.path, 'http://home.invalid');
    const path = /^\/v1\/deployments\/environments\/([^/?#]+)$/u.exec(url.pathname);
    if (!path || url.hash || url.searchParams.size !== (approvalProjection ? 2 : 1)) return false;
    let environmentId: string;
    try { environmentId = decodeURIComponent(path[1]!); } catch { return false; }
    if (path[1] !== encodeURIComponent(environmentId)) return false;
    const parsed = approvalProjection
        ? DeploymentApprovalEnvironmentInputV1Schema.safeParse({ serverId: url.searchParams.get('serverId'), environmentId,
            projection: url.searchParams.get('projection') })
        : DeploymentEnvironmentGetInputV1Schema.safeParse({ serverId: url.searchParams.get('serverId'), environmentId });
    return parsed.success && parsed.data.serverId === binding.serverIdentityId
        && (proof.routeInput === undefined || sameStrictJsonValue(proof.routeInput, parsed.data))
        && await isDeploymentReadOperandInAdmittedScopeInTx(tx, binding, parsed.data,
            undefined, undefined, DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1, setupReceiverMachineId, preparationEffectRead) === true;
}

// Template scope adds only pending captures to the existing public operand grammar.
const templateCreateStorageInputSchema = lazyZodSchema(() => z.safeExtend(DeploymentEnvironmentCreateInputV1Schema, {
    referencedSavedSecretRevisions: DeploymentEnvironmentCreateStorageInputV1Schema.shape.referencedSavedSecretRevisions,
}));
const templateUpdateStorageInputSchema = lazyZodSchema(() => z.safeExtend(DeploymentEnvironmentUpdateInputV1Schema, {
    referencedSavedSecretRevisions: DeploymentEnvironmentUpdateStorageInputV1Schema.shape.referencedSavedSecretRevisions,
}));

/** Move spends its definition admission on the selected workspace, independently of runtime placement. */
export function isDeploymentMoveToRepositoryHttpEffect(binding: ExternalActionExecutionAuthorizationBindingV1,
    effectActionId: string, reviewedChild?: ReviewedActionChildHttpProofV1): boolean {
    return readDeclaredPreparationScope(binding, reviewedChild)?.moveEffects.includes(effectActionId) === true;
}

/** Existing Source, Account-row and Artifact owners retain their mutation and content authority. */
export async function readDeploymentMoveToRepositoryHttpPurpose(tx: Tx, binding: ExternalActionExecutionAuthorizationBindingV1,
    effectActionId: string,
    proof: Readonly<{ method: string; path: string; body?: unknown; routeInput?: unknown; reviewedChild?: ReviewedActionChildHttpProofV1 }>,
): Promise<boolean | null> {
    if (binding.actionId !== DEPLOYMENT_ENVIRONMENT_MOVE_TO_REPOSITORY_ACTION_ID_V1) return null;
    if (!binding.environmentId || !isDeploymentMoveToRepositoryHttpEffect(binding, effectActionId, proof.reviewedChild)) return false;
    const environment = await tx.deploymentEnvironment.findUnique({ where: { id: binding.environmentId },
        select: { projectSourceId: true, contentArtifactId: true } });
    if (!environment) return false;
    const method = proof.method.toUpperCase();
    const matches = (expected: unknown) => proof.routeInput === undefined || sameStrictJsonValue(proof.routeInput, expected);
    const serverId = binding.serverIdentityId, environmentId = binding.environmentId;
    if (effectActionId === DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1) {
        return isDeploymentEnvironmentHttpReadInAdmittedScopeInTx(tx, binding, proof);
    }
    if (effectActionId === PROJECT_SOURCE_READ_ACTION_ID_V1) {
        const input = readDeploymentSourceReadOperands(serverId, proof);
        return input !== null && await isDeploymentReadOperandInAdmittedScopeInTx(tx, binding, input,
            undefined, undefined, effectActionId) === true;
    }
    if (effectActionId === PROJECT_SOURCE_UPDATE_ACTION_ID_V1) {
        const input = ProjectSourcesUpdateInputV1Schema.safeParse(proof.body);
        return method === 'PATCH' && input.success && input.data.serverId === serverId
            && input.data.sourceId === environment.projectSourceId && input.data.patch.repository != null
            && Object.keys(input.data.patch).every(key => key === 'repository')
            && proof.path === `/v1/projects/sources/${encodeURIComponent(environment.projectSourceId)}`
            && matches({ id: environment.projectSourceId, ...input.data });
    }
    const candidateId = createDeploymentEnvironmentContentArtifactIdV1({ ...binding, environmentId });
    if (effectActionId === DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1) {
        const input = DeploymentEnvironmentContentCasV1Schema.safeParse(proof.body);
        if (!input.success || input.data.contentArtifactId !== candidateId || input.data.contentHeaderVersion !== 1
            || input.data.contentBodyVersion !== 1) return false;
        return method === 'PATCH' && input.data.serverId === serverId && input.data.environmentId === environmentId
            && proof.path === `/v1/deployments/environments/${encodeURIComponent(environmentId)}`
            && matches(input.data)
            && computeActionInputApprovalDigestV1(effectActionId, input.data) === proof.reviewedChild?.inputDigest;
    }
    if (method === 'GET' && proof.body === undefined) {
        if (proof.path === '/v1/account/encryption/currentness') return matches({});
        for (const id of [environment.contentArtifactId, candidateId]) {
            if (proof.path === `/v1/artifacts/${encodeURIComponent(id)}`) return matches({ id });
        }
    }
    const publication = await readDeploymentPrivateCandidatePublicationHttpPurpose(tx, environmentId, proof, candidateId,
        DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1);
    if (publication !== null) return publication;
    if (method !== 'POST') return false;
    const allowedKey = (key: Readonly<{ kind: string; serverId?: string }>) => key.kind === 'relationship-graph'
        || key.kind === 'workspace-ref' && key.serverId === serverId;
    if (proof.path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/read`) {
        const input = ProjectAccountRowReadRequestV1Schema.safeParse(proof.body);
        return input.success && allowedKey(input.data.key) && matches(input.data);
    }
    if (proof.path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`) {
        const input = ProjectAccountRowListRequestV1Schema.safeParse(proof.body);
        return input.success && input.data.kinds !== undefined
            && input.data.kinds.every(kind => kind === 'workspace-ref' || kind === 'relationship-graph')
            && (input.data.serverId === undefined || input.data.serverId === serverId) && matches(input.data);
    }
    if (proof.path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/mutate`) {
        const input = ProjectAccountRowMutationRequestV1Schema.safeParse(proof.body);
        return input.success && input.data.mutations.every(mutation => allowedKey(mutation.key) && mutation.content !== null)
            && input.data.expectedRefs.every(ref => allowedKey(ref.key)) && matches(input.data);
    }
    return false;
}

/** Publication and native preparation consume the same admitted Environment locator. */
export async function readDeploymentPreparationEnvironmentIdInTx(tx: Tx,
    binding: ExternalActionExecutionAuthorizationBindingV1, allocatedEnvironmentId?: string,
): Promise<string | null> {
    return binding.deploymentCandidatePublication?.environmentId
        ?? (binding.actionId === deploymentActionIds.DEPLOYMENT_DEPLOY_ACTION_ID_V1 ? binding.environmentId : undefined)
        ?? allocatedEnvironmentId ?? await readTemplateDeploymentEnvironmentIdInTx(tx, binding);
}

/** Consume the signed admitted Machine scope for finite preparation reads. */
export async function isDeploymentPreparationMachineReadHttpPurposeInTx(tx: Tx,
    binding: ExternalActionExecutionAuthorizationBindingV1, _effectActionId: string,
    proof: Readonly<{ method: string; path: string; body?: unknown; routeInput?: unknown }>,
): Promise<boolean> {
    if (proof.method.toUpperCase() !== 'GET' || proof.body !== undefined) return false;
    const match = /^\/v1\/machines\/([^/?#]+)$/u.exec(proof.path);
    if (!match) return false;
    let machineId: string;
    try { machineId = decodeURIComponent(match[1]); } catch { return false; }
    if (match[1] !== encodeURIComponent(machineId)
        || proof.routeInput !== undefined && !sameStrictJsonValue(proof.routeInput, { id: machineId })) return false;
    // Mint admitted each signed Machine operand and the Environment's placement.
    // This transport consumes that scope; the Machine route retains requester access.
    return await isDeploymentReadOperandInAdmittedScopeInTx(tx, binding, { machineId }) === true;
}

function isNativeDeploymentPreparationRead(method: string, path: string): boolean {
    return method === 'GET' || path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`
        || path === '/v1/auth/api-tokens/encryption-access';
}

/** Candidate mutation is native preparation, including the explicitly requested template deploy. */
export function isDeploymentCandidatePublicationEffect(binding: ExternalActionExecutionAuthorizationBindingV1, effectActionId: string): boolean {
    return readDeclaredPreparationScope(binding)?.candidateEffects.includes(effectActionId) === true;
}

/** Native preparation spends only canonical candidate identities for this signed root. */
export async function isDeploymentCandidatePublicationHttpPurposeInTx(tx: Tx,
    binding: ExternalActionExecutionAuthorizationBindingV1, effectActionId: string,
    proof: Readonly<{ method: string; path: string; body?: unknown; routeInput?: unknown }>,
): Promise<boolean> {
    return await readDeploymentCandidatePublicationHttpPurposeInTx(tx, binding, effectActionId, proof) !== null;
}

async function readDeploymentCandidatePublicationHttpPurposeInTx(tx: Tx,
    binding: ExternalActionExecutionAuthorizationBindingV1, effectActionId: string,
    proof: Readonly<{ method: string; path: string; body?: unknown; routeInput?: unknown }>,
) {
    if (!isDeploymentCandidatePublicationEffect(binding, effectActionId)) return null;
    const minted = binding.deploymentCandidatePublication;
    const allocatedCreate = binding.actionId === deploymentActionIds.DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1;
    const environmentId = await readDeploymentPreparationEnvironmentIdInTx(tx, binding);
    if (!environmentId) return null;
    // Root mint admitted this finite preparation. Publication consumes its
    // resource custody, without re-admitting the requester after withdrawal.
    const row = await tx.deploymentEnvironment.findUnique({ where: { id: environmentId } });
    const custody = row ? await readProjectSourceCustodyInTx(tx, row.projectSourceId) : null;
    const preparation = binding.deploymentPreparationAdmission;
    const selectedSource = preparation && 'source' in preparation ? preparation.source : undefined;
    if (!row || !custody
        || row.deletedAt && deploymentOperationForRootActionV1(binding.actionId, binding.deploymentPreparationAdmission) !== 'teardown'
        || row.controllerMachineId !== binding.machineId
        || minted && row.projectSourceId !== minted.source.id
        || !minted && (preparation?.operation !== 'template' && !allocatedCreate
            || selectedSource !== undefined && row.projectSourceId !== selectedSource.id)) return null;
    const scope = minted ?? createDeploymentCandidatePublicationV1({ ...binding, environmentId,
        source: { id: custody.source.id, revision: custody.source.revision } });
    const admit = async (allowed: boolean, artifactId: string) => {
        if (!allowed) return null;
        const publicationGrants: Pick<ArtifactAccessGrantSetInputV1, 'principal' | 'accessLevel'>[] = [];
        publicationGrants.push({ principal: custody.owner, accessLevel: 'admin' });
        if (artifactId === scope.contentArtifactId) {
            const audience = await readArtifactAccessGrantsForAdmittedCustodyInTx(tx, row.contentArtifactId);
            for (const grant of audience) {
                if (!sameStrictJsonValue(grant.principal, custody.owner)) {
                    publicationGrants.push({ principal: grant.principal, accessLevel: 'view' });
                }
            }
        }
        return { ...custody, publicationGrants };
    };
    // Receipt admission consumes preparation authority. Native transitions keep
    // their existing, separate accepted-execution writer after this point.
    if (await tx.deployment.findFirst({ where: { contentArtifactId: scope.contentArtifactId }, select: { id: true } })) return null;
    const matches = (expected: unknown) => proof.routeInput === undefined || sameStrictJsonValue(proof.routeInput, expected);
    const method = proof.method.toUpperCase();
    const kindFor = (id: string) => id === scope.contentArtifactId ? DEPLOYMENT_RECEIPT_ARTIFACT_STORED_KIND_V1
        : id === scope.environmentContentArtifactId ? DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1 : undefined;
    if (method === 'POST' && proof.path === '/v1/artifacts') {
        const parsed = ArtifactJsonCreateHttpInputV1Schema.safeParse(proof.body);
        if (!parsed.success) return null;
        const kind = kindFor(parsed.data.id);
        return admit(kind !== undefined && (parsed.data.kind === undefined || parsed.data.kind === kind)
            && parsed.data.approvalState === undefined && parsed.data.approvalSessionId === undefined && matches(parsed.data), parsed.data.id);
    }
    const path = /^\/v1\/artifacts\/([^/?#]+)(?:\/access\/(grants|recipients|key-envelopes))?$/u.exec(proof.path);
    if (!path) return null;
    let id: string;
    try { id = decodeURIComponent(path[1]); } catch { return null; }
    const kind = kindFor(id);
    if (!kind || encodeURIComponent(id) !== path[1]) return null;
    if (id === scope.environmentContentArtifactId && await tx.deploymentEnvironment.findFirst({
        where: { contentArtifactId: id }, select: { id: true },
    })) return null;
    if (method === 'POST' && path[2] === undefined) {
        const parsed = ArtifactJsonUpdateHttpInputV1Schema.safeParse(proof.body);
        return admit(parsed.success && (parsed.data.kind === undefined || parsed.data.kind === kind)
            && parsed.data.approvalState === undefined && parsed.data.approvalSessionId === undefined
            && matches({ id, ...parsed.data }), id);
    }
    const admitted = await admit(true, id);
    if (!admitted) return null;
    if (method === 'GET' && proof.body === undefined
        && (path[2] === 'recipients' || path[2] === 'grants' || path[2] === undefined)) return matches({ id }) ? admitted : null;
    if (method === 'PUT' && path[2] === 'grants') {
        const parsed = ArtifactAccessGrantSetInputV1Schema.safeParse(proof.body);
        return parsed.success && parsed.data.artifactId === id
            && admitted.publicationGrants.some(grant => parsed.data.accessLevel === grant.accessLevel
                && sameStrictJsonValue(parsed.data.principal, grant.principal))
            && matches({ id, ...parsed.data }) ? admitted : null;
    }
    if (method === 'POST' && path[2] === 'key-envelopes') {
        const parsed = ArtifactRecipientKeyEnvelopeCommitInputV1Schema.safeParse(proof.body);
        return parsed.success && parsed.data.artifactId === id && matches({ id, ...parsed.data }) ? admitted : null;
    }
    return null;
}

/** Preparation and receipt admission take the same Environment lock before the Artifact parent. */
export function createDeploymentCandidateArtifactMutationGuard(input: Readonly<{
    binding: ExternalActionExecutionAuthorizationBindingV1; effectActionId: string; artifactId: string;
    proof: Readonly<{ method: string; path: string; body?: unknown }>;
}>): ArtifactMutationTransactionGuard {
    return {
        async admitInTx(tx, actual) {
            if (actual.actorAccountId !== input.binding.accountId || actual.artifactId !== input.artifactId) return null;
            const environmentId = await readDeploymentPreparationEnvironmentIdInTx(tx, input.binding);
            if (environmentId) await lockDeploymentEnvironmentInTx(tx, environmentId);
            const admission = await readDeploymentCandidatePublicationHttpPurposeInTx(tx, input.binding,
                input.effectActionId, input.proof);
            return admission ? { publicationGrants: admission.publicationGrants } : null;
        },
    };
}

export type DeploymentPreparationAuthorization = Readonly<{ ok: true }>
    | Readonly<{ ok: false; code: 'credential_scope_denied' | 'source_changed' }>;

async function readCreateSource(tx: Tx, binding: ExternalActionExecutionAuthorizationBindingV1,
    admission: CreateAdmission, authentication: DeploymentAuthentication): Promise<DeploymentPreparationAuthorization> {
    if (deploymentPreparationOperationForActionV1(binding.actionId) !== 'create') return { ok: false, code: 'credential_scope_denied' };
    const source = admission.source ? await resolveProjectSourceAccessInTx(tx, binding.accountId, admission.source.id, authentication) : null;
    const owner = admission.newProject?.owner ?? (source?.ok ? source.owner : null);
    if (!owner || (admission.newProject ? !await canManageProjectSourceOwnerInTx(tx, binding.accountId, owner, authentication)
        : !source?.ok || !source.canManageOwner)) return { ok: false, code: 'credential_scope_denied' };
    if (admission.copyFrom) {
        const copied = await loadDeploymentEnvironmentInTx(tx, binding.accountId, binding.serverIdentityId,
            admission.copyFrom.environmentId, authentication);
        if (!copied.ok || copied.row.deletedAt) return { ok: false, code: 'credential_scope_denied' };
        if (copied.row.revision !== admission.copyFrom.expectedRevision) return { ok: false, code: 'source_changed' };
    }
    if (admission.preview) {
        const template = await loadDeploymentEnvironmentInTx(tx, binding.accountId, binding.serverIdentityId,
            admission.preview.templateEnvironmentId, authentication);
        if (!template.ok || !template.admission.canManage || template.row.deletedAt || template.row.purpose !== 'standard'
            || template.row.projectSourceId !== admission.source?.id
            || template.row.revision !== admission.preview.expectedTemplateRevision
            || template.row.runtimeTargetLinkId !== admission.preview.runtimeTargetLinkId) return { ok: false, code: 'credential_scope_denied' };
    }
    if (admission.previewCompanionOfEnvironmentId && (!admission.preview || !admission.source
        || admission.purpose !== 'standard' || admission.protection !== 'nonProduction'
        || !await readPreviewCompanionMainInTx(tx, { projectSourceId: admission.source.id, preview: admission.preview,
            previewCompanionOfEnvironmentId: admission.previewCompanionOfEnvironmentId }))) return { ok: false, code: 'credential_scope_denied' };
    return { ok: true };
}

export interface DeploymentCreateHttpPurpose {
    readonly rootActionId: typeof deploymentActionIds.DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1;
    readonly effectActionId: string;
    readonly child?: Readonly<{ environmentId: string }>;
    readonly source?: ProjectSourceV1;
}

export type DeploymentTargetRetentionHttpPurpose = Readonly<{ kind: 'preparation-read' }>
    | Readonly<{ kind: 'reviewed-child'; requestId: string }>
    | Readonly<{ kind: 'restore-read'; machines: ManagedMachineV1[] }>;

/** Capture Link's readable operands once at issuance, from the canonical Environment admission. */
export async function readDeploymentLinkAdmissionInTx(tx: Tx,
    binding: Pick<ExternalActionExecutionAuthorizationBindingV1, 'accountId' | 'serverIdentityId'>,
    environmentId: string, authentication: DeploymentAuthentication,
): Promise<NonNullable<ExternalActionExecutionAuthorizationBindingV1['deploymentLinkAdmission']> | null> {
    const loaded = await loadDeploymentEnvironmentInTx(tx, binding.accountId, binding.serverIdentityId, environmentId, authentication);
    return loaded.ok && !loaded.row.deletedAt && loaded.admission.canManage
        ? { environmentId: loaded.row.id, owner: loaded.admission.owner } : null;
}

/**
 * Adoption's existing-target check opens the runtime own-server links its owner-scoped
 * inventory read returned on this Machine; nothing outside that owner or Machine.
 */
async function isOwnerRuntimeOwnServerLinkContentInTx(tx: Tx, machineId: string, owner: ProjectSourceOwnerV1,
    artifactId: string): Promise<boolean> {
    const member = await tx.deploymentTargetLinkMachine.findFirst({ where: { machineId, state: 'active', targetLink: {
        contentArtifactId: artifactId, role: 'runtime', sourceKind: 'host', targetKind: 'ownServer', deletedAt: null, detachedAt: null,
    } }, select: { targetLink: { select: { id: true, environment: { select: {
        runtimeTargetLinkId: true, projectSourceId: true, deletedAt: true } } } } } });
    const environment = member?.targetLink.environment;
    return Boolean(environment && environment.runtimeTargetLinkId === member.targetLink.id && !environment.deletedAt
        && sameStrictJsonValue(await readProjectSourceOwnerInTx(tx, environment.projectSourceId), owner));
}

/** A target-link inventory read stays inside the one owner its root admitted. */
function isOwnerTargetLinkListHttpPurpose(serverIdentityId: string, owner: ProjectSourceOwnerV1,
    proof: Readonly<{ method: string; body?: unknown; routeInput?: unknown }>): boolean {
    if (proof.method.toUpperCase() !== 'POST' || proof.routeInput !== undefined && !sameStrictJsonValue(proof.routeInput, proof.body)) return false;
    const input = DeploymentTargetLinksListInputV1Schema.safeParse(proof.body);
    return input.success && input.data.serverId === serverIdentityId && sameStrictJsonValue(input.data.scope, owner);
}

/** One purpose owner confines Link preparation reads and mutation to its signed admission. */
export async function readDeploymentLinkPreparationHttpPurpose(tx: Tx, binding: ExternalActionExecutionAuthorizationBindingV1,
    effectActionId: string,
    proof: Readonly<{ method: string; path: string; body?: unknown; routeInput?: unknown }>,
    isHttpOperation: (actionId: typeof DEPLOYMENT_PREPARATION_READ_ACTION_IDS_V1[number] | DeploymentDomainMetadataReadActionIdV1
        | typeof deploymentActionIds.DEPLOYMENT_TARGET_LINK_ACTION_ID_V1) => boolean,
): Promise<boolean | null> {
    if (binding.actionId !== deploymentActionIds.DEPLOYMENT_TARGET_LINK_ACTION_ID_V1) return null;
    const admission = binding.deploymentLinkAdmission;
    const read = await readDeploymentPreparationHttpReadPurpose(tx, binding, effectActionId, proof, isHttpOperation);
    if (read) {
        return await isDeploymentReadOperandInAdmittedScopeInTx(tx, binding, proof.routeInput,
            undefined, undefined, read.actionId) === true;
    }
    if (proof.path === '/v1/deployments/targets/list') {
        return admission !== undefined && effectActionId === binding.actionId
            && isOwnerTargetLinkListHttpPurpose(binding.serverIdentityId, admission.owner, proof);
    }
    const method = proof.method.toUpperCase();
    const matches = (expected: unknown) => proof.routeInput === undefined || sameStrictJsonValue(proof.routeInput, expected);
    if (proof.path === '/v1/artifacts') {
        const input = ArtifactJsonCreateHttpInputV1Schema.safeParse(proof.body);
        return admission !== undefined && effectActionId === binding.actionId && method === 'POST' && input.success
            && input.data.id === createDeploymentLinkContentArtifactIdV1({ ...binding, deploymentLinkAdmission: admission })
            && input.data.kind === DEPLOYMENT_TARGET_LINK_ARTIFACT_STORED_KIND_V1
            && input.data.approvalState === undefined && input.data.approvalSessionId === undefined && matches(input.data);
    }
    const artifact = /^\/v1\/artifacts\/([^/?#]+)(?:\/access\/(grants|recipients|key-envelopes))?$/u.exec(proof.path);
    if (artifact) {
        if (!admission || effectActionId !== binding.actionId) return false;
        const id = createDeploymentLinkContentArtifactIdV1({ ...binding, deploymentLinkAdmission: admission });
        if (artifact[1] !== encodeURIComponent(id)) {
            if (method !== 'GET' || proof.body !== undefined || artifact[2] !== undefined) return false;
            let existingId: string;
            try { existingId = decodeURIComponent(artifact[1]); } catch { return false; }
            if (encodeURIComponent(existingId) !== artifact[1] || !matches({ id: existingId })) return false;
            const environmentContent = await tx.deploymentEnvironment.findFirst({ where: {
                id: admission.environmentId, contentArtifactId: existingId, deletedAt: null,
            }, select: { id: true } });
            if (environmentContent) return true;
            // Inventory comparison opens existing Link content in the admitted owner scope.
            // The Artifact route still owns requester access and Account-mode disclosure.
            return await tx.deploymentTargetLink.findFirst({ where: {
                ...deploymentTargetLinkInventoryWhere({ scope: admission.owner }), contentArtifactId: existingId,
            }, select: { id: true } }) !== null;
        }
        if (method === 'GET' && proof.body === undefined
            && (artifact[2] === undefined || artifact[2] === 'grants' || artifact[2] === 'recipients')) return matches({ id });
        if (method === 'PUT' && artifact[2] === 'grants') {
            const input = ArtifactAccessGrantSetInputV1Schema.safeParse(proof.body);
            return input.success && admission.owner.kind === 'team' && input.data.artifactId === id
                && input.data.accessLevel === 'admin' && sameStrictJsonValue(input.data.principal, admission.owner)
                && matches({ id, ...input.data });
        }
        if (method === 'POST' && artifact[2] === 'key-envelopes') {
            const input = ArtifactRecipientKeyEnvelopeCommitInputV1Schema.safeParse(proof.body);
            return input.success && input.data.artifactId === id && matches({ id, ...input.data });
        }
        return false;
    }
    // The existing transport owner recognizes and validates the Link POST once.
    if (effectActionId === binding.actionId && isHttpOperation(binding.actionId)) {
        const body = proof.body;
        return admission !== undefined && body !== null && typeof body === 'object'
            && 'environmentId' in body && body.environmentId === admission.environmentId;
    }
    return null;
}

/** Authored Domain preparation retains its root Environment and create-only private candidate. */
export async function readDeploymentDomainPreparationHttpPurpose(tx: Tx, binding: ExternalActionExecutionAuthorizationBindingV1,
    effectActionId: string,
    proof: Readonly<{ method: string; path: string; body?: unknown; routeInput?: unknown; reviewedChild?: ReviewedActionChildHttpProofV1 }>,
    admittedEnvironmentId?: string,
    acceptedReceipt = false,
    preparationRead?: Readonly<{ artifact: boolean; environment: boolean }>,
): Promise<boolean | null> {
    const reviewed = binding.actionId !== effectActionId ? proof.reviewedChild : undefined;
    const admission = reviewed?.deploymentNativeAdmission ?? binding.deploymentNativeAdmission;
    if (!isDeploymentDomainAddActionIdV1(effectActionId)
        || deploymentChildEffectActionIdForRootV1(binding.actionId, binding.deploymentPreparationAdmission, effectActionId) !== effectActionId) return null;
    if (isDeploymentMembershipActionIdV1(binding.actionId, binding.deploymentPreparationAdmission)
        && reviewed?.actionId !== effectActionId) {
        // Membership reads and writes consume the accepted receipt/Domain owners.
        return null;
    }
    if (binding.actionId !== effectActionId && (!reviewed
        || reviewed.actionId !== effectActionId || !reviewed.role.startsWith('template.domain:'))) return false;
    if (!isDeploymentDomainNativeAdmissionV1(admission) || admission.actionId !== effectActionId
        || admission.authoredMetadataDigest === undefined) {
        // Prepared-reference Create children retain their incumbent exact-input
        // admission; an authored rewrite cannot borrow that compatibility path.
        return proof.body && typeof proof.body === 'object' && 'authoredInputDigest' in proof.body ? false : null;
    }
    const id = createDeploymentDomainContentArtifactIdV1({ ...binding, deploymentNativeAdmission: admission,
        ...(reviewed ? { reviewedChild: reviewed } : {}) });
    const publication = await readDeploymentPrivateCandidatePublicationHttpPurpose(tx, admission.environmentId, proof, id,
        DEPLOYMENT_DOMAIN_ARTIFACT_STORED_KIND_V1);
    if (publication === false) return false;
    const environmentRead = preparationRead?.environment ? DeploymentEnvironmentGetInputV1Schema.safeParse(proof.routeInput) : null;
    if (reviewed && acceptedReceipt && (preparationRead?.artifact
        || environmentRead?.success && environmentRead.data.serverId === binding.serverIdentityId
            && environmentRead.data.environmentId === admission.environmentId)) {
        // Deploy may already have succeeded while its reviewed Domain child is
        // preparing. Retain that root's Environment and ordinary requester Artifact
        // access; do not reopen deployment authority or borrow an in-progress slot.
        return await readTemplateDeploymentEnvironmentIdInTx(tx, binding) === admission.environmentId;
    }
    if (publication === null && admittedEnvironmentId === undefined) return null;
    if (reviewed && (!acceptedReceipt
        || await readTemplateDeploymentEnvironmentIdInTx(tx, binding) !== admission.environmentId)) return false;
    // The Domain purpose owner already matched the prepared storage operand.
    // This owner binds that operand and private publication to the root's Environment.
    return publication ?? admittedEnvironmentId === admission.environmentId;
}

/** Configure publishes only its backup candidate and the subsequent reviewed bindings candidate. */
export async function readDeploymentBackupConfigureHttpPurpose(tx: Tx, binding: ExternalActionExecutionAuthorizationBindingV1,
    effectActionId: string,
    proof: Readonly<{ method: string; path: string; body?: unknown; routeInput?: unknown; reviewedChild?: ReviewedActionChildHttpProofV1 }>,
    createdEnvironmentId?: string,
): Promise<boolean | null> {
    const reviewed = binding.actionId === DEPLOYMENT_BACKUP_CONFIGURE_ACTION_ID_V1 ? undefined : proof.reviewedChild;
    const admission = reviewed?.deploymentNativeAdmission ?? binding.deploymentNativeAdmission;
    if (!isDeploymentBackupConfigureNativeAdmissionV1(admission)) return null;
    if (reviewed && (createdEnvironmentId !== admission.environmentId || reviewed.actionId !== effectActionId)) return false;
    const bindings = effectActionId === DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1;
    if (bindings && (proof.reviewedChild?.actionId !== effectActionId || proof.reviewedChild.role !== 'backup.bindings')) return false;
    if (!bindings && effectActionId !== DEPLOYMENT_BACKUP_CONFIGURE_ACTION_ID_V1
        && effectActionId !== deploymentActionIds.DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1 && effectActionId !== PROJECT_SOURCE_READ_ACTION_ID_V1) return false;
    const method = proof.method.toUpperCase();
    const matches = (expected: unknown) => proof.routeInput === undefined || sameStrictJsonValue(proof.routeInput, expected);
    const environment = await tx.deploymentEnvironment.findUnique({ where: { id: admission.environmentId },
        select: { id: true, projectSourceId: true, contentArtifactId: true } });
    if (!environment) return false;
    if (method === 'GET' && proof.body === undefined) {
        if (!bindings && await isDeploymentPreparationMachineReadHttpPurposeInTx(tx,
            { ...binding, deploymentNativeAdmission: admission }, effectActionId, proof)) return true;
        if (await isDeploymentEnvironmentHttpReadInAdmittedScopeInTx(tx,
            { ...binding, deploymentNativeAdmission: admission }, proof, false, undefined, true)) return true;
        if (effectActionId === DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1) return false;
        if (bindings || effectActionId === DEPLOYMENT_BACKUP_CONFIGURE_ACTION_ID_V1) {
            if (proof.path === '/v1/account/encryption' || proof.path === '/v1/account/encryption/currentness') return matches({});
            if (proof.path === `/v1/artifacts/${encodeURIComponent(environment.contentArtifactId)}`) return matches({ id: environment.contentArtifactId });
        }
        if (bindings) return false;
        if (effectActionId === PROJECT_SOURCE_READ_ACTION_ID_V1) {
            const source = readDeploymentSourceReadOperands(binding.serverIdentityId, proof);
            return source !== null && await isDeploymentReadOperandInAdmittedScopeInTx(tx, binding, source,
                undefined, undefined, effectActionId) === true;
        }
        if (effectActionId !== DEPLOYMENT_BACKUP_CONFIGURE_ACTION_ID_V1) return false;
        if (proof.path === `/v1/projects/${encodeURIComponent(environment.projectSourceId)}/deployment-defaults?serverId=${encodeURIComponent(binding.serverIdentityId)}`)
            return matches({ serverId: binding.serverIdentityId, id: environment.projectSourceId });
        const defaults = await readProjectDeploymentDefaultsContentInTx(tx, binding.accountId, environment.projectSourceId);
        if (defaults.ok && defaults.content && proof.path === `/v1/artifacts/${encodeURIComponent(defaults.content.contentArtifactId)}`)
            return matches({ id: defaults.content.contentArtifactId });
    }
    if (admission.intent === 'rekeyAndSave' && !bindings) return false;
    const matchesBindingRevision = (revision: number) => revision === admission.expectedRevision
        || admission.intent !== 'rekeyAndSave' && revision === admission.expectedRevision + 1;
    if (admission.intent === 'test' || effectActionId !== DEPLOYMENT_BACKUP_CONFIGURE_ACTION_ID_V1 && !bindings) return false;
    const id = createDeploymentEnvironmentContentArtifactIdV1({ ...binding, environmentId: admission.environmentId,
        actionId: bindings ? DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1 : DEPLOYMENT_BACKUP_CONFIGURE_ACTION_ID_V1 });
    const publication = await readDeploymentPrivateCandidatePublicationHttpPurpose(tx, admission.environmentId, proof, id,
        DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1);
    if (publication !== null) return publication;
    if (method !== 'POST') return false;
    const base = `/v1/deployments/environments/${encodeURIComponent(admission.environmentId)}`;
    if (bindings && proof.path === `${base}/secret-launch-admission`) {
        const parsed = EnvironmentSecretAdmissionRequestV1Schema.safeParse(proof.body);
        return parsed.success && parsed.data.serverId === binding.serverIdentityId && parsed.data.environmentId === admission.environmentId
            && ('kind' in parsed.data
                ? matchesBindingRevision(parsed.data.expectedRevision) && parsed.data.buildMachineId === undefined
                : parsed.data.machineId === binding.machineId && parsed.data.installationId === binding.installationId
                    && parsed.data.materialization.kind === 'bindings' && matchesBindingRevision(parsed.data.materialization.expectedRevision)
                    && parsed.data.materialization.buildMachineId === undefined) && matches(parsed.data);
    }
    const parsed = bindings ? DeploymentBindingsSetStorageInputV1Schema.safeParse(proof.body)
        : DeploymentEnvironmentBackupSetInputV1Schema.safeParse(proof.body);
    return parsed.success && proof.path === `${base}/${bindings ? 'bindings' : 'backup'}`
        && parsed.data.serverId === binding.serverIdentityId && parsed.data.environmentId === admission.environmentId
        && (bindings ? matchesBindingRevision(parsed.data.expectedRevision) : parsed.data.expectedRevision === admission.expectedRevision)
        && parsed.data.contentArtifactId === id && parsed.data.contentHeaderVersion === 1 && parsed.data.contentBodyVersion === 1
        && matches(parsed.data);
}

/** First setup spends the existing signed update admission and its Environment's Source custody. */
async function readConfigurationDefaultsEnvironmentInTx(tx: Tx, binding: ExternalActionExecutionAuthorizationBindingV1) {
    const admission = binding.deploymentNativeAdmission;
    if (binding.actionId !== DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1
        || !isDeploymentEnvironmentUpdateNativeAdmissionV1(admission) || admission.defaultsFor === undefined) return null;
    const environment = await tx.deploymentEnvironment.findUnique({ where: { id: admission.environmentId },
        select: { id: true, projectSourceId: true, controllerMachineId: true, contentArtifactId: true, deletedAt: true } });
    return environment && !environment.deletedAt && environment.controllerMachineId === binding.machineId ? environment : null;
}

/**
 * Native deploy, backup, restore and backup setup select the definition's workspace references.
 * Row keys carry the Home server identity (O-DEPLOY ruling 2026-11-12); the row reader owns Account isolation.
 */
export function isDeploymentWorkspaceListHttpPurpose(serverId: string,
    proof: Readonly<{ method: string; path: string; body?: unknown; routeInput?: unknown }>,
): boolean {
    if (proof.method.toUpperCase() !== 'POST' || proof.path !== `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`) return false;
    const selection = ProjectAccountRowListRequestV1Schema.safeParse(proof.body);
    return selection.success && selection.data.serverId === serverId
        && selection.data.kinds?.length === 1 && selection.data.kinds[0] === 'workspace-ref'
        && (proof.routeInput === undefined || sameStrictJsonValue(proof.routeInput, selection.data));
}

/** Prepare and repository template authoring reopen only their signed checkout reference. */
function isDeploymentWorkspaceReadHttpPurpose(serverId: string,
    workspace: Extract<DeploymentPreparationAdmissionV1, { operation: 'prepare' }>['workspace'],
    proof: Readonly<{ method: string; path: string; body?: unknown; routeInput?: unknown }>,
): boolean {
    if (proof.method.toUpperCase() !== 'POST' || proof.path !== `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/read`) return false;
    const request = ProjectAccountRowReadRequestV1Schema.safeParse(proof.body);
    return request.success && sameStrictJsonValue(request.data, {
        key: { ...workspace, serverId },
    }) && (proof.routeInput === undefined || sameStrictJsonValue(proof.routeInput, request.data));
}

/** Signed authoring publishes one private candidate and retains its reviewed patch and CAS. */
export async function readDeploymentEnvironmentContentPreparationHttpPurpose(tx: Tx, binding: ExternalActionExecutionAuthorizationBindingV1,
    effectActionId: string,
    proof: Readonly<{ method: string; path: string; body?: unknown; routeInput?: unknown; reviewedChild?: ReviewedActionChildHttpProofV1 }>,
    isHttpOperation?: (actionId: string) => boolean,
): Promise<boolean | null> {
    const native = binding.deploymentNativeAdmission;
    if (binding.actionId === DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1
        && isDeploymentPreviewPreparationReadEffect(binding, effectActionId)
        && isDeploymentEnvironmentUpdateNativeAdmissionV1(native)) {
        if (effectActionId === DEPLOYMENT_ENVIRONMENT_LIST_ACTION_ID_V1) {
            return isHttpOperation?.(effectActionId) === true
                && await isDeploymentReadOperandInAdmittedScopeInTx(tx, binding, proof.routeInput,
                    undefined, undefined, DEPLOYMENT_ENVIRONMENT_LIST_ACTION_ID_V1) === true;
        }
        return isHttpOperation?.(effectActionId) === true
            && await isDeploymentReadOperandInAdmittedScopeInTx(tx, binding, proof.routeInput,
                undefined, undefined, effectActionId) === true;
    }
    if (binding.actionId === DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1
        && isDeploymentEnvironmentUpdateNativeAdmissionV1(native) && native.defaultsFor !== undefined) {
        // Backup choices read the stored definition's workspace, as a backup itself does (J29, #130).
        if (native.defaultsFor === 'backups' && effectActionId === binding.actionId
            && isDeploymentWorkspaceListHttpPurpose(binding.serverIdentityId, proof)) return true;
        // This read-only variant never borrows update's general Artifact publication purpose.
        if (proof.method.toUpperCase() !== 'GET' || proof.body !== undefined) return false;
        const environment = await readConfigurationDefaultsEnvironmentInTx(tx, binding);
        if (!environment) return false;
        const matches = (expected: unknown) => proof.routeInput === undefined || sameStrictJsonValue(proof.routeInput, expected);
        const environmentPath = `/v1/deployments/environments/${encodeURIComponent(environment.id)}?serverId=${encodeURIComponent(binding.serverIdentityId)}`;
        if (effectActionId === DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1
            || effectActionId === binding.actionId && proof.path === environmentPath)
            return isDeploymentEnvironmentHttpReadInAdmittedScopeInTx(tx, binding, proof);
        if (effectActionId === PROJECT_SOURCE_READ_ACTION_ID_V1)
            return Boolean(await readDeploymentPreparationSourceHttpPurposeInTx(tx, binding, effectActionId, proof));
        if (effectActionId !== binding.actionId) return false;
        if ((proof.path === '/v1/account/encryption' || proof.path === '/v1/account/encryption/currentness') && matches({})) return true;
        if (proof.path === `/v1/projects/${encodeURIComponent(environment.projectSourceId)}/deployment-defaults?serverId=${encodeURIComponent(binding.serverIdentityId)}`)
            return matches({ serverId: binding.serverIdentityId, id: environment.projectSourceId });
        // Backup choices inspect the admitted Environment's stored definition.
        if (native.defaultsFor === 'backups' && proof.path === `/v1/artifacts/${encodeURIComponent(environment.contentArtifactId)}`)
            return matches({ id: environment.contentArtifactId });
        const defaults = await readProjectDeploymentDefaultsContentInTx(tx, binding.accountId, environment.projectSourceId);
        return defaults.ok && defaults.content !== null
            && proof.path === `/v1/artifacts/${encodeURIComponent(defaults.content.contentArtifactId)}`
            && matches({ id: defaults.content.contentArtifactId });
    }
    if (effectActionId !== binding.actionId) return null;
    if (effectActionId === DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1 && binding.environmentId) {
        const environmentId = binding.environmentId;
        const id = createDeploymentEnvironmentContentArtifactIdV1({ ...binding, environmentId });
        const linkId = createDeploymentLinkContentArtifactIdV1({ ...binding, deploymentLinkAdmission: { environmentId } });
        const publishesLink = proof.path === '/v1/artifacts'
            ? typeof proof.body === 'object' && proof.body !== null && 'id' in proof.body && proof.body.id === linkId
            : proof.path.startsWith(`/v1/artifacts/${encodeURIComponent(linkId)}/access/`);
        return readDeploymentPrivateCandidatePublicationHttpPurpose(tx, environmentId, proof,
            publishesLink ? linkId : id, publishesLink ? DEPLOYMENT_TARGET_LINK_ARTIFACT_STORED_KIND_V1 : DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1);
    }
    const admission = binding.deploymentNativeAdmission;
    if (effectActionId !== DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1) return null;
    const update = proof.method.toUpperCase() === 'PATCH' && /^\/v1\/deployments\/environments\/[^/?#]+$/u.test(proof.path)
        ? DeploymentEnvironmentUpdateStorageInputV1Schema.safeParse(proof.body) : null;
    if (!isDeploymentEnvironmentUpdateNativeAdmissionV1(admission)) {
        if (update?.success && (hasDeploymentEnvironmentContentPatchV1(update.data.patch)
            || update.data.authoredInputDigest !== undefined)) return false;
        return null;
    }
    const id = createDeploymentEnvironmentContentArtifactIdV1({ ...binding, environmentId: admission.environmentId });
    if (update) {
        const parsed = update;
        if (!parsed.success || proof.path !== `/v1/deployments/environments/${encodeURIComponent(admission.environmentId)}`
            || parsed.data.environmentId !== admission.environmentId || parsed.data.serverId !== binding.serverIdentityId
            || proof.routeInput !== undefined && !sameStrictJsonValue(proof.routeInput, parsed.data)) return false;
        return parsed.data.authoredInputDigest === undefined
            ? computeDeploymentEnvironmentUpdateInputDigestV1(parsed.data) === admission.inputDigest
            : parsed.data.authoredInputDigest === admission.inputDigest && parsed.data.contentArtifactId === id
                && parsed.data.contentHeaderVersion === 1 && parsed.data.contentBodyVersion === 1
                && computeDeploymentEnvironmentUpdateMetadataDigestV1(parsed.data) === admission.authoredMetadataDigest;
    }
    return readDeploymentPrivateCandidatePublicationHttpPurpose(tx, admission.environmentId, proof, id,
        DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1);
}

async function readDeploymentPrivateCandidatePublicationHttpPurpose(tx: Tx, environmentId: string,
    proof: Readonly<{ method: string; path: string; body?: unknown; routeInput?: unknown }>,
    id: string, kind: string,
): Promise<boolean | null> {
    const method = proof.method.toUpperCase();
    const matches = (expected: unknown) => proof.routeInput === undefined || sameStrictJsonValue(proof.routeInput, expected);
    if (proof.path === '/v1/artifacts') {
        const input = ArtifactJsonCreateHttpInputV1Schema.safeParse(proof.body);
        return method === 'POST' && input.success && input.data.id === id
            && input.data.kind === kind
            && input.data.approvalState === undefined && input.data.approvalSessionId === undefined && matches(input.data);
    }
    const artifact = /^\/v1\/artifacts\/([^/?#]+)\/access\/(grants|recipients|key-envelopes)$/u.exec(proof.path);
    if (!artifact) return null;
    if (artifact[1] !== encodeURIComponent(id)) return false;
    if (method === 'GET' && proof.body === undefined && (artifact[2] === 'grants' || artifact[2] === 'recipients')) return matches({ id });
    if (method === 'PUT' && artifact[2] === 'grants') {
        const input = ArtifactAccessGrantSetInputV1Schema.safeParse(proof.body);
        if (!input.success || input.data.artifactId !== id || input.data.accessLevel !== 'admin'
            || !matches({ id, ...input.data })) return false;
        // Only read the admitted Environment's ownership fact; Artifact grants
        // and storage admission retain their existing authority owners.
        const environment = await tx.deploymentEnvironment.findUnique({ where: { id: environmentId }, select: { projectSourceId: true } });
        const owner = environment ? await readProjectSourceOwnerInTx(tx, environment.projectSourceId) : null;
        return owner?.kind === 'team' && sameStrictJsonValue(input.data.principal, owner);
    }
    if (method === 'POST' && artifact[2] === 'key-envelopes') {
        const input = ArtifactRecipientKeyEnvelopeCommitInputV1Schema.safeParse(proof.body);
        return input.success && input.data.artifactId === id && matches({ id, ...input.data });
    }
    return false;
}

/** Target enablement borrows only its selected allocation read or exact reviewed retention child. */
export async function readDeploymentTargetRetentionHttpPurpose(tx: Tx, binding: ExternalActionExecutionAuthorizationBindingV1,
    effectActionId: string,
    proof: Readonly<{ method: string; path: string; body?: unknown; routeInput?: unknown; reviewedChild?: ReviewedActionChildHttpProofV1 }>,
): Promise<DeploymentTargetRetentionHttpPurpose | null> {
    if (binding.actionId === DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1) {
        const native = binding.deploymentNativeAdmission;
        if (native?.kind !== 'restore' || effectActionId !== managedIds.MANAGED_LIST_ACTION_ID_V1 || proof.reviewedChild
            || proof.method.toUpperCase() !== 'POST' || proof.path !== managedMachineActionEndpointPathV1(effectActionId)
            || !sameStrictJsonValue(proof.body, { homeId: binding.serverIdentityId, enrolledMachineId: native.machineId })
            || proof.routeInput !== undefined && !sameStrictJsonValue(proof.routeInput, proof.body)) return null;
        const row = await tx.managedMachine.findFirst({ where: { homeId: binding.serverIdentityId, enrolledMachineId: native.machineId } });
        return { kind: 'restore-read', machines: row ? [redactManagedMachineCredentialReferences(projectManagedMachine(row))] : [] };
    }
    if (!readDeclaredPreparationScope(binding)?.targetRetention
        || proof.method.toUpperCase() !== 'POST'
        || proof.routeInput !== undefined && !sameStrictJsonValue(proof.routeInput, proof.body)) return null;
    if (effectActionId === managedIds.MANAGED_LIST_ACTION_ID_V1) {
        const parsed = ManagedListInputV1Schema.safeParse(proof.body);
        return !proof.reviewedChild && proof.path === managedMachineActionEndpointPathV1(effectActionId)
            && parsed.success && parsed.data.homeId === binding.serverIdentityId && parsed.data.enrolledMachineId !== undefined
            && (binding.actionId !== MACHINE_SERVICE_ADOPT_ACTION_ID
                || binding.deploymentPreparationAdmission?.operation === 'create' && parsed.data.enrolledMachineId === binding.machineId)
            ? { kind: 'preparation-read' } : null;
    }
    if (effectActionId !== managedIds.MANAGED_RETENTION_UPDATE_ACTION_ID_V1
        || proof.reviewedChild?.actionId !== effectActionId
        || !proof.reviewedChild.role.startsWith('target-retention:')
        || proof.reviewedChild.role.length === 'target-retention:'.length
        || proof.path !== '/v1/machines/managed/controller/admit-control') return null;
    const parsed = ManagedControlAdmissionInputV1Schema.safeParse(proof.body);
    return parsed.success && parsed.data.action === effectActionId
        && parsed.data.input.homeId === binding.serverIdentityId
        && 'retention' in parsed.data.input && parsed.data.input.retention.kind === 'until-delete'
        && computeActionInputApprovalDigestV1(effectActionId, parsed.data.input) === proof.reviewedChild.inputDigest
        ? { kind: 'reviewed-child', requestId: parsed.data.requestId } : null;
}

/** Preview preparation reads retain the signed root's exact placement and template operands. */
export function isDeploymentPreviewPreparationReadEffect(binding: ExternalActionExecutionAuthorizationBindingV1,
    effectActionId: string): boolean {
    return readDeclaredPreparationScope(binding)?.previewReads.includes(effectActionId) === true;
}

/** The signed create projection has one finite effect family, shared by HTTP admission and purpose binding. */
export function isDeploymentCreateHttpEffect(binding: ExternalActionExecutionAuthorizationBindingV1, effectActionId: string): boolean {
    return readDeclaredPreparationScope(binding)?.createEffects.includes(effectActionId) === true;
}

/** Spend admitted create authority on exact operands; permissions and source CAS were decided at issuance. */
export async function readDeploymentCreateHttpPurposeInTx(tx: Tx, binding: ExternalActionExecutionAuthorizationBindingV1,
    effectActionId: string,
    proof: Readonly<{ method: string; path: string; body?: unknown; routeInput?: unknown; reviewedChild?: ReviewedActionChildHttpProofV1 }>,
    isReadOnlyArtifactPurpose?: (proof: Readonly<{ method: string; path: string; body?: unknown; routeInput?: unknown }>) => boolean,
    isNativeHttpPurpose?: (proof: Readonly<{ method: string; path: string; body?: unknown; routeInput?: unknown }>,
        readActionId?: typeof DEPLOYMENT_PREPARATION_READ_ACTION_IDS_V1[number] | DeploymentDomainMetadataReadActionIdV1) => boolean,
): Promise<DeploymentCreateHttpPurpose | null> {
    const admission = binding.deploymentPreparationAdmission;
    if (!admission || admission.operation !== 'create' || !isDeploymentCreateHttpEffect(binding, effectActionId)) return null;
    if (effectActionId === DEPLOYMENT_ENVIRONMENT_LIST_ACTION_ID_V1) return isNativeHttpPurpose?.(proof) === true
        && await isDeploymentReadOperandInAdmittedScopeInTx(tx, binding, proof.routeInput,
            undefined, undefined, DEPLOYMENT_ENVIRONMENT_LIST_ACTION_ID_V1) === true
        ? { rootActionId: deploymentActionIds.DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1, effectActionId } : null;
    if (await isDeploymentPreparationMachineReadHttpPurposeInTx(tx, binding, effectActionId, proof)) {
        return { rootActionId: deploymentActionIds.DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1, effectActionId };
    }
    if (proof.path === '/v1/deployments/targets/list') {
        const owner = await readCreateAdmissionOwnerInTx(tx, admission);
        return effectActionId === binding.actionId && owner && isOwnerTargetLinkListHttpPurpose(binding.serverIdentityId, owner, proof)
            ? { rootActionId: deploymentActionIds.DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1, effectActionId } : null;
    }
    const domainEffect = effectActionId === deploymentActionIds.DEPLOYMENT_DOMAIN_ADD_ACTION_ID_V1;
    const deployEffect = effectActionId === deploymentActionIds.DEPLOYMENT_DEPLOY_ACTION_ID_V1;
    const receiptRead = isDeploymentReceiptReadActionIdV1(effectActionId);
    const configureEffect = effectActionId === DEPLOYMENT_BACKUP_CONFIGURE_ACTION_ID_V1;
    const backupBindings = effectActionId === DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1 && proof.reviewedChild?.role === 'backup.bindings';
    const adoptBindings = binding.actionId === MACHINE_SERVICE_ADOPT_ACTION_ID
        && effectActionId === DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1
        && proof.reviewedChild?.actionId === effectActionId && proof.reviewedChild.role === MACHINE_SERVICE_ADOPT_BINDINGS_ROLE_V1;
    const childEffect = effectActionId === deploymentActionIds.DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1 || configureEffect || domainEffect || deployEffect;
    if (domainEffect && proof.reviewedChild?.actionId !== effectActionId) return null;
    const environmentId = childEffect || receiptRead || effectActionId === deploymentActionIds.DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1 || proof.path.startsWith('/v1/artifacts/')
        ? await readPreviewCreateEnvironmentIdInTx(tx, binding, admission) : null;
    if (childEffect && (admission.mode !== 'apply'
        || !admission.copyFrom && !admission.catalogApp && !admission.preview && !adoptBindings || !environmentId)) return null;
    if (admission.preview && childEffect && (proof.reviewedChild?.actionId !== effectActionId
        || proof.reviewedChild.role !== (configureEffect ? 'preview.backup' : backupBindings ? 'backup.bindings'
            : deployEffect ? 'preview.deploy' : domainEffect ? 'template.domain:preview' : 'preview.bindings'))) return null;
    const admit = (allowed: boolean): DeploymentCreateHttpPurpose | null => allowed
        ? { rootActionId: deploymentActionIds.DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1, effectActionId,
            ...(childEffect && environmentId ? { child: { environmentId } } : {}) } : null;
    if (configureEffect || backupBindings) return admit(await readDeploymentBackupConfigureHttpPurpose(
        tx, binding, effectActionId, proof, environmentId!) === true);
    const method = proof.method.toUpperCase();
    const matches = (expected: unknown) => proof.routeInput === undefined || sameStrictJsonValue(proof.routeInput, expected);
    const deployRole = admission.preview ? 'preview.deploy' : 'template.deploy';
    const reviewedDeploy = proof.reviewedChild?.actionId === effectActionId && proof.reviewedChild.role === deployRole;
    if (deployEffect && proof.reviewedChild && !reviewedDeploy) return null;
    if (receiptRead) return admit(isNativeHttpPurpose?.(proof) === true
        && await isDeploymentReadOperandInAdmittedScopeInTx(tx, binding, proof.routeInput,
            undefined, undefined, effectActionId) === true);
    if (deployEffect && (proof.path === '/v1/artifacts' || proof.path.startsWith('/v1/artifacts/'))
        && await readDeploymentCandidatePublicationHttpPurposeInTx(tx, binding, effectActionId, proof)) {
        return reviewedDeploy ? admit(true) : { rootActionId: deploymentActionIds.DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1, effectActionId };
    }
    if (deployEffect && !proof.path.startsWith('/v1/artifacts/')) {
        const read = await readDeploymentPreparationHttpReadPurpose(tx, binding, effectActionId, proof,
            actionId => isNativeHttpPurpose?.(proof, actionId) === true);
        if (read) {
            const allowed = await isDeploymentReadOperandInAdmittedScopeInTx(tx, binding, read, undefined, undefined, read.actionId, undefined, true) === true;
            return allowed ? reviewedDeploy ? admit(true) : { rootActionId: deploymentActionIds.DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1, effectActionId } : null;
        }
        const parsed = DeploymentDeployAdmissionInputV1Schema.safeParse(proof.body);
        if (parsed.success) {
            const { actionOperationId: _operation, ...reviewedInput } = parsed.data;
            return admit(isNativeHttpPurpose?.(proof) === true
                && parsed.data.serverId === binding.serverIdentityId
                && parsed.data.environmentId === environmentId
                && proof.reviewedChild?.actionId === effectActionId
                && proof.reviewedChild.role === deployRole
                && computeActionInputApprovalDigestV1(effectActionId, reviewedInput) === proof.reviewedChild.inputDigest);
        }
        // Read-only native preparation precedes the candidate's reviewed digest.
        // Transitions are admitted separately against the accepted receipt.
        return isNativeHttpPurpose?.(proof)
            && isNativeDeploymentPreparationRead(method, proof.path)
            ? reviewedDeploy ? admit(true) : { rootActionId: deploymentActionIds.DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1, effectActionId } : null;
    }
    if (domainEffect && isReadOnlyArtifactPurpose?.(proof)) return admit(true);
    if (effectActionId === PROJECT_SOURCE_READ_ACTION_ID_V1) {
        const source = readDeploymentSourceReadOperands(binding.serverIdentityId, proof);
        if (admission.newProject) {
            const selected = await readDeploymentPreparationSourceHttpPurposeInTx(tx, binding, effectActionId, proof);
            return selected ? { rootActionId: deploymentActionIds.DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1, effectActionId, source: selected.source } : null;
        }
        return admit(source !== null && await isDeploymentReadOperandInAdmittedScopeInTx(tx, binding, source,
            undefined, undefined, effectActionId) === true);
    }
    if (effectActionId === DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1)
        return admit(await isDeploymentEnvironmentHttpReadInAdmittedScopeInTx(tx, binding, proof));
    if (method === 'GET' && proof.body === undefined) {
        // The root prepares its captured preview template before allocation;
        // a reviewed storage child reads only the Environment this root creates.
        if (await isDeploymentEnvironmentHttpReadInAdmittedScopeInTx(tx, binding, proof, false, undefined, childEffect)) return admit(true);
        if ((proof.path === '/v1/account/encryption' || proof.path === '/v1/account/encryption/currentness') && matches({})) return admit(true);
        if (!childEffect && admission.source && (proof.path === `/v1/projects/sources/${encodeURIComponent(admission.source.id)}?serverId=${encodeURIComponent(binding.serverIdentityId)}`
            || proof.path === `/v1/projects/${encodeURIComponent(admission.source.id)}/deployment-defaults?serverId=${encodeURIComponent(binding.serverIdentityId)}`)
            && matches({ serverId: binding.serverIdentityId, id: admission.source.id })) return admit(true);
    }
    if (childEffect && method === 'POST') {
        const base = `/v1/deployments/environments/${encodeURIComponent(environmentId!)}`;
        if (domainEffect) {
            const parsed = DeploymentDomainAddAdmissionInputV1Schema.safeParse(proof.body);
            if (!parsed.success || proof.path !== `${base}/domains` || parsed.data.environmentId !== environmentId
                || parsed.data.serverId !== binding.serverIdentityId || parsed.data.requestId !== binding.requestId
                || !matches(parsed.data)) return null;
            // Template selection has no native placements. The ordinary Domain
            // owner derives them; reviewed Artifact refs and revisions remain exact.
            const { actionOperationId: _operation, requestId: _request, placements: _placements, ...reviewedInput } = parsed.data;
            return admit(computeActionInputApprovalDigestV1(deploymentActionIds.DEPLOYMENT_DOMAIN_ADD_ACTION_ID_V1, reviewedInput)
                === proof.reviewedChild?.inputDigest);
        }
        if (proof.path === `${base}/bindings`) {
            const parsed = DeploymentBindingsSetStorageInputV1Schema.safeParse(proof.body);
            return admit(parsed.success && parsed.data.environmentId === environmentId
                && parsed.data.serverId === binding.serverIdentityId && matches(parsed.data));
        }
        if (proof.path === `${base}/secret-launch-admission`) {
            const parsed = EnvironmentSecretAdmissionRequestV1Schema.safeParse(proof.body);
            return admit(parsed.success && parsed.data.environmentId === environmentId && parsed.data.serverId === binding.serverIdentityId
                && ('kind' in parsed.data || parsed.data.materialization.kind === 'bindings') && matches(parsed.data));
        }
    }
    if (method === 'POST' && proof.path === '/v1/artifacts') {
        const parsed = ArtifactJsonCreateHttpInputV1Schema.safeParse(proof.body);
        if (await readDeploymentCandidatePublicationHttpPurposeInTx(tx, binding, effectActionId, proof)) return admit(true);
        return admit(parsed.success && (parsed.data.kind === undefined || parsed.data.kind === DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1
            || !childEffect && parsed.data.kind === DEPLOYMENT_TARGET_LINK_ARTIFACT_STORED_KIND_V1) && parsed.data.approvalState === undefined
            && parsed.data.approvalSessionId === undefined && matches(parsed.data));
    }
    if (method === 'POST' && proof.path === '/v1/deployments/environments') {
        const parsed = DeploymentEnvironmentCreateStorageInputV1Schema.safeParse(proof.body);
        const reviewedCreate = binding.actionId === MACHINE_SERVICE_ADOPT_ACTION_ID
            && effectActionId === DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1
            && proof.reviewedChild?.actionId === effectActionId
            && proof.reviewedChild.role === MACHINE_SERVICE_ADOPT_CREATE_ROLE_V1
            && parsed.success && computeActionInputApprovalDigestV1(effectActionId, parsed.data) === proof.reviewedChild.inputDigest;
        return admit((binding.actionId === DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1 || reviewedCreate)
            && !childEffect && admission.mode === 'apply' && parsed.success && parsed.data.serverId === binding.serverIdentityId
            && parsed.data.projectSourceId === admission.source?.id && sameStrictJsonValue(parsed.data.newProject, admission.newProject)
            && parsed.data.requestKey === admission.requestKey
            && parsed.data.protection === admission.protection && parsed.data.purpose === admission.purpose
            && parsed.data.deployerMode === admission.deployerMode
            && sameStrictJsonValue(parsed.data.copyFrom, admission.copyFrom)
            && sameStrictJsonValue(parsed.data.preview, admission.preview)
            && parsed.data.previewCompanionOfEnvironmentId === admission.previewCompanionOfEnvironmentId
            && (admission.candidate === undefined || Object.entries(admission.candidate)
                .every(([key, value]) => parsed.data[key as keyof typeof parsed.data] === value))
            && sameStrictJsonValue(parsed.data.deployerPrincipals ?? [], admission.deployerPrincipals ?? []) && matches(parsed.data));
    }
    const match = /^\/v1\/artifacts\/([^/?#]+)(?:\/access\/(grants|recipients|key-envelopes))?$/u.exec(proof.path);
    if (!match) return null;
    let artifactId: string;
    try { artifactId = decodeURIComponent(match[1]); } catch { return null; }
    if (!artifactId || encodeURIComponent(artifactId) !== match[1]) return null;
    if (method === 'GET' && proof.body === undefined && (match[2] === undefined || match[2] === 'recipients' || match[2] === 'grants')
        && matches({ id: artifactId })) {
        if (!childEffect && (artifactId === admission.candidate?.contentArtifactId
            // Every Environment-creating root (Create, adoption) owns one create-only candidate id.
            || deploymentPreparationOperationForActionV1(binding.actionId) === 'create'
                && admission.catalogApp === undefined
                && artifactId === createDeploymentEnvironmentContentArtifactIdV1({ ...binding,
                    actionId: DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1 })
            || admission.preview && await tx.deploymentEnvironment.findFirst({ where: {
                id: admission.preview.templateEnvironmentId, contentArtifactId: artifactId,
            }, select: { id: true } }))) return admit(true);
        if (!childEffect && admission.preview && await tx.deploymentDomain.findFirst({ where: {
            environmentId: admission.preview.templateEnvironmentId, contentArtifactId: artifactId,
        }, select: { id: true } })) return admit(true);
        const selectedEnvironmentIds = [environmentId, ...(!childEffect ? [admission.copyFrom?.environmentId,
            admission.previewCompanionOfEnvironmentId] : [])]
            .filter((id): id is string => id !== undefined && id !== null);
        if (selectedEnvironmentIds.length && await tx.deploymentEnvironment.findFirst({ where: { id: { in: selectedEnvironmentIds },
            OR: [{ contentArtifactId: artifactId }, ...(!childEffect || deployEffect
                ? [{ targetLinks: { some: { contentArtifactId: artifactId } } }] : []),
                ...(deployEffect ? [{ deployments: { some: { contentArtifactId: artifactId } } }] : [])] },
            select: { id: true } })) return admit(true);
        if (!childEffect && admission.source && match[2] === undefined && await tx.projectDeploymentDefaults.findFirst({
            where: { projectSourceId: admission.source.id, contentArtifactId: artifactId }, select: { projectSourceId: true },
        })) return admit(true);
        // Only adoption looks for an existing native target (findExistingNativeComposeTargetLinkV1).
        if (binding.actionId === MACHINE_SERVICE_ADOPT_ACTION_ID && effectActionId === binding.actionId && match[2] === undefined) {
            const owner = await readCreateAdmissionOwnerInTx(tx, admission);
            if (owner && await isOwnerRuntimeOwnServerLinkContentInTx(tx, binding.machineId, owner, artifactId)) return admit(true);
        }
    }
    if (domainEffect) return null;
    if (await readDeploymentCandidatePublicationHttpPurposeInTx(tx, binding, effectActionId, proof)) return admit(true);
    if (deployEffect) return null;
    // The same authenticated Artifact owner still decides grant eligibility,
    // current access, recipient census and key-envelope fencing at its routes.
    // Stored kind is optional on existing canonical writers; no hint is not a
    // new authority fact. A positively different kind is never a create operand.
    if (childEffect && await tx.deploymentEnvironment.findFirst({ where: {
        id: { not: environmentId! }, contentArtifactId: artifactId,
    }, select: { id: true } })) return null;
    const owner = await readCreateAdmissionOwnerInTx(tx, admission);
    if (owner?.kind !== 'team') return null;
    const artifact = await tx.artifact.findUnique({ where: { id: artifactId }, select: { kind: true, accountId: true } });
    if (!artifact || artifact.accountId !== binding.accountId
        || artifact.kind !== null && artifact.kind !== DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1
        && artifact.kind !== DEPLOYMENT_TARGET_LINK_ARTIFACT_STORED_KIND_V1) return null;
    if (method === 'GET' && proof.body === undefined && (match[2] === undefined || match[2] === 'recipients')) return admit(matches({ id: artifactId }));
    if (method === 'PUT' && match[2] === 'grants') {
        const parsed = ArtifactAccessGrantSetInputV1Schema.safeParse(proof.body);
        return admit(parsed.success && parsed.data.artifactId === artifactId && parsed.data.accessLevel === 'admin'
            && sameStrictJsonValue(parsed.data.principal, owner) && matches({ id: artifactId, ...parsed.data }));
    }
    if (method === 'POST' && match[2] === 'key-envelopes') {
        const parsed = ArtifactRecipientKeyEnvelopeCommitInputV1Schema.safeParse(proof.body);
        return admit(parsed.success && parsed.data.artifactId === artifactId && matches({ id: artifactId, ...parsed.data }));
    }
    return null;
}

/** The optional finite setup carrier admits this one metadata effect, not a managed family. */
export function isSetupDeploymentPreparationReadEffect(binding: ExternalActionExecutionAuthorizationBindingV1,
    effectActionId: string): boolean {
    return readDeclaredPreparationScope(binding)?.setupReads.includes(effectActionId) === true;
}

/** Setup spends current requester Manage on the exact prepared runtime member. */
async function readSetupDeploymentEnvironment(tx: Tx, binding: ExternalActionExecutionAuthorizationBindingV1,
    selected: SetupDeployment, authentication: DeploymentAuthentication) {
    if (deploymentPreparationOperationForActionV1(binding.actionId) !== 'setup') return null;
    const loaded = await loadDeploymentEnvironmentInTx(tx, binding.accountId, binding.serverIdentityId, selected.environment.id, authentication);
    if (!loaded.ok || !loaded.admission.canManage) return null;
    const member = await readSetupDeploymentTargetInTx(tx, loaded.row, selected);
    return member && !await admitDeploymentMachineInTx(tx, loaded.admission.owner,
        member.machineId, 'target', member.installationId) ? loaded.row : null;
}

async function readSetupDeploymentTargetInTx(tx: Tx, environment: DeploymentEnvironmentRow, selected: SetupDeployment) {
    if (environment.deletedAt || environment.revision !== selected.environment.revision
        || environment.runtimeTargetLinkId !== selected.target.id) return null;
    const link = await tx.deploymentTargetLink.findFirst({ where: { id: selected.target.id, environmentId: environment.id,
        deletedAt: null, detachedAt: null }, include: { machines: { where: { machineId: selected.machineId } } } });
    const member = link?.machines[0];
    if (!link || link.revision !== selected.target.revision || link.sourceKind !== 'host' || link.role !== 'runtime'
        || link.targetKind !== 'ownServer' || !member) return null;
    return member;
}
async function readTemplateEnvironmentId(tx: Tx, binding: Pick<ExternalActionExecutionAuthorizationBindingV1, 'accountId'>, admission: TemplateAdmission) {
    return admission.environment.kind === 'existing' ? admission.environment.environmentId
        : readCreatedDeploymentEnvironmentIdInTx(tx, binding.accountId, admission.environment.requestKey);
}

/** Reuse the admitted exact preview relation for both retained and newly allocated children. */
async function readCreateAdmissionOwnerInTx(tx: Tx, admission: CreateAdmission): Promise<ProjectSourceOwnerV1 | null> {
    return admission.newProject?.owner ?? (admission.source ? await readProjectSourceOwnerInTx(tx, admission.source.id) : null);
}

async function readPreviewCreateEnvironmentIdInTx(tx: Tx, binding: Pick<ExternalActionExecutionAuthorizationBindingV1, 'accountId'>,
    admission: CreateAdmission): Promise<string | null> {
    if (!admission.preview || !admission.source) return readCreatedDeploymentEnvironmentIdInTx(tx, binding.accountId, admission.requestKey);
    const rows = await tx.deploymentEnvironment.findMany({ where: { projectSourceId: admission.source.id,
        previewTemplateEnvironmentId: admission.preview.templateEnvironmentId, previewRepositoryId: admission.source.id,
        previewPullRequestId: admission.preview.pullRequestId, previewTargetLinkId: admission.preview.runtimeTargetLinkId,
        deletedAt: null }, select: { id: true } });
    return rows.length === 1 ? rows[0].id : rows.length === 0
        ? readCreatedDeploymentEnvironmentIdInTx(tx, binding.accountId, admission.requestKey) : null;
}

/** Reuse the template's existing/create request relation; never infer it from native operands. */
export async function readTemplateDeploymentEnvironmentIdInTx(tx: Tx, binding: ExternalActionExecutionAuthorizationBindingV1): Promise<string | null> {
    const admission = binding.deploymentPreparationAdmission;
    if (deploymentOperationForRootActionV1(binding.actionId, admission) !== 'deploy') return null;
    return admission?.operation === 'template' ? readTemplateEnvironmentId(tx, binding, admission)
        : admission?.operation === 'create' ? readPreviewCreateEnvironmentIdInTx(tx, binding, admission) : null;
}

/** The admitted create's allocation is custody, not another requester permission decision. */
export async function readAdmittedCreateDeploymentEnvironmentCustodyInTx(tx: Tx,
    binding: ExternalActionExecutionAuthorizationBindingV1) {
    if (binding.actionId !== deploymentActionIds.DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1) return null;
    const environmentId = await readTemplateDeploymentEnvironmentIdInTx(tx, binding);
    if (!environmentId) return null;
    const row = await tx.deploymentEnvironment.findUnique({ where: { id: environmentId } });
    const custody = row ? await readProjectSourceCustodyInTx(tx, row.projectSourceId) : null;
    return row && custody ? { row, ...custody } : null;
}

export async function isTemplateInstantiationAuthorizedInTx(tx: Tx,
    binding: Pick<ExternalActionExecutionAuthorizationBindingV1, 'accountId' | 'actionId' | 'machineId' | 'installationId' | 'serverIdentityId'>,
    admission: TemplateAdmission, authentication: DeploymentAuthentication): Promise<boolean> {
    if (binding.actionId !== DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1
        || admission.environment.kind === 'create' && admission.environment.controllerMachineId !== binding.machineId) return false;
    const source = admission.source ? await resolveProjectSourceAccessInTx(tx, binding.accountId, admission.source.id, authentication) : null;
    const owner = admission.newProject?.owner ?? (source?.ok ? source.owner : null);
    if (!owner || (admission.newProject ? !await canManageProjectSourceOwnerInTx(tx, binding.accountId, owner, authentication)
        : !source?.ok || !source.canManageOwner) || await admitDeploymentMachineInTx(tx, owner,
        admission.machineId, 'target', admission.target.installationId)) return false;
    const environmentId = await readTemplateEnvironmentId(tx, binding, admission);
    if (!environmentId) return admission.environment.kind === 'create' && admission.target.kind === 'new';
    const loaded = await loadDeploymentEnvironmentInTx(tx, binding.accountId, binding.serverIdentityId, environmentId, authentication);
    return loaded.ok && loaded.admission.canManage && matchesTemplateEnvironmentScopeInTx(tx, binding, admission, loaded.row);
}

/** The signed root already admitted its requester; later steps retain only its selected relations. */
async function readAdmittedTemplateInstantiationScopeInTx(tx: Tx,
    binding: Pick<ExternalActionExecutionAuthorizationBindingV1, 'accountId' | 'actionId' | 'machineId'>,
    admission: TemplateAdmission): Promise<Readonly<{ source: ProjectSourceV1 | undefined; environment: DeploymentEnvironmentRow | null }> | null> {
    if (binding.actionId !== DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1
        || admission.environment.kind === 'create' && admission.environment.controllerMachineId !== binding.machineId) return null;
    let source: ProjectSourceV1 | undefined;
    if (admission.source) {
        const custody = await readProjectSourceCustodyInTx(tx, admission.source.id);
        if (!custody || custody.owner.kind === 'account' && custody.owner.accountId !== binding.accountId) return null;
        source = custody.source;
    } else if (admission.newProject?.owner.kind === 'account' && admission.newProject.owner.accountId !== binding.accountId) return null;
    const environmentId = await readTemplateEnvironmentId(tx, binding, admission);
    if (!environmentId) return admission.environment.kind === 'create' && admission.target.kind === 'new'
        ? { source, environment: null } : null;
    // Mint decided controller and Link placement. A later controller or Link edit
    // carries its own revision CAS, which the admitted effect still has to pass.
    const environment = await tx.deploymentEnvironment.findUnique({ where: { id: environmentId } });
    return environment !== null && !environment.deletedAt
        && (!admission.source || environment.projectSourceId === admission.source.id)
        ? { source, environment } : null;
}

export async function isAdmittedTemplateInstantiationScopeCurrentInTx(tx: Tx,
    binding: Pick<ExternalActionExecutionAuthorizationBindingV1, 'accountId' | 'actionId' | 'machineId'>,
    admission: TemplateAdmission): Promise<boolean> {
    return await readAdmittedTemplateInstantiationScopeInTx(tx, binding, admission) !== null;
}

export type DeploymentPreparationSourceRead = Readonly<{ source: ProjectSourceV1; canManage: boolean }>;

/** Exact Source metadata spends the signed preparation's admitted Manage, never a renewed grant. */
export async function readDeploymentPreparationSourceHttpPurposeInTx(tx: Tx,
    binding: ExternalActionExecutionAuthorizationBindingV1, effectActionId: string,
    proof: Readonly<{ method: string; path: string; body?: unknown; routeInput?: unknown }>,
): Promise<DeploymentPreparationSourceRead | false | null> {
    const admission = binding.deploymentPreparationAdmission;
    const native = binding.deploymentNativeAdmission;
    const defaults = binding.actionId === DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1
        && isDeploymentEnvironmentUpdateNativeAdmissionV1(native) && native.defaultsFor !== undefined;
    if (effectActionId !== PROJECT_SOURCE_READ_ACTION_ID_V1
        || !defaults && admission?.operation !== 'template' && admission?.operation !== 'catalog'
            && !(admission?.operation === 'create' && admission.newProject)) return null;
    if (proof.method.toUpperCase() !== 'GET' || proof.body !== undefined) return false;
    const source = (await readAdmittedDeploymentScopeInTx(tx, binding, undefined, effectActionId))?.preparationSource;
    return source && proof.path === `/v1/projects/sources/${encodeURIComponent(source.id)}?serverId=${encodeURIComponent(binding.serverIdentityId)}`
        && (proof.routeInput === undefined || sameStrictJsonValue(proof.routeInput, { serverId: binding.serverIdentityId, id: source.id }))
        ? { source, canManage: admission?.operation !== 'create' } : false;
}

async function matchesTemplateEnvironmentScopeInTx(tx: Tx,
    binding: Pick<ExternalActionExecutionAuthorizationBindingV1, 'machineId'>,
    admission: TemplateAdmission, environment: DeploymentEnvironmentRow): Promise<boolean> {
    if (environment.deletedAt || environment.controllerMachineId !== binding.machineId
        || admission.source && environment.projectSourceId !== admission.source.id) return false;
    if (admission.target.kind !== 'existing') return true;
    if (environment.runtimeTargetLinkId !== admission.target.targetLinkId) return false;
    const link = await tx.deploymentTargetLink.findFirst({ where: { id: admission.target.targetLinkId, environmentId: environment.id,
        deletedAt: null, detachedAt: null }, include: { machines: { orderBy: { position: 'asc' } } } });
    return Boolean(link && link.sourceKind === 'host' && link.role === 'runtime' && link.targetKind === 'ownServer'
        && link.machines.some(member => member.machineId === admission.machineId && member.installationId === admission.target.installationId));
}

/** References spend only current Source authority; domain routes retain content and row admission. */
export async function isDeploymentPreparationAuthorizedInTx(tx: Tx, binding: ExternalActionExecutionAuthorizationBindingV1,
    admission: DeploymentPreparationAdmissionV1, authentication: DeploymentAuthentication = {},
): Promise<boolean> {
    return (await readDeploymentPreparationAuthorizationInTx(tx, binding, admission, authentication)).ok;
}

export async function readDeploymentPreparationAuthorizationInTx(tx: Tx, binding: ExternalActionExecutionAuthorizationBindingV1,
    admission: DeploymentPreparationAdmissionV1, authentication: DeploymentAuthentication = {},
): Promise<DeploymentPreparationAuthorization> {
    if (admission.operation === 'create') return readCreateSource(tx, binding, admission, authentication);
    return await isOtherDeploymentPreparationAuthorizedInTx(tx, binding, admission, authentication)
        ? { ok: true } : { ok: false, code: 'credential_scope_denied' };
}

async function isOtherDeploymentPreparationAuthorizedInTx(tx: Tx, binding: ExternalActionExecutionAuthorizationBindingV1,
    admission: Exclude<DeploymentPreparationAdmissionV1, { operation: 'create' }>, authentication: DeploymentAuthentication,
): Promise<boolean> {
    if (admission.operation === 'setup') {
        if (deploymentPreparationOperationForActionV1(binding.actionId) !== 'setup') return false;
        const receiverMachineIds = [...new Set([...(admission.machineTargets ?? []),
            ...[...admission.deployments, ...(admission.catalogSources ?? []),
                ...(admission.connectorGrants ?? [])].map(selected => selected.machineId)])];
        if (binding.admittedMachineRole !== undefined && receiverMachineIds.includes(binding.machineId)
            && binding.admittedMachineRole !== 'manage') return false;
        const receivers = await resolveMachineAdmissionsInTx(tx, { actorAccountId: binding.accountId,
            machineIds: receiverMachineIds.filter(machineId => machineId !== binding.machineId || binding.admittedMachineRole === undefined) });
        if ([...receivers.values()].some(receiver => receiver.kind !== 'admitted' || receiver.role !== 'manage')) return false;
        for (const selected of admission.deployments) {
            if (!await readSetupDeploymentEnvironment(tx, binding, selected, authentication)) return false;
        }
        return true;
    }
    if (admission.operation === 'template') return isTemplateInstantiationAuthorizedInTx(tx, binding, admission, authentication);
    if (admission.operation === 'catalog') {
        if (binding.actionId !== deploymentActionIds.DEPLOYMENT_PUBLISH_PREPARE_ACTION_ID_V1 || admission.machineId !== binding.machineId
            || admission.installationId !== binding.installationId) return false;
        if (admission.newProject) return await canManageProjectSourceOwnerInTx(tx, binding.accountId, admission.newProject.owner, authentication)
            && !await admitDeploymentMachineInTx(tx, admission.newProject.owner, admission.machineId, 'target', admission.installationId);
        if (!admission.source) return false;
        const source = await resolveProjectSourceAccessInTx(tx, binding.accountId, admission.source.id, authentication);
        return source.ok && source.canManageOwner && source.source.revision === admission.source.revision
            && !await admitDeploymentMachineInTx(tx, source.owner, admission.machineId, 'target', admission.installationId);
    }
    if (deploymentPreparationOperationForActionV1(binding.actionId) !== admission.operation) return false;
    if (admission.source) {
        const source = await resolveProjectSourceAccessInTx(tx, binding.accountId, admission.source.id, authentication);
        if (!source.ok || source.source.revision !== admission.source.revision) return false;
    }
    if (admission.environment) {
        const loaded = await loadDeploymentEnvironmentInTx(tx, binding.accountId, binding.serverIdentityId,
            admission.environment.id, authentication);
        if (!loaded.ok || loaded.row.deletedAt || !admission.source || loaded.row.projectSourceId !== admission.source.id) return false;
    }
    return true;
}

/** Resolve the read transport and keep membership discovery inside its admitted Home and Environment. */
export async function readDeploymentPreparationHttpReadPurpose(
    tx: Tx, binding: ExternalActionExecutionAuthorizationBindingV1, effectActionId: string,
    proof: Readonly<{ method: string; path: string; body?: unknown; routeInput?: unknown }>,
    isHttpOperation: (actionId: typeof DEPLOYMENT_PREPARATION_READ_ACTION_IDS_V1[number] | DeploymentDomainMetadataReadActionIdV1) => boolean,
): Promise<Readonly<{ actionId: typeof DEPLOYMENT_PREPARATION_READ_ACTION_IDS_V1[number] | DeploymentDomainMetadataReadActionIdV1;
    environmentId?: string; deploymentId?: string }> | null> {
    if (proof.method.toUpperCase() !== 'GET' || proof.body !== undefined) return null;
    const actionId = readDeclaredPreparationScope(binding, undefined, effectActionId)?.httpReads.find(isHttpOperation);
    if (!actionId) return null;
    const read = getActionSpec(actionId).inputSchema.safeParse(proof.routeInput);
    if (!read.success || !read.data || typeof read.data !== 'object' || !('serverId' in read.data)
        || read.data.serverId !== binding.serverIdentityId) return null;
    if ((isDeploymentDomainMetadataReadActionIdV1(actionId) || deploymentActionIds.isDeploymentDomainDnsActionIdV1(binding.actionId))
        && await isDeploymentReadOperandInAdmittedScopeInTx(tx, binding, read.data,
            undefined, undefined, actionId) !== true) return null;
    return { actionId,
        ...('environmentId' in read.data && typeof read.data.environmentId === 'string' ? { environmentId: read.data.environmentId } : {}),
        ...('deploymentId' in read.data && typeof read.data.deploymentId === 'string' ? { deploymentId: read.data.deploymentId } : {}) };

}

export async function isDeploymentPreparationHttpPurposeInTx(tx: Tx,
    binding: ExternalActionExecutionAuthorizationBindingV1, effectActionId: string,
    proof: Readonly<{ method: string; path: string; body?: unknown; routeInput?: unknown; reviewedChild?: ReviewedActionChildHttpProofV1 }>,
    authentication: DeploymentAuthentication,
    isReadOnlyArtifactPurpose?: (proof: Readonly<{ method: string; path: string; body?: unknown; routeInput?: unknown }>) => boolean,
    isNativeHttpPurpose?: (proof: Readonly<{ method: string; path: string; body?: unknown; routeInput?: unknown }>,
        readActionId?: typeof DEPLOYMENT_PREPARATION_READ_ACTION_IDS_V1[number] | DeploymentDomainMetadataReadActionIdV1) => boolean,
    /** A Setup target that signed the read; it spends only the app operands paired with it. */
    setupReceiverMachineId?: string,
): Promise<boolean> {
    const admission = binding.deploymentPreparationAdmission;
    if (setupReceiverMachineId !== undefined && admission?.operation !== 'setup') return false;
    if (!admission) return false;
    if (admission.operation === 'create') return await readDeploymentCreateHttpPurposeInTx(tx, binding, effectActionId, proof,
        isReadOnlyArtifactPurpose, isNativeHttpPurpose) !== null;
    if ((admission.operation === 'template' || admission.operation === 'catalog') && effectActionId === PROJECT_SOURCE_READ_ACTION_ID_V1) {
        return Boolean(await readDeploymentPreparationSourceHttpPurposeInTx(tx, binding, effectActionId, proof));
    }
    const routeMatches = (expected: unknown) => proof.routeInput === undefined || sameStrictJsonValue(proof.routeInput, expected);
    const method = proof.method.toUpperCase();
    if (admission.operation === 'setup') {
        if (deploymentPreparationOperationForActionV1(binding.actionId) !== 'setup' || method !== 'GET' || proof.body !== undefined) return false;
        const receiver = setupReceiverMachineId !== undefined;
        if (effectActionId === binding.actionId && proof.path === '/v1/account/encryption/currentness' && routeMatches({})) return true;
        const catalogSources = (admission.catalogSources ?? []).filter(selected => !receiver || selected.machineId === setupReceiverMachineId);
        const deployments = admission.deployments.filter(selected => !receiver || selected.machineId === setupReceiverMachineId);
        if (effectActionId === PROJECT_SOURCE_READ_ACTION_ID_V1) {
            const source = readDeploymentSourceReadOperands(binding.serverIdentityId, proof);
            return source !== null && await isDeploymentReadOperandInAdmittedScopeInTx(tx, binding, source,
                undefined, undefined, effectActionId, setupReceiverMachineId) === true;
        }
        if (effectActionId === binding.actionId || effectActionId === deploymentActionIds.DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1) {
            if (catalogSources.some(selected => proof.path
                === `/v1/projects/${encodeURIComponent(selected.source.id)}/deployment-defaults?serverId=${encodeURIComponent(binding.serverIdentityId)}`
                && routeMatches({ serverId: binding.serverIdentityId, id: selected.source.id }))) return true;
        }
        if (effectActionId === DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1 || effectActionId === binding.actionId
            || effectActionId === deploymentActionIds.DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1) {
            if (await isDeploymentEnvironmentHttpReadInAdmittedScopeInTx(tx, binding, proof, false, setupReceiverMachineId)) return true;
            if (effectActionId === DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1) return false;
        }
        if (effectActionId !== binding.actionId || isReadOnlyArtifactPurpose && !isReadOnlyArtifactPurpose(proof)) return false;
        const match = /^\/v1\/artifacts\/([^/?#]+)$/u.exec(proof.path);
        if (!match) return false;
        let artifactId: string;
        try { artifactId = decodeURIComponent(match[1]); } catch { return false; }
        if (encodeURIComponent(artifactId) !== match[1] || !routeMatches({ id: artifactId })) return false;
        for (const sourceId of new Set(catalogSources.map(selected => selected.source.id))) {
            const defaults = await readProjectDeploymentDefaultsContentInTx(tx, binding.accountId, sourceId);
            if (defaults.ok && defaults.content?.contentArtifactId === artifactId) return true;
        }
        let selected = deployments.find(selected => selected.candidate.contentArtifactId === artifactId);
        if (!selected) {
            // Resolve only owners of this exact Artifact, never an Environment
            // inventory or caller-supplied content relationship.
            const owners = await tx.deploymentEnvironment.findMany({ where: {
                id: { in: deployments.map(selected => selected.environment.id) }, contentArtifactId: artifactId,
            }, select: { id: true } });
            selected = deployments.find(selected => owners.some(owner => owner.id === selected.environment.id));
        }
        if (!selected) return false;
        // Mint admitted this signed selection; a step reads its current content without re-admitting it.
        const environment = await tx.deploymentEnvironment.findFirst({ where: { id: selected.environment.id, deletedAt: null },
            select: { contentArtifactId: true, contentHeaderVersion: true, contentBodyVersion: true } });
        if (!environment) return false;
        const expected = selected.candidate.contentArtifactId === artifactId ? selected.candidate : environment;
        if (expected.contentArtifactId !== artifactId) return false;
        const artifact = await tx.artifact.findUnique({ where: { id: artifactId }, select: { headerVersion: true, bodyVersion: true } });
        return artifact?.headerVersion === expected.contentHeaderVersion && artifact.bodyVersion === expected.contentBodyVersion;
    }
    if (readDeclaredPreparationScope(binding)?.templateDeployEffects.includes(effectActionId)) {
        if (admission.operation !== 'template') return false;
        const environmentId = await readTemplateDeploymentEnvironmentIdInTx(tx, binding);
        if (!environmentId) return false;
        if (await isDeploymentPreparationMachineReadHttpPurposeInTx(tx, binding, effectActionId, proof)) return true;
        // The reviewed deploy child retains its effect while using ordinary
        // preparation read transports. Bind those through the transport owner.
        const read = await readDeploymentPreparationHttpReadPurpose(tx, binding, effectActionId, proof,
            actionId => isNativeHttpPurpose?.(proof, actionId) === true);
        if (read) return await isDeploymentReadOperandInAdmittedScopeInTx(tx, binding, read, undefined, undefined, read.actionId, undefined, true) === true;
        if (!isNativeHttpPurpose?.(proof)) return false;
        const native = DeploymentDeployAdmissionInputV1Schema.safeParse(proof.body);
        if (!native.success) return isNativeDeploymentPreparationRead(method, proof.path);
        const { actionOperationId: _operation, ...reviewedInput } = native.data;
        // The declared effect list is untyped strings; the digest owner takes a catalog ActionId.
        const effect = ActionIdSchema.safeParse(effectActionId);
        return native.data.environmentId === environmentId
            && native.data.requestKey === admission.deploy?.requestKey
            && (admission.target.kind !== 'existing' || native.data.targetLinkId === admission.target.targetLinkId)
            && (!proof.reviewedChild || effect.success
                && computeActionInputApprovalDigestV1(effect.data, reviewedInput) === proof.reviewedChild.inputDigest);
    }
    if (admission.operation === 'template'
        && !await isAdmittedTemplateInstantiationScopeCurrentInTx(tx, binding, admission)) return false;
    if (admission.operation !== 'template') {
        if (admission.operation === 'catalog') {
            if (binding.actionId !== deploymentActionIds.DEPLOYMENT_PUBLISH_PREPARE_ACTION_ID_V1 || admission.machineId !== binding.machineId
                || admission.installationId !== binding.installationId) return false;
        } else if (deploymentPreparationOperationForActionV1(binding.actionId) !== admission.operation) return false;
        if (admission.source) {
            const custody = await readProjectSourceCustodyInTx(tx, admission.source.id);
            if (!custody || custody.source.revision !== admission.source.revision
                || admission.operation === 'catalog' && custody.owner.kind === 'account' && custody.owner.accountId !== binding.accountId) return false;
        }
        if ('environment' in admission && admission.environment) {
            const environment = await tx.deploymentEnvironment.findUnique({ where: { id: admission.environment.id } });
            if (!environment || environment.deletedAt || !admission.source || environment.projectSourceId !== admission.source.id) return false;
        }
    }
    if (admission.operation === 'catalog') {
        if (method !== 'GET' || proof.body !== undefined) return false;
        if (!admission.source) return effectActionId === binding.actionId
            && (proof.path === '/v1/account/encryption' || proof.path === '/v1/account/encryption/currentness') && routeMatches({});
        if (effectActionId !== binding.actionId) return false;
        if ((proof.path === '/v1/account/encryption' || proof.path === '/v1/account/encryption/currentness') && routeMatches({})) return true;
        if (proof.path === `/v1/projects/${encodeURIComponent(admission.source.id)}/deployment-defaults?serverId=${encodeURIComponent(binding.serverIdentityId)}`
            && routeMatches({ serverId: binding.serverIdentityId, id: admission.source.id })) return true;
        if (!/^\/v1\/artifacts\/[^/?#]+$/u.test(proof.path)) return false;
        const defaults = await readProjectDeploymentDefaultsContentInTx(tx, binding.accountId, admission.source.id);
        return defaults.ok && defaults.content !== null
            && proof.path === `/v1/artifacts/${encodeURIComponent(defaults.content.contentArtifactId)}`
            && routeMatches({ id: defaults.content.contentArtifactId })
            && (!isReadOnlyArtifactPurpose || isReadOnlyArtifactPurpose(proof));
    }
    if (admission.operation === 'template') {
        const environmentId = await readTemplateEnvironmentId(tx, binding, admission);
        if (effectActionId === DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1)
            return isDeploymentEnvironmentHttpReadInAdmittedScopeInTx(tx, binding, proof);
        const child = readDeclaredPreparationScope(binding)?.storageEffects.includes(effectActionId) === true;
        if (effectActionId !== binding.actionId && !child) return false;
        if (effectActionId === binding.actionId && admission.workspace
            && isDeploymentWorkspaceReadHttpPurpose(binding.serverIdentityId, admission.workspace, proof)) return true;
        if (method === 'GET' && proof.body === undefined) {
            if (await isDeploymentEnvironmentHttpReadInAdmittedScopeInTx(tx, binding, proof, false, undefined, true)) return true;
            if (await isDeploymentPreparationMachineReadHttpPurposeInTx(tx, binding, effectActionId, proof)) return true;
            if (effectActionId === binding.actionId && admission.source
                && proof.path === `/v1/projects/${encodeURIComponent(admission.source.id)}/deployment-defaults?serverId=${encodeURIComponent(binding.serverIdentityId)}`
                && routeMatches({ serverId: binding.serverIdentityId, id: admission.source.id })) return true;
            if (proof.path === '/v1/account/encryption' && routeMatches({})) return true;
            return isReadOnlyArtifactPurpose?.(proof) === true;
        }
        if (admission.mode !== 'apply') return false;
        if (effectActionId === binding.actionId && method === 'POST' && proof.path === '/v1/artifacts') {
            const parsed = ArtifactJsonCreateHttpInputV1Schema.safeParse(proof.body);
            return parsed.success && (parsed.data.kind === undefined || parsed.data.kind === DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1
                || parsed.data.kind === DEPLOYMENT_TARGET_LINK_ARTIFACT_STORED_KIND_V1) && parsed.data.approvalState === undefined
                && parsed.data.approvalSessionId === undefined && routeMatches(parsed.data);
        }
        if (effectActionId === deploymentActionIds.DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1) {
            const parsed = templateCreateStorageInputSchema.safeParse(proof.body);
            const selected = admission.environment;
            return selected.kind === 'create' && admission.target.kind === 'new' && method === 'POST'
                && proof.path === '/v1/deployments/environments' && parsed.success && parsed.data.serverId === binding.serverIdentityId
                && parsed.data.projectSourceId === admission.source?.id && sameStrictJsonValue(parsed.data.newProject, admission.newProject)
                && parsed.data.requestKey === selected.requestKey
                && parsed.data.protection === selected.protection && parsed.data.purpose === selected.purpose
                && parsed.data.deployerMode === selected.deployerMode
                && sameStrictJsonValue(parsed.data.deployerPrincipals ?? [], selected.deployerPrincipals ?? [])
                && parsed.data.controllerMachineId === selected.controllerMachineId
                && parsed.data.buildMachineId === (selected.buildMachineId ?? admission.machineId) && parsed.data.firstTargetLink !== undefined
                && sameStrictJsonValue(parsed.data.firstTargetLink.machines, [{ machineId: admission.machineId, installationId: admission.target.installationId }])
                && routeMatches(parsed.data);
        }
        if (!environmentId) return false;
        const path = `/v1/deployments/environments/${encodeURIComponent(environmentId)}`;
        if (effectActionId === deploymentActionIds.DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1) {
            const parsed = templateUpdateStorageInputSchema.safeParse(proof.body);
            return admission.environment.kind === 'existing' && method === 'PATCH' && proof.path === path && parsed.success
                && parsed.data.patch === undefined && parsed.data.environmentId === environmentId && parsed.data.serverId === binding.serverIdentityId
                && parsed.data.expectedRevision === admission.environment.expectedRevision && routeMatches(parsed.data);
        }
        if (effectActionId === deploymentActionIds.DEPLOYMENT_TARGET_LINK_ACTION_ID_V1) {
            const parsed = DeploymentTargetLinkInputV1Schema.safeParse(proof.body);
            return admission.target.kind === 'new' && method === 'POST' && proof.path === `${path}/targets` && parsed.success
                && parsed.data.serverId === binding.serverIdentityId && parsed.data.environmentId === environmentId
                && parsed.data.requestKey === binding.requestId && parsed.data.targetId === 'own-server' && parsed.data.source === undefined
                && parsed.data.role === 'runtime' && parsed.data.replacesLinkId === undefined
                && sameStrictJsonValue(parsed.data.machines, [{ machineId: admission.machineId, installationId: admission.target.installationId }]) && routeMatches(parsed.data);
        }
        if (effectActionId === deploymentActionIds.DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1) {
            // Authored binding changes publish one private candidate under the
            // reviewed bindings child's deterministic id before the bindings CAS.
            const publication = await readDeploymentPrivateCandidatePublicationHttpPurpose(tx, environmentId, proof,
                createDeploymentEnvironmentContentArtifactIdV1({ ...binding, actionId: DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1, environmentId }),
                DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1);
            if (publication !== null) return publication;
            if (method !== 'POST') return false;
            const launch = EnvironmentSecretAdmissionRequestV1Schema.safeParse(proof.body);
            if (proof.path === `${path}/secret-launch-admission`) return launch.success && launch.data.serverId === binding.serverIdentityId
                && launch.data.environmentId === environmentId && ('kind' in launch.data
                    || launch.data.machineId === binding.machineId && launch.data.installationId === binding.installationId
                        && launch.data.materialization.kind === 'bindings') && routeMatches(launch.data);
            const parsed = DeploymentBindingsSetStorageInputV1Schema.safeParse(proof.body);
            return proof.path === `${path}/bindings` && parsed.success && parsed.data.environmentId === environmentId
                && parsed.data.serverId === binding.serverIdentityId && routeMatches(parsed.data);
        }
        const parsed = DeploymentEnvironmentTemplateSetInputV1Schema.safeParse(proof.body);
        return effectActionId === binding.actionId && method === 'POST' && proof.path === `${path}/template` && parsed.success
            && parsed.data.environmentId === environmentId && parsed.data.serverId === binding.serverIdentityId && routeMatches(parsed.data);
    }
    if (effectActionId === PROJECT_SOURCE_READ_ACTION_ID_V1) {
        const source = readDeploymentSourceReadOperands(binding.serverIdentityId, proof);
        return source !== null && await isDeploymentReadOperandInAdmittedScopeInTx(tx, binding, source,
            undefined, undefined, effectActionId) === true;
    }
    if (effectActionId === DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1)
        return isDeploymentEnvironmentHttpReadInAdmittedScopeInTx(tx, binding, proof);
    if (effectActionId !== binding.actionId) return false;
    if (method === 'GET' && proof.body === undefined) {
        if ((proof.path === '/v1/account/encryption' || proof.path === '/v1/account/encryption/currentness')
            && routeMatches({})) return true;
        return false;
    }
    return admission.operation === 'prepare'
        && isDeploymentWorkspaceReadHttpPurpose(binding.serverIdentityId, admission.workspace, proof);
}
