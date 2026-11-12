import * as deploymentActionIds from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { DEPLOYMENT_RECEIPT_ARTIFACT_STORED_KIND_V1, DEPLOYMENT_DOMAIN_ARTIFACT_STORED_KIND_V1,
    DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1, type DeploymentChildRoutingV1 } from '@happier-dev/protocol';
import { isDeploymentDomainRemoveActionIdV1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { DeploymentStateV1Schema, getDeploymentTargetLinkLineageV1, isDeploymentRollbackSourceEligibleV1,
    type EnvironmentDomainSecretLaunchAdmissionV1 } from '@happier-dev/deployment-protocol';
import { isDeploymentDomainDnsNativeAdmissionV1, type ExternalActionExecutionAuthorizationBindingV1 } from '@happier-dev/protocol/actions/externalActionApi';
import type { DeploymentChildExecutionProofV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import type { SocketRpcMachineAdmissionContextV1 } from '@happier-dev/protocol/machines/machineAccessV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { Tx } from '@/storage/inTx';
import type { Prisma } from '@prisma/client';
import { admitDeploymentMachinesInTx, canDeployDeploymentEnvironment, projectDeploymentControllerPlacementFailure, type DeploymentAuthentication } from './deploymentAdmission';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { loadDeploymentEnvironmentInTx, loadDeploymentEnvironmentCustodyInTx, readCreatedDeploymentEnvironmentIdInTx } from './deploymentEnvironmentService';
import { admitDeploymentStoredContentInTx } from './deploymentStoredContent';
import { resolveMachineAdmissionInTx, resourceContentMatchesMode } from '@/app/machines/machineAccess';
import { readDeploymentAcceptedExecution, readAcceptedDeploymentReceiptInTx } from './deploymentAcceptedExecution';
import { readProjectSourceCustodyInTx } from '@/app/projects/sources/projectSourceService';
import { resolveEffectiveAccountEncryptionModeFromAccountRow } from '@/app/encryption/accountEncryptionMode';
import { deploymentChildEffectActionIdForRootV1 } from '@happier-dev/protocol';
import { readAcceptedDeploymentDomainInTx, hasCurrentDeploymentDomainCaptureInTx,
    type DeploymentDomainJobAdmission } from './deploymentDomainService';
import { readTemplateDeploymentEnvironmentIdInTx, readAdmittedCreateDeploymentEnvironmentCustodyInTx,
    readDeploymentPreparationEnvironmentIdInTx } from './deploymentPreparationAuthorization';
import { readDeploymentMembershipAdmissionInTx } from './deploymentMembershipService';
import { readDeploymentTargetAuthorizationInTx, readAdmittedDeploymentDataQueryScopeInTx } from './deploymentReadAuthorization';
import type { DeploymentContentReference } from './deploymentStoredContent';
import { projectManagedMachine } from '@/app/machines/managed/managedMachineProjection';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';

export type DeploymentChildAdmission = Readonly<{
    binding: ExternalActionExecutionAuthorizationBindingV1; routing: DeploymentChildRoutingV1;
    /** Captured placements from this request's single accepted-job lookup. */
    acceptedReceipt?: NonNullable<Awaited<ReturnType<typeof readAcceptedDeploymentReceiptInTx>>>;
    domainJob?: DeploymentDomainJobAdmission;
    /** Requester Use and the destination codec are admitted together once per child. */
    destinationCodecAdmission?: SocketRpcMachineAdmissionContextV1;
    /** Populated only after authentication verifies the captured controller's signature. */
    domainAdmission?: EnvironmentDomainSecretLaunchAdmissionV1;
    /** Exact read scope captured by the reviewed role bootstrap admission. */
    dataRoleArtifactContents?: readonly DeploymentContentReference[];
    /** Exact enrolled allocation admitted for this signed pre-restore snapshot child. */
    snapshotManagedMachine?: ManagedMachineV1;
}>;

export { isDeploymentPreparationMachineReadHttpPurposeInTx } from './deploymentPreparationAuthorization';

/** Consumers retain this request's admission instead of repeating the job lookup. */
export async function readDeploymentChildAdmissionInTx(tx: Tx, binding: ExternalActionExecutionAuthorizationBindingV1,
    routing: DeploymentChildRoutingV1, authentication: DeploymentAuthentication = {},
    admittedReadContinuation?: true,
): Promise<DeploymentChildAdmission | ActionExecuteFailure | null> {
    if (deploymentChildEffectActionIdForRootV1(binding.actionId, binding.deploymentPreparationAdmission, routing.actionId) !== routing.actionId
        || binding.target.kind !== 'machine' || binding.target.machineId !== binding.machineId
        || routing.input.serverId !== binding.serverIdentityId
        || binding.environmentId !== undefined && binding.environmentId !== routing.input.environmentId) return null;
    if (routing.kind === 'domainDns') {
        const native = binding.deploymentNativeAdmission;
        if (!isDeploymentDomainDnsNativeAdmissionV1(native)) return null;
        const { kind: _kind, actionId: _actionId, ...admitted } = native;
        const { serverId: _serverId, ...selected } = routing.input;
        if (!sameStrictJsonValue(admitted, selected)) return null;
    } else if (isDeploymentDomainDnsNativeAdmissionV1(binding.deploymentNativeAdmission)) return null;
    if (routing.kind === 'snapshot') {
        const native = binding.deploymentNativeAdmission;
        if (native?.kind !== 'restore' || native.mode !== 'confirm' || native.snapshot === false
            || native.environmentId !== routing.input.environmentId || native.targetLinkId !== routing.input.targetLinkId
            || native.machineId !== routing.input.machineId || native.installationId !== routing.input.installationId
            || native.prepareOperationId !== routing.input.prepareOperationId || native.expectedRevision !== routing.input.expectedRevision) return null;
        const row = await tx.managedMachine.findFirst({ where: { id: routing.managedId,
            homeId: binding.serverIdentityId, enrolledMachineId: native.machineId,
            controllerMachineId: routing.machineId, controllerInstallationId: routing.installationId,
            intentRevision: routing.intentRevision } });
        return row ? { binding, routing, snapshotManagedMachine: projectManagedMachine(row) } : null;
    }
    if (routing.kind === 'domainDns' && admittedReadContinuation) return { binding, routing };
    if (routing.kind === 'dataRole') {
        // The receiver signs the already admitted finite effect. Only content
        // membership is read here; requester permission is not admitted again.
        if (admittedReadContinuation) {
            const scope = await readAdmittedDeploymentDataQueryScopeInTx(tx, {
                actionId: deploymentActionIds.DEPLOYMENT_DATA_QUERY_ACTION_ID_V1, ...routing.input, targetLinkId: routing.targetLinkId,
                deploymentId: routing.deploymentId, machineId: routing.machineId, installationId: routing.installationId,
            });
            return scope ? { binding, routing, dataRoleArtifactContents: [
                ...scope.artifactContents, ...(routing.candidateContent ? [routing.candidateContent] : []),
            ] } : null;
        }
        const loaded = await loadDeploymentEnvironmentInTx(tx, binding.accountId, routing.input.serverId,
            routing.input.environmentId, authentication);
        if (!loaded.ok || !loaded.admission.canManage || loaded.row.deletedAt
            || loaded.row.revision !== routing.input.expectedRevision) return null;
        if (loaded.row.controllerMachineId !== binding.machineId) {
            return projectDeploymentControllerPlacementFailure(loaded.row.controllerMachineId);
        }
        const selected = await readDeploymentTargetAuthorizationInTx(tx, loaded.row, {
            actionId: deploymentActionIds.DEPLOYMENT_DATA_QUERY_ACTION_ID_V1, environmentId: routing.input.environmentId,
            expectedRevision: routing.input.expectedRevision, deploymentId: routing.deploymentId,
            targetLinkId: routing.targetLinkId, machineId: routing.machineId, installationId: routing.installationId });
        if (!selected || await admitDeploymentMachinesInTx(tx, loaded.admission.owner, [
            { machineId: binding.machineId, installationId: binding.installationId, role: 'controller' },
            { machineId: routing.machineId, installationId: routing.installationId, role: 'target' },
        ])) return null;
        if (routing.candidateContent && await admitDeploymentStoredContentInTx(tx, binding.accountId,
            loaded.admission.owner, routing.candidateContent, DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1, 'read')) return null;
        const destination = await resolveMachineAdmissionInTx(tx, { actorAccountId: binding.accountId,
            machineId: routing.machineId, requiredRole: 'use' });
        if (destination.kind !== 'admitted' || destination.installationId !== routing.installationId) return null;
        const { kind: _kind, ...destinationCodecAdmission } = destination;
        return { binding, routing, destinationCodecAdmission };
    }
    if (routing.kind === 'domain' && routing.actionId !== deploymentActionIds.DEPLOYMENT_DOMAIN_VERIFY_ACTION_ID_V1) {
        if (routing.actionOperationId === undefined) return null;
        const domainJob = await readAcceptedDeploymentDomainInTx(tx, binding, {
            ...routing.input, expectedDomainRevision: routing.expectedDomainRevision, actionOperationId: routing.actionOperationId, capture: routing.capture });
        return domainJob ? { binding, routing, domainJob } : null;
    }
    if (routing.kind === 'domainDiscover' && routing.actionId === deploymentActionIds.DEPLOYMENT_DOMAIN_ADD_ACTION_ID_V1 && routing.input.membershipDeploymentId) {
        const admitted = await readDeploymentMembershipAdmissionInTx(tx, binding, routing.input);
        return admitted && (admitted.members.some(member => member.machineId === routing.machineId
            && member.installationId === routing.installationId)
            || admitted.link.environmentId === routing.input.environmentId && await tx.deploymentEnvironment.findFirst({ where: {
                id: routing.input.environmentId, edgeMachineId: routing.machineId }, select: { id: true } }))
            ? { binding, routing } : null;
    }
    const current = await isCurrentDeploymentChildRoutingInTx(tx, binding, routing, authentication);
    if (current === null || current === false) return null;
    if (typeof current !== 'boolean') {
        return 'ok' in current ? current : { binding, routing, acceptedReceipt: current };
    }
    // These destinations are selected after mint. Source custody alone never grants the requester Use.
    const destination = await resolveMachineAdmissionInTx(tx, { actorAccountId: binding.accountId,
        machineId: routing.machineId, requiredRole: 'use' });
    if (destination.kind !== 'admitted' || destination.installationId !== routing.installationId) return null;
    const { kind: _kind, ...destinationCodecAdmission } = destination;
    return { binding, routing, destinationCodecAdmission };
}

export async function isCurrentDeploymentChildInTx(tx: Tx, binding: ExternalActionExecutionAuthorizationBindingV1,
    routing: DeploymentChildRoutingV1, authentication: DeploymentAuthentication = {},
): Promise<boolean> {
    const admitted = await readDeploymentChildAdmissionInTx(tx, binding, routing, authentication);
    return admitted !== null && !('ok' in admitted);
}

export type DeploymentChildMachineRead = Readonly<{
    machineId: string; installationId: string; actorAccountId: string; routing?: DeploymentChildRoutingV1;
    codecAdmission: SocketRpcMachineAdmissionContextV1;
    archiveOrigin?: DeploymentChildExecutionProofV1['archiveOrigin'];
}>;

/** Admitted native custody opens only its exact codec; key material keeps its own mode/readiness boundary. */
export async function readDeploymentChildMachineReadInTx(tx: Tx, admitted: DeploymentChildAdmission,
    machineId: string, authentication: DeploymentAuthentication = {},
    archiveOrigin?: DeploymentChildExecutionProofV1['archiveOrigin'],
): Promise<DeploymentChildMachineRead | null> {
    const { binding, routing } = admitted;
    if (!archiveOrigin && machineId === routing.machineId && admitted.destinationCodecAdmission) {
        return { machineId, installationId: admitted.destinationCodecAdmission.installationId,
            actorAccountId: binding.accountId, routing, codecAdmission: admitted.destinationCodecAdmission };
    }
    if (routing.kind === 'dataRole') return null;
    if (routing.kind === 'domain' || routing.kind === 'domainDiscover' || routing.kind === 'domainDns' || routing.kind === 'snapshot') {
        if (archiveOrigin || machineId !== routing.machineId) return null;
        const machine = await tx.machine.findUnique({ where: { id: machineId }, select: { accountId: true, installationId: true,
            metadata: true, daemonState: true, dataEncryptionKey: true,
            revokedAt: true, replacedByMachineId: true, account: { select: { encryptionMode: true } } } });
        if (!machine || machine.installationId !== routing.installationId || machine.revokedAt || machine.replacedByMachineId) return null;
        const mode = resolveEffectiveAccountEncryptionModeFromAccountRow(machine.account);
        if (mode.status !== 'ready' || !resourceContentMatchesMode(machine, mode.mode)) return null;
        return { machineId, installationId: routing.installationId, actorAccountId: binding.accountId, routing,
            codecAdmission: { actorAccountId: binding.accountId, machineId, installationId: routing.installationId,
                custodianAccountId: machine.accountId, role: 'use', encryptionMode: mode.mode } };
    }
    const preparation = routing.kind === 'prepare' || routing.kind === 'review';
    const rootAction = ActionIdSchema.safeParse(binding.actionId);
    const preparationScope = rootAction.success ? getActionSpec(rootAction.data).deploymentPreparationScope?.(binding) : undefined;
    const allocated = preparation && preparationScope?.environment === 'create'
        ? await readAdmittedCreateDeploymentEnvironmentCustodyInTx(tx, binding) : null;
    if (preparation && preparationScope?.environment === 'create' && !allocated) return null;
    const environment = allocated ? { ok: true as const, row: allocated.row, owner: allocated.owner } : preparation
        ? await loadDeploymentEnvironmentInTx(tx, binding.accountId, routing.input.serverId, routing.input.environmentId, authentication)
        // The signed child already passed the accepted-receipt active-job lookup.
        // Withdrawal applies to new admission, not reads within this finite job.
        : await loadDeploymentEnvironmentCustodyInTx(tx, routing.input);
    if (!environment.ok) return null;
    const accepted = admitted.acceptedReceipt ? readDeploymentAcceptedExecution(admitted.acceptedReceipt) : null;
    const capturedMachines = [{ machineId: routing.machineId, installationId: routing.installationId },
        accepted?.controller, accepted?.builder];
    let owner = 'admission' in environment ? environment.admission.owner : environment.owner;
    if (archiveOrigin) {
        if (routing.kind !== 'member' && routing.kind !== 'build' || routing.kind === 'member' && routing.phase === 'cleanup') return null;
        if (machineId !== archiveOrigin.holderMachineId && machineId !== routing.machineId) return null;
        let deploymentId: string | null = routing.kind === 'member' ? routing.selectedDeploymentId : routing.deploymentId;
        let expectedEnvironmentId: string | undefined = routing.input.environmentId;
        const seen = new Set<string>();
        let found = false;
        while (deploymentId) {
            if (seen.has(deploymentId)) return null;
            seen.add(deploymentId);
            const receipt: Awaited<ReturnType<Tx['deployment']['findUnique']>> = await tx.deployment.findUnique({ where: { id: deploymentId } });
            if (!receipt || expectedEnvironmentId !== undefined && receipt.environmentId !== expectedEnvironmentId
                || receipt.id !== routing.deploymentId && !['succeeded', 'running_unverified'].includes(receipt.state)) return null;
            const sourceEnvironment = await tx.deploymentEnvironment.findUnique({ where: { id: receipt.environmentId },
                select: { projectSourceId: true } });
            const source = sourceEnvironment ? await readProjectSourceCustodyInTx(tx, sourceEnvironment.projectSourceId) : null;
            if (!source) return null;
            const promotedFrom: string | null = 'promotedFromDeploymentId' in receipt && typeof receipt.promotedFromDeploymentId === 'string'
                ? receipt.promotedFromDeploymentId : null;
            if (receipt.operation === 'rollback' ? !receipt.rollbackOfDeploymentId || promotedFrom !== null
                : receipt.operation === 'promote' ? !promotedFrom || receipt.rollbackOfDeploymentId !== null
                    : receipt.operation !== 'deploy' || receipt.rollbackOfDeploymentId !== null || promotedFrom !== null) return null;
            if (receipt.id === archiveOrigin.deploymentId) {
                if (receipt.environmentId !== archiveOrigin.environmentId) return null;
                owner = source.owner;
                found = true;
                break;
            }
            deploymentId = receipt.operation === 'rollback' ? receipt.rollbackOfDeploymentId : promotedFrom;
            expectedEnvironmentId = receipt.operation === 'rollback' ? receipt.environmentId : undefined;
        }
        const capturedHolder = capturedMachines.some(machine => machine?.machineId === archiveOrigin.holderMachineId
            && machine.installationId === archiveOrigin.holderInstallationId);
        // A holder outside this job's captured placements is a new admission.
        if (!found || !capturedHolder && await admitDeploymentMachinesInTx(tx, owner, [{ machineId: archiveOrigin.holderMachineId,
            installationId: archiveOrigin.holderInstallationId, role: 'target' }])) return null;
    } else {
        // Origin-free reads are only the existing installed setup roles, not archive-holder discovery.
        const selected = preparation
            ? [routing.machineId, environment.row.controllerMachineId, environment.row.buildMachineId].includes(machineId)
            : capturedMachines.some(machine => machine?.machineId === machineId);
        if (!selected
            || preparation && await admitDeploymentMachinesInTx(tx,
                'admission' in environment ? environment.admission.owner : environment.owner,
                [{ machineId, role: 'target' }])) return null;
    }
    const machine = await tx.machine.findUnique({ where: { id: machineId }, select: { accountId: true, installationId: true,
        metadata: true, daemonState: true, dataEncryptionKey: true,
        revokedAt: true, replacedByMachineId: true, account: { select: { encryptionMode: true } } } });
    if (!machine?.installationId || machine.revokedAt || machine.replacedByMachineId
        || archiveOrigin && machineId === archiveOrigin.holderMachineId
            && machine.installationId !== archiveOrigin.holderInstallationId) return null;
    const mode = resolveEffectiveAccountEncryptionModeFromAccountRow(machine.account);
    if (mode.status !== 'ready' || !resourceContentMatchesMode(machine, mode.mode)) return null;
    const admittedCodec = preparation
        ? await resolveMachineAdmissionInTx(tx, { actorAccountId: binding.accountId, machineId, requiredRole: 'use' })
        : { kind: 'admitted' as const, actorAccountId: binding.accountId, machineId, installationId: machine.installationId,
            custodianAccountId: machine.accountId, role: 'use' as const, encryptionMode: mode.mode } satisfies
                SocketRpcMachineAdmissionContextV1 & Readonly<{ kind: 'admitted' }>;
    if (admittedCodec.kind !== 'admitted' || !admittedCodec.installationId) return null;
    const { kind: _kind, ...codecAdmission } = admittedCodec;
    return { machineId, installationId: admittedCodec.installationId, actorAccountId: binding.accountId, routing, codecAdmission,
        ...(archiveOrigin ? { archiveOrigin } : {}) };
}

/** ActionSpec selects preparation custody; accepted jobs retain their captured admission. */
async function isCurrentDeploymentChildRoutingInTx(tx: Tx,
    binding: ExternalActionExecutionAuthorizationBindingV1, routing: Exclude<DeploymentChildRoutingV1, { kind: 'dataRole' | 'snapshot' }>,
    authentication: DeploymentAuthentication = {},
): Promise<boolean | ActionExecuteFailure | Awaited<ReturnType<typeof readAcceptedDeploymentReceiptInTx>>> {
    const rootAction = ActionIdSchema.safeParse(binding.actionId);
    const preparationScope = rootAction.success ? getActionSpec(rootAction.data).deploymentPreparationScope?.(binding) : undefined;
    if (routing.kind === 'domain' || routing.kind === 'domainDiscover' || routing.kind === 'domainDns') {
        if (preparationScope?.environment === 'template'
            && await readTemplateDeploymentEnvironmentIdInTx(tx, binding) !== routing.input.environmentId) return false;
        if (preparationScope?.environment === 'create'
            && (binding.deploymentPreparationAdmission?.operation !== 'create'
                || await readCreatedDeploymentEnvironmentIdInTx(tx, binding.accountId, binding.deploymentPreparationAdmission.requestKey)
                    !== routing.input.environmentId)) return false;
        const loaded = await loadDeploymentEnvironmentInTx(tx, binding.accountId, routing.input.serverId,
            routing.input.environmentId, authentication);
        if (!loaded.ok || loaded.row.deletedAt) return false;
        if (loaded.row.controllerMachineId !== binding.machineId) {
            return projectDeploymentControllerPlacementFailure(loaded.row.controllerMachineId);
        }
        if (routing.kind === 'domain') {
            if (!await hasCurrentDeploymentDomainCaptureInTx(tx, { ...routing.input,
                expectedDomainRevision: routing.expectedDomainRevision, capture: routing.capture })) return false;
        } else {
            if (!loaded.admission.canManage || loaded.row.revision !== routing.input.expectedRevision
                || loaded.row.runtimeTargetLinkId !== routing.input.targetLinkId) return false;
            if (routing.kind !== 'domainDns' && isDeploymentDomainRemoveActionIdV1(routing.actionId) && !await tx.deploymentDomain.findFirst({ where: {
                id: routing.input.domainId, environmentId: loaded.row.id, targetLinkId: routing.input.targetLinkId,
                revision: routing.input.expectedDomainRevision, deletedAt: null,
                contentArtifactId: routing.input.contentArtifactId, contentHeaderVersion: routing.input.contentHeaderVersion,
                contentBodyVersion: routing.input.contentBodyVersion,
            }, select: { id: true } })) return false;
            const link = await tx.deploymentTargetLink.findFirst({ where: { id: routing.input.targetLinkId,
                environmentId: loaded.row.id, deletedAt: null, detachedAt: null, role: 'runtime', sourceKind: 'host', targetKind: 'ownServer',
                revision: routing.input.expectedTargetLinkRevision }, select: { machines: { where: { machineId: routing.machineId,
                    installationId: routing.installationId }, select: { machineId: true } } } });
            if (!link || !link.machines.length && loaded.row.edgeMachineId !== routing.machineId
                || routing.kind === 'domainDns' && loaded.row.edgeMachineId !== null && loaded.row.edgeMachineId !== routing.machineId
                || routing.kind !== 'domainDns' && await admitDeploymentStoredContentInTx(tx, binding.accountId, loaded.admission.owner, routing.input,
                    DEPLOYMENT_DOMAIN_ARTIFACT_STORED_KIND_V1, 'read')) return false;
        }
        return !await admitDeploymentMachinesInTx(tx, loaded.admission.owner, [
            { machineId: binding.machineId, installationId: binding.installationId, role: 'controller' },
            { machineId: routing.machineId, installationId: routing.installationId, role: 'target' },
        ]);
    }
    if (routing.kind !== 'prepare' && routing.kind !== 'review') return readAcceptedDeploymentChildInTx(tx, binding, routing);
    if (preparationScope?.environment === 'template'
        && await readTemplateDeploymentEnvironmentIdInTx(tx, binding) !== routing.input.environmentId) return false;
    if (preparationScope?.environment === 'create' && routing.kind === 'review'
        && routing.input.requestKey !== binding.requestId) return false;
    const allocated = preparationScope?.environment === 'create'
        ? await readAdmittedCreateDeploymentEnvironmentCustodyInTx(tx, binding) : null;
    if (preparationScope?.environment === 'create' && allocated?.row.id !== routing.input.environmentId) return false;
    const loaded = allocated ? { ok: true as const, row: allocated.row, owner: allocated.owner }
        : await loadDeploymentEnvironmentInTx(tx, binding.accountId, routing.input.serverId, routing.input.environmentId, authentication);
    if (!loaded.ok || loaded.row.deletedAt
        || 'admission' in loaded && binding.environmentId === undefined && !canDeployDeploymentEnvironment(loaded.admission, loaded.row)
        || loaded.row.runtimeTargetLinkId !== routing.input.targetLinkId) return false;
    const owner = 'admission' in loaded ? loaded.admission.owner : loaded.owner;
    if (loaded.row.controllerMachineId !== binding.machineId) return false;
    const link = await tx.deploymentTargetLink.findFirst({ where: { id: routing.input.targetLinkId,
        environmentId: loaded.row.id, deletedAt: null, detachedAt: null, role: 'runtime', sourceKind: 'host', targetKind: 'ownServer' },
        select: { revision: true, activeDeploymentId: true, machines: { where: { machineId: routing.machineId },
            select: { installationId: true } } } });
    if (!link || link.revision !== (routing.kind === 'prepare' ? routing.expectedTargetLinkRevision : routing.input.expectedTargetLinkRevision)) return false;
    const member = link.machines.some(value => value.installationId === routing.installationId);
    const builder = loaded.row.buildMachineId === routing.machineId;
    const preparesTeardown = routing.kind === 'prepare' && getActionSpec(routing.actionId).deploymentReadScope?.childReadOnly === true;
    if (routing.kind === 'prepare' ? preparesTeardown ? !member : !builder : !member && !builder) return false;
    if (!loaded.row.controllerMachineId) return false;
    const denied = await admitDeploymentMachinesInTx(tx, owner, [
        { machineId: loaded.row.controllerMachineId, role: 'controller',
            ...(loaded.row.controllerMachineId === binding.machineId ? { installationId: binding.installationId } : {}) },
        { machineId: routing.machineId, installationId: routing.installationId, role: routing.kind === 'prepare' && !preparesTeardown || !member ? 'build' : 'target' },
    ]);
    if (denied) return false;
    if (routing.kind === 'prepare') return loaded.row.revision === routing.expectedRevision;
    if (routing.promotion) {
        const promotion = routing.promotion;
        if (!('admission' in loaded) || !loaded.admission.canManage || promotion.sourceEnvironmentId === loaded.row.id) return false;
        const source = await loadDeploymentEnvironmentInTx(tx, binding.accountId, routing.input.serverId,
            promotion.sourceEnvironmentId, authentication);
        if (!source.ok || !canDeployDeploymentEnvironment(source.admission, source.row)
            || !await tx.deployment.findFirst({ where: { id: promotion.sourceDeploymentId,
                environmentId: source.row.id,
                state: { in: ['succeeded', 'running_unverified'] } }, select: { id: true } })) return false;
    }
    if (routing.actionId === deploymentActionIds.DEPLOYMENT_ROLLBACK_ACTION_ID_V1) {
        if (!routing.input.deploymentId) return false;
        const selected = await tx.deployment.findFirst({ where: { id: routing.input.deploymentId,
            environmentId: loaded.row.id }, select: { state: true, targetLinkId: true } });
        if (!selected || !isDeploymentRollbackSourceEligibleV1(DeploymentStateV1Schema.parse(selected.state))) return false;
        const links = await tx.deploymentTargetLink.findMany({ where: { environmentId: loaded.row.id, role: 'runtime' },
            select: { id: true, environmentId: true, predecessorTargetLinkId: true } });
        const current = links.find(value => value.id === routing.input.targetLinkId);
        if (!current || !getDeploymentTargetLinkLineageV1({ ...current,
            predecessorTargetLinkId: current.predecessorTargetLinkId ?? undefined },
            links.map(value => ({ ...value, predecessorTargetLinkId: value.predecessorTargetLinkId ?? undefined })))
            .has(selected.targetLinkId)) return false;
    }
    return loaded.row.revision === routing.input.expectedRevision && !await admitDeploymentStoredContentInTx(tx,
        binding.accountId, owner, routing.input, DEPLOYMENT_RECEIPT_ARTIFACT_STORED_KIND_V1, 'read');
}

/** One relational lookup retains captured placements without reevaluating requester, Team or Source permission. */
async function readAcceptedDeploymentChildInTx(tx: Tx, binding: ExternalActionExecutionAuthorizationBindingV1,
    routing: Exclude<DeploymentChildRoutingV1, { kind: 'prepare' | 'review' | 'domain' | 'domainDiscover' | 'domainDns' | 'dataRole' | 'snapshot' }>,
): ReturnType<typeof readAcceptedDeploymentReceiptInTx> {
    const member: Prisma.DeploymentTargetLinkWhereInput = { machines: { some: {
        machineId: routing.machineId, installationId: routing.installationId,
    } } };
    const builder: Prisma.DeploymentWhereInput = { acceptedBuildMachineId: routing.machineId,
        acceptedBuildInstallationId: routing.installationId };
    const link: Prisma.DeploymentTargetLinkWhereInput = { id: routing.input.targetLinkId,
        environmentId: routing.input.environmentId, deletedAt: null, detachedAt: null,
        role: 'runtime', sourceKind: 'host', targetKind: 'ownServer',
        revision: routing.kind === 'retention' ? routing.settledTargetLinkRevision : routing.input.expectedTargetLinkRevision };
    const environment: Prisma.DeploymentEnvironmentWhereInput = { deletedAt: null, runtimeTargetLinkId: routing.input.targetLinkId };
    if (routing.kind === 'member') {
        if (routing.phase === 'cleanup') {
            if (routing.selectedDeploymentId !== routing.deploymentId) return null;
            link.activeDeploymentId = null;
        } else if (routing.phase === 'restore' || routing.phase === 'observe') {
            link.activeDeploymentId = routing.selectedDeploymentId;
            link.activeDeployment = { environmentId: routing.input.environmentId, state: { in: ['succeeded', 'running_unverified'] } };
        } else if (routing.selectedDeploymentId !== routing.deploymentId) return null;
    }
    if (routing.kind === 'retention') {
        link.activeDeploymentId = routing.activeDeploymentId;
        environment.deployments = { none: { state: { in: ['queued', 'running', 'outcome_unknown'] } } };
    }
    const custody: Prisma.DeploymentWhereInput = routing.kind === 'member' || routing.kind === 'teardown' ? { targetLink: member }
        : routing.kind === 'build' ? builder : { OR: [builder, { targetLink: member }] };
    return readAcceptedDeploymentReceiptInTx(tx, binding, { deploymentId: routing.deploymentId,
        environmentId: routing.input.environmentId, actionOperationId: routing.actionOperationId,
        installationId: binding.installationId }, {
        targetLinkId: routing.input.targetLinkId, requestKey: routing.input.requestKey,
        cancelRequestedAt: null,
        contentArtifactId: routing.input.contentArtifactId,
        state: { in: routing.kind !== 'retention' ? ['queued', 'running']
            : routing.activeDeploymentId === routing.deploymentId ? ['succeeded', 'running_unverified', 'failed'] : ['failed'] },
        ...(routing.kind === 'retention' ? { revision: routing.settledDeploymentRevision } : {}),
        environment, targetLink: link, AND: [custody],
    });
}
