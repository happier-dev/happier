import { DeploymentAcceptedExecutionV1Schema,
    type DeploymentAcceptedExecutionV1 } from '@happier-dev/protocol';
import type { ExternalActionExecutionAuthorizationBindingV1 } from '@happier-dev/protocol/actions/externalActionApi';
import type { Tx } from '@/storage/inTx';
import type { Prisma } from '@prisma/client';
import { deploymentOperationForRootActionV1 } from '@happier-dev/protocol';
import { deploymentInProgressStates } from '@happier-dev/protocol/deployments/deploymentActionsV1';

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
