import { isDeepStrictEqual } from 'node:util';
import { DeploymentReceiptHeaderV1Schema, DeploymentReceiptResultV1Schema, DeploymentTeardownDispositionV1Schema, computeDeploymentTransitionRequestDigestV1,
    hasDeploymentReceiptContentV1,
    selectDeploymentTeardownDomainScopeV1,
    type DeploymentDeployAdmissionInputV1, type DeploymentRollbackAdmissionInputV1, type DeploymentPromoteAdmissionInputV1, type DeploymentTeardownAdmissionInputV1, type DeploymentTransitionInputV1,
    type DeploymentCancelInputV1, type DeploymentCancelTransitionInputV1 } from '@happier-dev/protocol';
import { verifyMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { canTransitionDeploymentV1, isDeploymentSettledV1, isDeploymentRollbackSourceEligibleV1, DeploymentStateV1Schema, getDeploymentTargetLinkLineageV1 } from '@happier-dev/deployments/contracts/v1';
import { DEPLOYMENT_RECEIPT_ARTIFACT_STORED_KIND_V1, DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1 } from '@happier-dev/protocol/artifacts/deploymentArtifactKindsV1';
import { inTx, type Tx } from '@/storage/inTx';
import { db } from '@/storage/db';
import { readProjectSourceCustodyInTx } from '@/app/projects/sources/projectSourceService';
import { disableDeploymentEnvironmentAutomationsInTx } from '@/app/automations/automationDeploymentEnvironment';
import { getActivePrismaRuntime } from '@/storage/prisma';
import { readTransactionDatabaseTime } from '@/storage/transactionDatabaseTime';
import { admitDeploymentMachinesInTx, deploymentFailure, canDeployDeploymentEnvironment, canTeardownDeploymentEnvironment, type DeploymentAuthentication } from './deploymentAdmission';
import { loadDeploymentEnvironmentInTx, loadDeploymentEnvironmentCustodyInTx, lockDeploymentEnvironmentInTx, updateDeploymentEnvironmentInTx,
    type AdmittedDeploymentEnvironment } from './deploymentEnvironmentService';
import { admitDeploymentStoredContentInTx, deploymentContentReference, updateDeploymentStoredContentInTx } from './deploymentStoredContent';
import { clearedDeploymentTelemetryPendingAssignment, publishDeploymentChangesInTx, publishDeploymentTelemetryMachinesInTx, readDeploymentTelemetryPublicationAccountIdsInTx, stampDeploymentTelemetryAssignmentInTx } from './deploymentPublication';
import { readDeploymentTargetsInTx } from './deploymentTargetLinkService';
import { readDeploymentDomainInventoryInTx, prepareDeploymentTeardownDomainsInTx } from './deploymentDomainService';
import { admitDeploymentPendingInTx } from './deploymentPendingService';
import type { ExternalActionExecutionAuthorizationBindingV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { admitDeploymentAcceptedControllerInTx, createDeploymentAcceptedExecution,
    deploymentAcceptedExecutionColumns, deploymentInProgressStates, isOwnServerDeploymentTarget, readDeploymentAcceptedExecution } from './deploymentAcceptedExecution';
import { readDeploymentTeardownSubjectsInTx } from './deploymentTeardownSubjects';
import type { ForwardManagedPluginWebhookOperation } from '@/app/api/socket/managedPluginWebhookDispatcher';
import { admitDeploymentTeardownEnvironmentRemovalInTx, removeAdmittedDeploymentEnvironmentInTx } from './deploymentDispositionService';
import { projectDeploymentReceiptActivityV1 } from '@happier-dev/deployments/contracts/v1';
import { resolveProjectSourceAudienceInTx } from '@/app/projects/sources/projectSourceService';
import { deploymentTeardownMembershipAdmissionSchema, haveDeploymentMembershipRoutesInTx } from './deploymentMembershipService';
import { DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1, DEPLOYMENT_RECEIPT_OBSERVE_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { prepareDeploymentAppMachineRevocationInTx } from './deploymentAppRevocation';
import { readDeploymentBindingSavedSecretRevisionsV1 } from '@happier-dev/protocol/deployments/deploymentBindingPatchV1';
import { projectDeploymentReceiptCompletionV1 } from '@happier-dev/protocol/plugins/events/hostReferencesV1';
import { projectDeploymentReviewedCandidateV1 } from '@happier-dev/protocol/deployments/deploymentCandidatePublicationV1';

type Receipt = NonNullable<Awaited<ReturnType<Tx['deployment']['findUnique']>>>;
/** Detach and Environment removal retire the association while retaining native resource custody. */
function isRetainedTeardownTarget(operation: string, environment: Readonly<{ deletedAt: Date | null }>,
    link: Readonly<{ detachedAt: Date | null }>,
): boolean {
    return operation === 'teardown' && (environment.deletedAt !== null || link.detachedAt !== null);
}
function retainedDomainTeardownFailure() {
    return { ok: false as const, error: 'unsupported_action' as const, errorCode: 'unsupported_action' as const,
        effectAttempted: false as const, details: { reason: 'retained_domain_custody',
            remedy: "Remove this Environment's Domains first, then tear down" },
        failureCause: projectActionFailureCauseV1(new Error('unsupported_action'), 'deployment.teardown.admission') };
}
export function projectDeploymentReceiptHeader(row: Receipt) {
    const acceptedExecution = readDeploymentAcceptedExecution(row);
    return DeploymentReceiptHeaderV1Schema.parse({
        v: 1, id: row.id, environmentId: row.environmentId, targetLinkId: row.targetLinkId, revision: row.revision,
        operation: row.operation, state: row.state, requestKey: row.requestKey, requestedByAccountId: row.requestedByAccountId,
        actionOperationId: row.actionOperationId, contentArtifactId: row.contentArtifactId,
        contentHeaderVersion: row.contentHeaderVersion, contentBodyVersion: row.contentBodyVersion,
        ...(row.originRunId ? { originRunId: row.originRunId } : {}),
        ...(acceptedExecution ? { acceptedExecution } : {}),
        ...(row.predecessorDeploymentId ? { predecessorDeploymentId: row.predecessorDeploymentId } : {}),
        ...(row.restoreBackupId ? { restoreBackupId: row.restoreBackupId } : {}),
        ...(row.rollbackOfDeploymentId ? { rollbackOfDeploymentId: row.rollbackOfDeploymentId } : {}),
        ...(row.promotedFromDeploymentId ? { promotedFromDeploymentId: row.promotedFromDeploymentId } : {}),
        ...(row.cancelRequestedAt ? { cancelRequestedAtMs: row.cancelRequestedAt.getTime() } : {}),
        requestedAtMs: row.requestedAt.getTime(), ...(row.startedAt ? { startedAtMs: row.startedAt.getTime() } : {}),
        ...(row.settledAt ? { settledAtMs: row.settledAt.getTime() } : {}),
    });
}

function receiptResult(row: Pick<Receipt, 'id' | 'environmentId' | 'revision' | 'state'>, environmentRevision: number, environmentRemoved = false) {
    const result = DeploymentReceiptResultV1Schema.parse({ ok: true, environmentId: row.environmentId, revision: environmentRevision,
        deploymentId: row.id, deploymentRevision: row.revision, state: row.state,
        ...(environmentRemoved ? { environmentRemoved: true } : {}) });
    if (!result.ok || !('deploymentId' in result)) throw new Error('Persisted deployment receipt has no receipt identity');
    return result;
}

/** Submitted content versions describe the incumbent receipt; only the Artifact writer advances them. */
function transitionContentReference(row: Receipt, input: DeploymentTransitionInputV1) {
    if (!hasDeploymentReceiptContentV1(row)) return null;
    if (input.contentArtifactId !== undefined && input.contentArtifactId !== row.contentArtifactId) return null;
    const reference = input.contentArtifactId !== undefined && input.contentHeaderVersion !== undefined && input.contentBodyVersion !== undefined
        ? deploymentContentReference({ contentArtifactId: input.contentArtifactId, contentHeaderVersion: input.contentHeaderVersion, contentBodyVersion: input.contentBodyVersion })
        : deploymentContentReference(row);
    return isDeepStrictEqual(reference, deploymentContentReference(row)) ? reference : null;
}

/** Stop future stages without waiting for, or inventing observations from, the controller. */
export async function requestCancelDeploymentInTx(tx: Tx, actorAccountId: string, input: DeploymentCancelInputV1,
    authentication: DeploymentAuthentication = {},
    onAccepted?: () => void,
) {
    await lockDeploymentEnvironmentInTx(tx, input.environmentId);
    const loaded = await loadDeploymentEnvironmentInTx(tx, actorAccountId, input.serverId, input.environmentId, authentication);
    if (!loaded.ok) return loaded;
    if (!canDeployDeploymentEnvironment(loaded.admission, loaded.row)) return deploymentFailure('deployment_access_denied');
    const row = await tx.deployment.findFirst({ where: { id: input.deploymentId, environmentId: loaded.row.id } });
    if (!row) return deploymentFailure('deployment_unavailable', { phase: 'deployment.cancel.receipt', causeKind: 'not_found' });
    if (row.cancelRequestedAt) {
        return receiptResult(row, loaded.row.revision);
    }
    if (row.revision !== input.expectedReceiptRevision) return deploymentFailure('deployment_conflict');
    const previousState = DeploymentStateV1Schema.parse(row.state);
    if (isDeploymentSettledV1(previousState)) return receiptResult(row, loaded.row.revision);
    if (!canTransitionDeploymentV1(previousState, 'outcome_unknown')) return deploymentFailure('deployment_conflict');
    const now = await readTransactionDatabaseTime(tx);
    const changed = await tx.deployment.updateMany({ where: { id: row.id, revision: input.expectedReceiptRevision },
        data: { cancelRequestedAt: now, state: 'outcome_unknown', revision: { increment: 1 } } });
    if (changed.count !== 1) throw new Error('Locked deployment receipt changed during cancellation');
    const current = await tx.deployment.findUniqueOrThrow({ where: { id: row.id } });
    // Wake the existing pending/controller readers. Protected member evidence,
    // membership and the last uniform receipt stay untouched.
    const accountIds = await resolveProjectSourceAudienceInTx(tx, [loaded.admission.source]);
    await publishDeploymentChangesInTx(tx, loaded.admission, loaded.row.id, loaded.row.revision, undefined, false, accountIds);
    await publishDeploymentChangesInTx(tx, loaded.admission, loaded.row.id, current.revision, current.id,
        !isDeepStrictEqual(projectDeploymentReceiptActivityV1(previousState),
            projectDeploymentReceiptActivityV1('outcome_unknown')), accountIds,
        projectDeploymentReceiptCompletionV1(previousState,
            { state: 'outcome_unknown', settledAt: current.settledAt, cancelRequestedAt: current.cancelRequestedAt },
            current.revision, now.getTime()));
    onAccepted?.();
    return receiptResult(current, loaded.row.revision);
}

/** Machine presence has withdrawn the controller that owns these in-flight Receipts. */
export async function settleDeploymentsOnControllerOffline(machineId: string, wentOfflineAt: Date): Promise<void> {
    const where = { acceptedControllerMachineId: machineId, state: { in: deploymentInProgressStates() },
        requestedAt: { lte: wentOfflineAt } };
    const receipts = await db.deployment.findMany({ where, select: { id: true, environmentId: true } });
    for (const receipt of receipts) {
        await inTx(async tx => {
            // Use normal Receipt lock order, after the presence transaction has released the Machine.
            await lockDeploymentEnvironmentInTx(tx, receipt.environmentId);
            const current = await tx.deployment.findFirst({ where: { ...where, id: receipt.id },
                select: { state: true, revision: true, environment: {
                    select: { projectSourceId: true, revision: true, pendingDeployContent: true },
                } } });
            if (!current) return;
            const custody = await readProjectSourceCustodyInTx(tx, current.environment.projectSourceId);
            const changed = await tx.deployment.updateMany({ where: { id: receipt.id, revision: current.revision },
                data: { state: 'outcome_unknown', revision: { increment: 1 }, settledAt: wentOfflineAt } });
            if (changed.count !== 1) throw new Error('Locked deployment receipt changed during controller loss');
            if (!custody) return;
            const accountIds = await resolveProjectSourceAudienceInTx(tx, [custody.source]);
            if (current.environment.pendingDeployContent !== null) {
                await publishDeploymentChangesInTx(tx, custody, receipt.environmentId, current.environment.revision, undefined, false, accountIds);
            }
            const previous = DeploymentStateV1Schema.parse(current.state);
            const revision = current.revision + 1;
            const completion = projectDeploymentReceiptCompletionV1(previous, {
                state: 'outcome_unknown', settledAt: wentOfflineAt, cancelRequestedAt: null,
            }, revision, wentOfflineAt.getTime());
            await publishDeploymentChangesInTx(tx, custody, receipt.environmentId, revision, receipt.id, true, accountIds, completion);
        });
    }
}

export function readDeploymentReceiptByRequestKeyInTx(tx: Tx, environmentId: string, requestKey: string) {
    return tx.deployment.findUnique({ where: { environmentId_requestKey: { environmentId, requestKey } } });
}

/** Admission reserves one Environment receipt slot; it never dispatches or observes an effect. */
export async function createDeploymentInTx(tx: Tx, actorAccountId: string,
    input: DeploymentDeployAdmissionInputV1 | DeploymentRollbackAdmissionInputV1 | DeploymentPromoteAdmissionInputV1 | DeploymentTeardownAdmissionInputV1, operation: 'deploy' | 'rollback' | 'promote' | 'teardown',
    authentication: DeploymentAuthentication = {},
    executionBinding?: ExternalActionExecutionAuthorizationBindingV1,
    admitted?: AdmittedDeploymentEnvironment,
) {
    if (!admitted) await lockDeploymentEnvironmentInTx(tx, input.environmentId);
    const loaded = admitted ?? await loadDeploymentEnvironmentInTx(tx, actorAccountId, input.serverId, input.environmentId, authentication);
    if (!loaded.ok) return loaded;
    if (!(operation === 'teardown' ? canTeardownDeploymentEnvironment(loaded.admission, loaded.row)
        : canDeployDeploymentEnvironment(loaded.admission, loaded.row))) return deploymentFailure('deployment_access_denied');
    const removeEnvironment = operation === 'teardown' && 'removeEnvironment' in input && input.removeEnvironment === true;
    if (removeEnvironment && !loaded.admission.canManage) return deploymentFailure('deployment_access_denied');
    const rollbackOfDeploymentId = 'deploymentId' in input ? input.deploymentId : null;
    const restoreBackupId = 'restoreBackupId' in input ? input.restoreBackupId ?? null : null;
    const promotedFromDeploymentId = 'sourceDeploymentId' in input ? input.sourceDeploymentId : null;
    const reviewed = executionBinding?.deploymentCandidatePublication?.reviewed;
    if (reviewed && !isDeepStrictEqual(projectDeploymentReviewedCandidateV1(input), reviewed)) return deploymentFailure('deployment_conflict');
    const repeated = await readDeploymentReceiptByRequestKeyInTx(tx, input.environmentId, input.requestKey);
    if (repeated) {
        // Artifact identity pins the prepared intent. Its head versions may have
        // advanced through this same receipt's signed stage writer.
        if (repeated.operation !== operation || repeated.targetLinkId !== input.targetLinkId
            || removeEnvironment !== DeploymentTeardownDispositionV1Schema.safeParse(repeated.teardownProof).success
            || (operation !== 'teardown' && (repeated.actionOperationId !== input.actionOperationId || repeated.requestedByAccountId !== actorAccountId))
            || repeated.contentArtifactId !== input.contentArtifactId || repeated.rollbackOfDeploymentId !== rollbackOfDeploymentId
            || repeated.restoreBackupId !== restoreBackupId
            || repeated.promotedFromDeploymentId !== promotedFromDeploymentId) {
            return deploymentFailure('deployment_conflict');
        }
        return receiptResult(repeated, loaded.row.revision);
    }
    if (reviewed && await tx.deployment.findFirst({ where: { contentArtifactId: reviewed.contentArtifactId }, select: { id: true } })) {
        return deploymentFailure('deployment_conflict');
    }
    const link = await tx.deploymentTargetLink.findFirst({ where: { id: input.targetLinkId, environmentId: input.environmentId },
        include: { machines: { orderBy: { position: 'asc' } } } });
    // Retired associations still identify the exact retained native resources.
    if (!link || link.revision !== input.expectedTargetLinkRevision
        || link.deletedAt && !isRetainedTeardownTarget(operation, loaded.row, link)) return deploymentFailure('deployment_conflict');
    const requiresBuilder = operation !== 'teardown' && isOwnServerDeploymentTarget(link);
    const buildMachineId = requiresBuilder ? loaded.row.buildMachineId : null;
    const accepted = executionBinding ? await admitDeploymentAcceptedControllerInTx(tx, {
        binding: executionBinding, actorAccountId, serverId: input.serverId, operation,
        environment: loaded.row,
    }) : null;
    if (accepted && !accepted.ok) return accepted;
    if (accepted && requiresBuilder && !buildMachineId) return deploymentFailure('deployment_access_denied');
    const busy = await tx.deployment.findFirst({ where: { environmentId: input.environmentId, state: { in: deploymentInProgressStates() } }, select: { id: true } });
    const pendingInput = operation === 'deploy' && 'whenBusy' in input && input.whenBusy === 'supersede' ? input : undefined;
    if (busy && !pendingInput) return { ok: false as const, error: 'deployment_in_progress' as const, deploymentId: busy.id,
        href: `/deployments/environments/${encodeURIComponent(input.environmentId)}/deployments/${encodeURIComponent(busy.id)}` };
    if ((!pendingInput && loaded.row.revision !== input.expectedRevision)
        || (operation !== 'teardown' && loaded.row.runtimeTargetLinkId !== input.targetLinkId)) return deploymentFailure('deployment_conflict');
    if (requiresBuilder && !buildMachineId) return deploymentFailure('deployment_conflict');
    const teardownMachines = 'reason' in input && input.machines ? input.machines : link.machines.map(member => member.machineId);
    const selectiveTeardown = operation === 'teardown' && isOwnServerDeploymentTarget(link)
        && loaded.row.runtimeTargetLinkId === link.id && teardownMachines.length < link.machines.length;
    if (operation === 'teardown' && teardownMachines.some(machineId => !link.machines.some(member => member.machineId === machineId))) {
        return deploymentFailure('deployment_conflict');
    }
    if (removeEnvironment) {
        if (link.machines.some(member => !teardownMachines.includes(member.machineId))) return deploymentFailure('deployment_conflict');
        const disposition = await admitDeploymentTeardownEnvironmentRemovalInTx(tx, { loaded, targetLinkId: link.id });
        if (disposition) return disposition;
    }
    if (operation === 'rollback') {
        if (!rollbackOfDeploymentId) return deploymentFailure('deployment_invalid');
        const source = await tx.deployment.findFirst({ where: { id: rollbackOfDeploymentId, environmentId: input.environmentId } });
        if (!source || !isDeploymentRollbackSourceEligibleV1(DeploymentStateV1Schema.parse(source.state))) return deploymentFailure('deployment_conflict');
        if (!getDeploymentTargetLinkLineageV1({ ...link, predecessorTargetLinkId: link.predecessorTargetLinkId ?? undefined },
            await readDeploymentTargetsInTx(tx, input.environmentId)).has(source.targetLinkId)) {
            return deploymentFailure('deployment_conflict');
        }
    }
    const admittedMachines = await admitDeploymentMachinesInTx(tx, loaded.admission.owner, [
        { machineId: loaded.row.controllerMachineId, role: 'controller', installationId: accepted?.controller.installationId },
        ...(buildMachineId ? [{ machineId: buildMachineId, role: 'build' as const }] : []),
        ...(link.machineId && link.installationId
            ? [{ machineId: link.machineId, installationId: link.installationId, role: 'target' as const }] : []),
        ...link.machines.filter(machine => operation !== 'teardown' || teardownMachines.includes(machine.machineId))
            .map(machine => ({ machineId: machine.machineId, installationId: machine.installationId, role: 'target' as const })),
    ]);
    if (!admittedMachines.ok) return admittedMachines;
    const contentFailure = await admitDeploymentStoredContentInTx(tx, actorAccountId, loaded.admission.owner, input,
        DEPLOYMENT_RECEIPT_ARTIFACT_STORED_KIND_V1);
    if (contentFailure) return contentFailure;
    if (operation === 'teardown' && !selectiveTeardown) {
        const domains = await prepareDeploymentTeardownDomainsInTx(tx, actorAccountId, input.actionOperationId, loaded,
            executionBinding, selectDeploymentTeardownDomainScopeV1(input));
        if (!domains.ok) return domains.error === 'unsupported_action' ? retainedDomainTeardownFailure() : domains;
    }
    if (pendingInput?.pendingDeploy) {
        // This field belongs to the Environment, not to an independently owned
        // Team receipt Artifact, whose Account may use a different content mode.
        const pendingModeFailure = await admitDeploymentStoredContentInTx(tx, actorAccountId, loaded.admission.owner, loaded.row,
            DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1, 'read', pendingInput.pendingDeploy);
        if (pendingModeFailure) return pendingModeFailure;
    }
    let takePending = false;
    if (operation === 'deploy') {
        const pending = await admitDeploymentPendingInTx(tx, loaded.row, input, !!busy, actorAccountId, executionBinding);
        if (!pending.ok) return pending;
        if ('result' in pending) {
            if (pending.changed) await publishDeploymentChangesInTx(tx, loaded.admission, loaded.row.id, pending.result.revision);
            return pending.result;
        }
        takePending = pending.take;
    }
    const accountIds = await resolveProjectSourceAudienceInTx(tx, [loaded.admission.source]);
    let environmentRevision = loaded.row.revision;
    if (operation === 'promote') {
        if (!('destinationContent' in input)) return deploymentFailure('deployment_invalid');
        if (loaded.row.protection === 'production') {
            if (!isDeepStrictEqual(input.destinationContent, deploymentContentReference(loaded.row))) {
                return deploymentFailure('deployment_access_denied');
            }
        } else {
            // Legacy promotion edits the destination under the definition owner's Manage check.
            const updated = await updateDeploymentEnvironmentInTx(tx, actorAccountId, { serverId: input.serverId,
                environmentId: input.environmentId, expectedRevision: input.expectedRevision, ...input.destinationContent }, authentication, 'environment', loaded, accountIds);
            if (!updated.ok) return updated;
            environmentRevision = updated.revision;
        }
    }
    const changed = await tx.deploymentEnvironment.updateMany({ where: { id: loaded.row.id, revision: environmentRevision }, data: {
        revision: { increment: 1 },
        ...(takePending || operation === 'teardown' ? { pendingDeployContent: getActivePrismaRuntime().DbNull } : {}),
    } });
    if (changed.count !== 1) throw new Error('Locked deployment Environment changed during receipt admission');
    const admittedRevision = environmentRevision + 1;
    const builder = buildMachineId ? admittedMachines.placements.get(buildMachineId) : undefined;
    const acceptedExecution = accepted ? createDeploymentAcceptedExecution({ controller: accepted.controller,
        ...(builder ? { builder } : {}) }) : null;
    const row = await tx.deployment.create({ data: {
        environmentId: loaded.row.id, targetLinkId: link.id, operation, state: 'queued', requestKey: input.requestKey,
        requestedByAccountId: actorAccountId, actionOperationId: input.actionOperationId,
        ...(acceptedExecution ? deploymentAcceptedExecutionColumns(acceptedExecution) : {}),
        acceptedRequestEnvelopeDigest: acceptedExecution ? executionBinding?.requestEnvelopeDigest ?? null : null,
        originRunId: acceptedExecution ? executionBinding?.workflowActionOrigin?.runId ?? null : null,
        ...(selectiveTeardown || removeEnvironment ? { teardownProof: {
            ...(selectiveTeardown ? { admittedMachines: link.machines.filter(member => teardownMachines.includes(member.machineId))
                .map(member => ({ machineId: member.machineId, installationId: member.installationId })) } : {}),
            ...(removeEnvironment ? { removeEnvironment: true } : {}),
        } } : {}),
        predecessorDeploymentId: link.activeDeploymentId, rollbackOfDeploymentId, restoreBackupId,
        ...(promotedFromDeploymentId ? { promotedFromDeploymentId } : {}), ...deploymentContentReference(input),
    } });
    await publishDeploymentChangesInTx(tx, loaded.admission, loaded.row.id, admittedRevision, undefined, false, accountIds);
    await publishDeploymentChangesInTx(tx, loaded.admission, loaded.row.id, row.revision, row.id, true, accountIds);
    return receiptResult(row, admittedRevision);
}

/** Native outcomes enter through one installation-signed receipt CAS; old results cannot advance a newer release. */
export async function transitionDeploymentInTx(tx: Tx, actorAccountId: string, input: DeploymentTransitionInputV1 | DeploymentCancelTransitionInputV1,
    authentication: DeploymentAuthentication = {},
    executionBinding?: ExternalActionExecutionAuthorizationBindingV1,
    onStopAccepted?: () => void,
    forwardManagedWebhook?: ForwardManagedPluginWebhookOperation,
) {
    if (input.kind === 'cancel') return requestCancelDeploymentInTx(tx, actorAccountId, input, authentication, onStopAccepted);
    await lockDeploymentEnvironmentInTx(tx, input.environmentId);
    const row = await tx.deployment.findFirst({ where: { id: input.deploymentId, environmentId: input.environmentId } });
    if (!row || row.actionOperationId !== input.actionOperationId) return deploymentFailure('deployment_unavailable', { phase: 'deployment.transition.receipt', causeKind: row ? 'access_denied' : 'not_found' });
    const acceptedExecution = readDeploymentAcceptedExecution(row);
    if (!acceptedExecution) return deploymentFailure('deployment_access_denied');
    const removeEnvironment = row.operation === 'teardown' && DeploymentTeardownDispositionV1Schema.safeParse(row.teardownProof).success;
    const removedReplay = removeEnvironment && row.state === 'succeeded' && input.state === 'succeeded';
    const link = await tx.deploymentTargetLink.findFirst({ where: { id: row.targetLinkId, environmentId: input.environmentId },
        include: { machines: { orderBy: { position: 'asc' } } } });
    if (!link) return deploymentFailure('deployment_conflict');
    const machine = await tx.machine.findUnique({ where: { id: input.machineId },
        select: { installationId: true, installationPublicKey: true, revokedAt: true, replacedByMachineId: true } });
    const isMember = link.machines.some(member => member.machineId === input.machineId && member.installationId === input.installationId);
    const isController = acceptedExecution.controller.machineId === input.machineId
        && acceptedExecution.controller.installationId === input.installationId;
    const isBuilder = acceptedExecution.builder?.machineId === input.machineId
        && acceptedExecution.builder.installationId === input.installationId;
    // The signature binds the admitted requester, not the Machine custodian.
    if (!machine || machine.revokedAt || machine.replacedByMachineId
        || machine.installationId !== input.installationId || !machine.installationPublicKey
        || (!isMember && !isController && !isBuilder)) {
        return deploymentFailure('deployment_access_denied');
    }
    const { proof, ...body } = input;
    if (!verifyMachineInstallationProof({ payload: { version: 1, machineId: input.machineId, installationId: input.installationId,
        accountId: actorAccountId, deploymentTransition: { serverId: input.serverId, environmentId: input.environmentId,
            deploymentId: row.id, actionOperationId: row.actionOperationId, expectedRevision: input.expectedRevision,
            requestBodyDigest: computeDeploymentTransitionRequestDigestV1(body) } }, proof,
        publicKey: machine.installationPublicKey })) return deploymentFailure('deployment_access_denied');
    // The signed captured role owns this admitted receipt write. Grant withdrawal
    // takes effect at the next admission, without stranding its running receipt.
    const loaded = await loadDeploymentEnvironmentCustodyInTx(tx, { serverId: input.serverId,
        environmentId: input.environmentId, includeRemoved: row.operation === 'teardown' });
    if (!loaded.ok) return loaded;
    if ((link.deletedAt || link.detachedAt) && !isRetainedTeardownTarget(row.operation, loaded.row, link)
        && !removedReplay) return deploymentFailure('deployment_conflict');
    if (row.operation !== 'teardown' && loaded.row.runtimeTargetLinkId !== link.id) return deploymentFailure('deployment_conflict');
    const native = executionBinding?.deploymentNativeAdmission;
    if (executionBinding?.actionId === DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1
        && native && 'kind' in native && native.kind === 'restore' && native.mode !== 'prepare') {
        // Restore changes the incumbent receipt's volume content, never its settled
        // lifecycle or serving custody. Finish that publication here rather than
        // exempting it from each aggregate transition rule below.
        if (!isMember || row.targetLinkId !== native.targetLinkId || link.activeDeploymentId !== row.id
            || row.state !== input.state || row.operation === 'teardown'
            || input.servingDeploymentId !== undefined) return deploymentFailure('deployment_conflict');
        const content = transitionContentReference(row, input);
        if (!content) return deploymentFailure('deployment_conflict');
        if (!input.contentUpdate) return receiptResult(row, loaded.row.revision);
        if (row.revision !== input.expectedRevision || row.cancelRequestedAt) return deploymentFailure('deployment_conflict');
        const updated = await updateDeploymentStoredContentInTx(tx, actorAccountId, loaded, content, input.contentUpdate, DEPLOYMENT_RECEIPT_ARTIFACT_STORED_KIND_V1);
        if (!updated.ok) return updated;
        const changed = await tx.deployment.updateMany({ where: { id: row.id, revision: input.expectedRevision },
            data: { revision: { increment: 1 }, ...updated.reference } });
        if (changed.count !== 1) throw new Error('Locked deployment receipt changed during content publication');
        const accountIds = await resolveProjectSourceAudienceInTx(tx, [loaded.source]);
        if (loaded.row.pendingDeployContent !== null && input.state !== 'queued' && input.state !== 'running') {
            await publishDeploymentChangesInTx(tx, loaded, loaded.row.id, loaded.row.revision, undefined, false, accountIds);
        }
        const current = { ...row, revision: row.revision + 1, ...updated.reference };
        await publishDeploymentChangesInTx(tx, loaded, loaded.row.id, current.revision, row.id, false, accountIds);
        return receiptResult(current, loaded.row.revision);
    }
    // Member/build daemons publish child evidence only. The captured controller
    // alone settles the aggregate or changes uniform/resource custody.
    if (!isController) {
        if (input.kind !== 'stage' || input.state !== 'running' || input.expectedTargetLinkRevision !== undefined || input.teardownProof) {
            return deploymentFailure('deployment_access_denied');
        }
        if (row.state !== 'running' || row.cancelRequestedAt || row.revision !== input.expectedRevision) {
            return deploymentFailure('deployment_conflict');
        }
    }
    // A replay consumes the committed terminal result; it never reapplies submitted content or activation.
    if (row.state === input.state && isDeploymentSettledV1(input.state)) {
        if (input.contentArtifactId !== undefined && input.contentArtifactId !== row.contentArtifactId) return deploymentFailure('deployment_conflict');
        return receiptResult(row, loaded.row.revision, removedReplay && loaded.row.deletedAt !== null);
    }
    let nextContent = transitionContentReference(row, input);
    if (!nextContent) return deploymentFailure('deployment_conflict');
    if (!input.contentUpdate && row.state === input.state) return receiptResult(row, loaded.row.revision);
    const observing = executionBinding?.actionId === DEPLOYMENT_RECEIPT_OBSERVE_ACTION_ID_V1;
    const stopping = executionBinding?.actionId === 'deployments.cancel'
        && executionBinding.deploymentStopReceipt?.deploymentId === row.id && row.cancelRequestedAt !== null;
    // A read-only observer may recover captured provider history, but never
    // reacquires its released effect slot or supersedes a newer target receipt.
    const observedSettlement = (observing || stopping) && link.sourceKind === 'plugin' && row.state === 'outcome_unknown'
        && input.kind === 'settle' && (input.state === 'succeeded' || input.state === 'running_unverified');
    const resumedTeardown = !observing && row.operation === 'teardown' && (row.state === 'failed' || row.state === 'outcome_unknown')
        && input.state === 'running' && !row.cancelRequestedAt;
    // An exact platform observer can confirm the provider finished before Stop took effect.
    // Receipt and Link CAS and the newer-receipt guard still own serving publication.
    const confirmedLateStop = observedSettlement && row.operation === 'deploy' && input.state === 'succeeded';
    if (row.cancelRequestedAt && !confirmedLateStop
        && (input.state === 'queued' || input.state === 'running' || input.state === 'succeeded' || input.state === 'running_unverified')) {
        return deploymentFailure('deployment_conflict');
    }
    if (row.revision !== input.expectedRevision || (!resumedTeardown && !observedSettlement && (!canTransitionDeploymentV1(DeploymentStateV1Schema.parse(row.state), input.state)
        || isDeploymentSettledV1(DeploymentStateV1Schema.parse(row.state))))) return deploymentFailure('deployment_conflict');
    if (observedSettlement || row.operation === 'teardown' && (input.state === 'running' || input.teardownProof)) {
        const newer = await tx.deployment.findFirst({ where: { targetLinkId: link.id, id: { not: row.id },
            OR: [{ requestedAt: { gt: row.requestedAt } }, { requestedAt: row.requestedAt, id: { gt: row.id } }] }, select: { id: true } });
        if (newer) return deploymentFailure('deployment_conflict');
    }
    const admittedTeardownSelection = deploymentTeardownMembershipAdmissionSchema.safeParse(row.teardownProof);
    const teardownSubjects = input.teardownProof
        ? await readDeploymentTeardownSubjectsInTx(tx, link, acceptedExecution, loaded.row.runtimeTargetLinkId) : null;
    const completeTeardown = input.teardownProof !== undefined && input.teardownProof.machines.length === teardownSubjects?.length;
    if (row.operation === 'teardown') {
        if (input.expectedTargetLinkRevision !== undefined || input.state === 'running_unverified' || (input.state === 'succeeded' && !input.teardownProof)) return deploymentFailure('deployment_conflict');
        if (input.state === 'running' || input.teardownProof) {
            const inventory = admittedTeardownSelection.success && !completeTeardown ? null : await readDeploymentDomainInventoryInTx(tx, actorAccountId, {
                serverId: input.serverId, environmentId: loaded.row.id, expectedRevision: loaded.row.revision,
            }, authentication, loaded, selectDeploymentTeardownDomainScopeV1({ targetLinkId: link.id, removeEnvironment }));
            if (inventory && !inventory.ok) return inventory;
            // Starting/resuming may execute this receipt's admitted removals.
            // Completion still requires every selected Domain's signed removal settlement.
            if (inventory?.ok && inventory.domains.length > 0 && (input.teardownProof || inventory.domains.some(domain =>
                domain.state !== 'removing' || domain.operationAddress?.operationId !== row.actionOperationId
                || domain.operationAddress.machineId !== acceptedExecution?.controller.machineId
                || domain.operationAddress.serverId !== input.serverId))) return input.teardownProof
                    ? deploymentFailure('deployment_conflict') : retainedDomainTeardownFailure();
            if (admittedTeardownSelection.success && input.teardownProof && !await haveDeploymentMembershipRoutesInTx(tx, {
                environmentId: row.environmentId, targetLinkId: link.id,
                members: admittedTeardownSelection.data.admittedMachines, mode: 'drain',
            })) return deploymentFailure('deployment_conflict');
        }
    } else if (input.teardownProof || ((input.state === 'succeeded' || input.state === 'running_unverified') && input.expectedTargetLinkRevision === undefined)) return deploymentFailure('deployment_conflict');
    if (resumedTeardown) {
        const busy = await tx.deployment.findFirst({ where: { environmentId: row.environmentId, id: { not: row.id }, state: { in: deploymentInProgressStates() } }, select: { id: true } });
        if (busy) return { ok: false as const, error: 'deployment_in_progress' as const, deploymentId: busy.id,
            href: `/deployments/environments/${encodeURIComponent(row.environmentId)}/deployments/${encodeURIComponent(busy.id)}` };
    }
    if (input.expectedTargetLinkRevision !== undefined && input.expectedTargetLinkRevision !== link.revision) return deploymentFailure('deployment_conflict');
    const vercel = link.sourceKind === 'plugin' && link.targetKind === 'vercel';
    if (vercel && (input.telemetryMachineId !== undefined || input.telemetryTokenHash !== undefined)) {
        return deploymentFailure('deployment_access_denied');
    }
    if (input.teardownProof && (input.teardownProof.removeEnvironment && !removeEnvironment
        || removeEnvironment && !completeTeardown)) return deploymentFailure('deployment_conflict');
    if (input.teardownProof && teardownSubjects) {
        const removal = input.teardownProof;
        if (admittedTeardownSelection.success && (removal.machines.length !== admittedTeardownSelection.data.admittedMachines.length
            || admittedTeardownSelection.data.admittedMachines.some(member => !removal.machines.some(selected =>
                member.machineId === selected.machineId && member.installationId === selected.installationId)))) {
            return deploymentFailure('deployment_conflict');
        }
        if (removal.targetLinkRevision !== link.revision || removal.machines.some(member => !teardownSubjects.some(current =>
            current.machineId === member.machineId && current.installationId === member.installationId))) return deploymentFailure('deployment_conflict');
    }
    const joining = link.machines.filter(member => member.state === 'joining');
    const activatesJoining = input.expectedTargetLinkRevision !== undefined
        && (input.state === 'succeeded' || input.state === 'running_unverified') && joining.length > 0;
    // Join-only settlement proves the existing serving version on the added
    // installations; it must not replace the uniform receipt with this attempt.
    if (input.servingDeploymentId !== undefined && (!isController || !activatesJoining
        || link.sourceKind !== 'host' || link.targetKind !== 'ownServer'
        || input.servingDeploymentId !== link.activeDeploymentId)) return deploymentFailure('deployment_conflict');
    if (activatesJoining
        && !await haveDeploymentMembershipRoutesInTx(tx, { environmentId: row.environmentId,
            targetLinkId: link.id, members: joining, mode: 'join' })) return deploymentFailure('deployment_conflict');
    const accountIds = await resolveProjectSourceAudienceInTx(tx, [loaded.source]);
    const revokeAppMachines = input.teardownProof ? await prepareDeploymentAppMachineRevocationInTx(tx, {
        environmentId: loaded.row.id,
        ...(!removeEnvironment ? { targetLinkId: link.id,
            ...(!completeTeardown ? { removedMachines: input.teardownProof.machines } : {}) } : {}),
        publicationAccountIds: accountIds,
        ...(input.contentUpdate ? { contentArtifactId: nextContent.contentArtifactId } : {}),
        ...(removeEnvironment || completeTeardown && loaded.row.runtimeTargetLinkId === link.id
            ? { disableEnvironmentAutomations: { observationOnly: !removeEnvironment } } : {}),
        ...(removeEnvironment ? { environmentRemoval: { telemetryMachineId: loaded.row.telemetryMachineId,
            savedSecretResourceIds: (readDeploymentBindingSavedSecretRevisionsV1(loaded.row.referencedSavedSecretRevisions) ?? []).map(capture => capture.resourceId) } } : {}),
    }) : undefined;
    const pendingVercelTelemetry = vercel && input.kind === 'settle' && input.state === 'succeeded'
        && row.operation === 'deploy' && row.cancelRequestedAt === null
        && loaded.row.telemetryMachineId && loaded.row.telemetryPendingTokenHash
        && loaded.row.telemetryPendingTargetLinkId === link.id
        && loaded.row.telemetryPendingTargetLinkRevision === input.expectedTargetLinkRevision
        ? { machineId: loaded.row.telemetryMachineId, tokenHash: loaded.row.telemetryPendingTokenHash } : null;
    // Serving activation uses Home's acknowledged Vercel revision or the native executor's delivery.
    const deliveredTelemetry = pendingVercelTelemetry ?? ( input.kind === 'settle' && row.operation !== 'teardown'
        && (input.state === 'succeeded' || input.state === 'running_unverified')
        && input.telemetryMachineId && input.telemetryMachineId === loaded.row.telemetryMachineId
        && input.telemetryTokenHash && input.telemetryTokenHash !== loaded.row.telemetryTokenHash
        ? { machineId: input.telemetryMachineId, tokenHash: input.telemetryTokenHash } : null);
    if (input.contentUpdate) {
        const updated = await updateDeploymentStoredContentInTx(tx, actorAccountId, loaded, nextContent, input.contentUpdate,
            DEPLOYMENT_RECEIPT_ARTIFACT_STORED_KIND_V1, deliveredTelemetry
                ? await readDeploymentTelemetryPublicationAccountIdsInTx(tx, [deliveredTelemetry.machineId]) : []);
        if (!updated.ok) return updated;
        nextContent = updated.reference;
    }
    const now = await readTransactionDatabaseTime(tx);
    const settledAt = isDeploymentSettledV1(input.state) ? now : null;
    const changed = await tx.deployment.updateMany({ where: { id: row.id, revision: input.expectedRevision }, data: {
        state: input.state, revision: { increment: 1 }, ...nextContent,
        ...(input.teardownProof ? { teardownProof: { ...input.teardownProof, ...(removeEnvironment ? { removeEnvironment: true } : {}) } } : {}),
        ...(input.state === 'running' && !row.startedAt ? { startedAt: now } : {}),
        ...(settledAt ? { settledAt } : {}),
        ...(resumedTeardown ? { settledAt: null } : {}),
    } });
    if (changed.count !== 1) throw new Error('Locked deployment receipt changed during transition');
    if (deliveredTelemetry) {
        await stampDeploymentTelemetryAssignmentInTx(tx, loaded.row.id, deliveredTelemetry);
        if (pendingVercelTelemetry) {
            await tx.deploymentEnvironment.update({ where: { id: loaded.row.id }, data: clearedDeploymentTelemetryPendingAssignment });
        }
        await publishDeploymentTelemetryMachinesInTx(tx, [deliveredTelemetry.machineId]);
    }
    if (input.expectedTargetLinkRevision !== undefined) {
        await tx.deploymentTargetLink.update({ where: { id: link.id }, data: { activeDeploymentId: input.servingDeploymentId ?? row.id, state: 'deployed', revision: { increment: 1 } } });
        // The signed uniform receipt and Domain owner jointly prove joining readiness.
        if (activatesJoining) {
            await tx.deploymentTargetLinkMachine.updateMany({ where: { targetLinkId: link.id, state: 'joining' }, data: { state: 'active' } });
        }
        await publishDeploymentChangesInTx(tx, loaded, loaded.row.id, loaded.row.revision, undefined, false, accountIds);
    }
    let environmentRevision = loaded.row.revision;
    if (input.teardownProof && !removeEnvironment) {
        await revokeAppMachines!();
    }
    if (input.teardownProof && completeTeardown) {
        await tx.deploymentTargetLink.update({ where: { id: link.id }, data: { activeDeploymentId: null,
            state: input.teardownProof.retainedProviderResource ? 'provisioned' : 'configured', revision: { increment: 1 } } });
        if (removeEnvironment) {
            environmentRevision = await removeAdmittedDeploymentEnvironmentInTx(tx, { environment: loaded.row,
                source: loaded.source, now, knownAccountIds: accountIds, revokeAppMachines, forwardManagedWebhook });
        } else {
            if (loaded.row.runtimeTargetLinkId === link.id) {
                await disableDeploymentEnvironmentAutomationsInTx(tx, loaded.row.id, { observationOnly: true });
            }
            await publishDeploymentChangesInTx(tx, loaded, loaded.row.id, loaded.row.revision, undefined, false, accountIds);
        }
    }
    if (loaded.row.pendingDeployContent !== null && input.state !== 'queued' && input.state !== 'running'
        && input.expectedTargetLinkRevision === undefined && !completeTeardown) {
        await publishDeploymentChangesInTx(tx, loaded, loaded.row.id, loaded.row.revision, undefined, false, accountIds);
    }
    const deploymentRevision = input.expectedRevision + 1;
    const previousState = DeploymentStateV1Schema.parse(row.state);
    await publishDeploymentChangesInTx(tx, loaded, loaded.row.id, deploymentRevision, row.id,
        !isDeepStrictEqual(projectDeploymentReceiptActivityV1(previousState),
            projectDeploymentReceiptActivityV1(input.state)), accountIds,
        projectDeploymentReceiptCompletionV1(previousState,
            { state: input.state, settledAt, cancelRequestedAt: row.cancelRequestedAt },
            deploymentRevision, now.getTime()));
    return receiptResult({ id: row.id, environmentId: row.environmentId, revision: deploymentRevision, state: input.state },
        environmentRevision, removeEnvironment && completeTeardown);
}
