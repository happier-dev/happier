import { DeploymentAcceptedExecutionV1Schema,
    type DeploymentAcceptedExecutionV1 } from '@happier-dev/protocol';
import type { ExternalActionExecutionAuthorizationBindingV1 } from '@happier-dev/protocol/actions/externalActionApi';
import type { FastifyRequest } from 'fastify';
import type { Tx } from '@/storage/inTx';
import type { Prisma } from '@prisma/client';
import { deploymentFailure } from './deploymentAdmission';
import { deploymentOperationForRootActionV1, deploymentChildEffectActionIdForRootV1 } from '@happier-dev/protocol';
import { readTemplateDeploymentEnvironmentIdInTx } from './deploymentPreparationAuthorization';
import { isDeploymentDomainAddActionIdV1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { deploymentInProgressStates } from '@happier-dev/protocol/deployments/deploymentActionsV1';

type AcceptedIdentity = Omit<DeploymentAcceptedExecutionV1, 'v'>;
type AcceptedTarget = Readonly<{ sourceKind: string; targetKind: string }>;
type ReceiptCapture = Readonly<{
    acceptedControllerMachineId: string | null; acceptedControllerInstallationId: string | null;
    acceptedBuildMachineId: string | null; acceptedBuildInstallationId: string | null;
}>;
export type DeploymentReceiptContinuation = Readonly<{
    deploymentId: string; actionOperationId: string; environmentId: string; installationId: string;
    interruptedSettlement?: true;
}>;
type AcceptedReceiptBinding = Pick<ExternalActionExecutionAuthorizationBindingV1, 'accountId' | 'machineId' | 'actionId' | 'requestId' | 'target'>
    & Partial<Pick<ExternalActionExecutionAuthorizationBindingV1, 'requestEnvelopeDigest' | 'installationId' | 'environmentId' | 'workflowActionOrigin' | 'deploymentPreparationAdmission'>>;

/** Builder custody belongs only to the persisted native own-server target. */
export function isOwnServerDeploymentTarget(target: AcceptedTarget): boolean {
    return target.sourceKind === 'host' && target.targetKind === 'ownServer';
}

/** Authentication retains the signed root while projecting its admitted effect. */
export function readDeploymentExecutionEffectFromRequest(request: FastifyRequest): Readonly<{
    binding: ExternalActionExecutionAuthorizationBindingV1; actionId: string;
}> | null {
    const binding = request.externalActionExecutionAuthorizationBinding;
    const actionId = request.externalActionEffectActionId;
    if (!request.externalActionExecutionAuthorized || request.externalActionDeploymentChildSigner || !binding || !actionId
        || request.externalActionRootActionId !== binding.actionId || request.externalActionExecutionMachineId !== binding.machineId) return null;
    const reviewed = request.externalActionReviewedChildAdmission;
    return actionId === binding.actionId
        || actionId === `deployments.${deploymentOperationForRootActionV1(binding.actionId, binding.deploymentPreparationAdmission)}`
        || binding.actionId === 'deployments.environments.create' && reviewed?.actionId === actionId
            && (actionId === 'deployments.bindings.set' || actionId === 'deployments.domains.add')
        || reviewed !== undefined && isDeploymentDomainAddActionIdV1(reviewed.actionId) && actionId === reviewed.actionId
            && deploymentChildEffectActionIdForRootV1(binding.actionId, binding.deploymentPreparationAdmission, actionId) === actionId
        ? { binding, actionId } : null;
}

/** Only authentication can supply capture facts; the original root is never rewritten. */
export function readDeploymentExecutionBindingFromRequest(request: FastifyRequest): ExternalActionExecutionAuthorizationBindingV1 | null {
    return readDeploymentExecutionEffectFromRequest(request)?.binding ?? null;
}

/** Resolve capture identities; receipt admission admits these alongside target Machines in one set. */
export async function resolveDeploymentAcceptedIdentityInTx(tx: Tx, input: Readonly<{
    binding: ExternalActionExecutionAuthorizationBindingV1; actorAccountId: string; serverId: string;
    operation: 'deploy' | 'rollback' | 'promote' | 'teardown';
    environment: Readonly<{ id: string; controllerMachineId: string; buildMachineId: string | null }>;
    target: AcceptedTarget;
}>) {
    const { binding, environment } = input;
    if (binding.accountId !== input.actorAccountId || binding.serverIdentityId !== input.serverId
        || deploymentOperationForRootActionV1(binding.actionId, binding.deploymentPreparationAdmission) !== input.operation || binding.target.kind !== 'machine'
        || binding.target.machineId !== binding.machineId || binding.machineId !== environment.controllerMachineId
        || binding.environmentId !== undefined && binding.environmentId !== environment.id) {
        return deploymentFailure('deployment_access_denied');
    }
    if ((binding.actionId === 'deployments.templates.instantiate' || binding.actionId === 'deployments.environments.create')
        && await readTemplateDeploymentEnvironmentIdInTx(tx, binding) !== environment.id) return deploymentFailure('deployment_access_denied');
    const requiresBuilder = input.operation !== 'teardown' && isOwnServerDeploymentTarget(input.target);
    const builder = requiresBuilder && environment.buildMachineId
        ? await tx.machine.findUnique({ where: { id: environment.buildMachineId }, select: { id: true, installationId: true } }) : null;
    if (requiresBuilder && !builder?.installationId) return deploymentFailure('deployment_access_denied');
    const identity: AcceptedIdentity = { controller: { machineId: binding.machineId, installationId: binding.installationId },
        ...(builder?.installationId ? { builder: { machineId: builder.id, installationId: builder.installationId } } : {}) };
    return { ok: true as const, identity };
}

/** Accepted custody is independent of subsequent Environment edits and receipt replay. */
export function createDeploymentAcceptedExecution(identity: AcceptedIdentity): DeploymentAcceptedExecutionV1 {
    return DeploymentAcceptedExecutionV1Schema.parse({ v: 1, ...identity });
}

export function deploymentAcceptedExecutionColumns(capture: DeploymentAcceptedExecutionV1): ReceiptCapture {
    return { acceptedControllerMachineId: capture.controller.machineId, acceptedControllerInstallationId: capture.controller.installationId,
        acceptedBuildMachineId: capture.builder?.machineId ?? null, acceptedBuildInstallationId: capture.builder?.installationId ?? null };
}

/** Uncaptured history stays readable, but partial or malformed identities never become native authority. */
export function readDeploymentAcceptedExecution(row: ReceiptCapture): DeploymentAcceptedExecutionV1 | null {
    if ((row.acceptedBuildMachineId === null) !== (row.acceptedBuildInstallationId === null)) return null;
    const parsed = DeploymentAcceptedExecutionV1Schema.safeParse({ v: 1,
        controller: { machineId: row.acceptedControllerMachineId, installationId: row.acceptedControllerInstallationId },
        ...(row.acceptedBuildMachineId !== null ? { builder: { machineId: row.acceptedBuildMachineId,
            installationId: row.acceptedBuildInstallationId } } : {}) });
    return parsed.success ? parsed.data : null;
}

/** Captured receipt identity authorizes continuation, independently of the requester's current credential or membership. */
export async function hasAcceptedDeploymentReceiptInTx(tx: Tx, binding: AcceptedReceiptBinding,
    continuation?: DeploymentReceiptContinuation, constraints: Prisma.DeploymentWhereInput = {},
): Promise<boolean> {
    if (binding.target.kind !== 'machine' || binding.target.machineId !== binding.machineId
        || !binding.requestEnvelopeDigest || !binding.installationId
        || continuation && (continuation.installationId !== binding.installationId
            || binding.environmentId !== undefined && binding.environmentId !== continuation.environmentId)) return false;
    const operation = deploymentOperationForRootActionV1(binding.actionId, binding.deploymentPreparationAdmission);
    const observing = binding.actionId === 'deployments.receipts.observe';
    if (!operation && !observing || observing && !continuation) return false;
    const originalRequest = operation ? { operation, acceptedRequestEnvelopeDigest: binding.requestEnvelopeDigest } : {};
    if (binding.workflowActionOrigin && binding.workflowActionOrigin.requestId !== binding.requestId) return false;
    const workflowRun = binding.workflowActionOrigin ? {
        id: binding.workflowActionOrigin.runId, accountId: binding.accountId,
        state: { in: ['claimed', 'running', 'paused'] }, workflowCustodyState: 'pending',
        workflowAcceptedSnapshotEnvelope: { not: null },
    } satisfies Prisma.AutomationRunWhereInput : undefined;
    // An observer may spend captured installation custody on another requester's
    // receipt. Its Workflow belongs to the observer, not requestedByAccount.
    if (observing && workflowRun && !await tx.automationRun.findFirst({ where: workflowRun, select: { id: true } })) return false;
    return await tx.deployment.findFirst({ where: { AND: [constraints, {
        ...(continuation ? { id: continuation.deploymentId, environmentId: continuation.environmentId,
            actionOperationId: continuation.actionOperationId } : binding.environmentId ? { environmentId: binding.environmentId } : {}),
        // A fresh signed root can release its requester's interrupted slot on
        // the captured controller, without borrowing the old execution root.
        ...(observing ? { state: { in: deploymentInProgressStates() } } : continuation?.interruptedSettlement ? { OR: [
            originalRequest,
            { state: { in: deploymentInProgressStates() } },
        ] } : originalRequest),
        // Observation spends the installation's existing receipt custody, not
        // another permission to repeat the original requester's native effect.
        ...(!observing ? { requestedByAccountId: binding.accountId } : {}),
        acceptedControllerMachineId: binding.machineId, acceptedControllerInstallationId: binding.installationId,
        // Keep the active-job lookup in this same query for Workflow roots.
        ...(workflowRun && !observing ? { requestedByAccount: { automationRuns: { some: workflowRun } } } : {}),
    }] }, select: { id: true } }) !== null;
}

export { deploymentInProgressStates } from '@happier-dev/protocol/deployments/deploymentActionsV1';
