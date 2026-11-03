import { DeploymentAcceptedExecutionV1Schema,
    type DeploymentAcceptedExecutionV1 } from '@happier-dev/protocol';

type ReceiptCapture = Readonly<{
    acceptedControllerMachineId: string | null; acceptedControllerInstallationId: string | null;
    acceptedBuildMachineId: string | null; acceptedBuildInstallationId: string | null;
}>;

export function readDeploymentAcceptedExecution(row: ReceiptCapture): DeploymentAcceptedExecutionV1 | null {
    if ((row.acceptedBuildMachineId === null) !== (row.acceptedBuildInstallationId === null)) return null;
    const parsed = DeploymentAcceptedExecutionV1Schema.safeParse({ v: 1,
        controller: { machineId: row.acceptedControllerMachineId, installationId: row.acceptedControllerInstallationId },
        ...(row.acceptedBuildMachineId !== null ? { builder: { machineId: row.acceptedBuildMachineId,
            installationId: row.acceptedBuildInstallationId } } : {}) });
    return parsed.success ? parsed.data : null;
}

/** Captured receipt identity authorizes continuation, independently of the requester's current credential or membership. */

export { deploymentInProgressStates } from '@happier-dev/protocol/deployments/deploymentActionsV1';
