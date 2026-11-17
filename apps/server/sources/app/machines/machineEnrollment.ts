import { isDeploymentAppEnrollmentCorrelationV1, type MachineEnrollmentCorrelationV1 } from '@happier-dev/protocol/machines/enrollmentV1';
import type { Tx } from '@/storage/inTx';
import type { ManagedDeclarationBodies } from './managed/managedRows';
import { requireManagedMachineRegistrationInTx, linkManagedEnrollmentInTx } from './managed/managedMutations';
import { linkDeploymentAppEnrollmentInTx } from '@/app/deployments/deploymentAppEnrollment';

/** Every ordinary registration retains managed replacement protection, regardless of enrollment source. */
export async function requireMachineEnrollmentInTx(tx: Tx, input: Readonly<{
    accountId: string; machineId: string; enrollment?: MachineEnrollmentCorrelationV1;
    declarationBodies?: ManagedDeclarationBodies;
}>): Promise<void> {
    await requireManagedMachineRegistrationInTx(tx, { ...input, enrollment: input.enrollment && !isDeploymentAppEnrollmentCorrelationV1(input.enrollment)
        ? input.enrollment : undefined });
}

export async function linkMachineEnrollmentInTx(tx: Tx, input: MachineEnrollmentCorrelationV1, accountId: string,
    machineId: string, declarationBodies?: ManagedDeclarationBodies, terminalAuthRequestId?: string): Promise<void> {
    if (isDeploymentAppEnrollmentCorrelationV1(input)) await linkDeploymentAppEnrollmentInTx(tx, input, accountId, machineId, terminalAuthRequestId);
    else await linkManagedEnrollmentInTx(tx, input, accountId, machineId, declarationBodies);
}
