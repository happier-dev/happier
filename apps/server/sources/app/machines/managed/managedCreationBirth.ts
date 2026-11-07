import type { SessionManagedCreationV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import type { Tx } from '@/storage/inTx';
import { readCurrentServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { isManagedMachineCreator } from './managedRead';
import { readManagedController, resolveManagedMachineRoleInTx, sameManagedInput } from './managedRows';

/** Fresh Session/Run birth binds the admitted creator or controller access to the exact guest. */
export async function validateManagedCreationBirthInTx(tx: Tx, input: Readonly<{
    accountId: string;
    birth: SessionManagedCreationV1;
    executionMachineId?: string;
}>): Promise<boolean> {
    const { birth } = input;
    const resource = await tx.managedMachine.findUnique({ where: { id: birth.managedId }, select: {
        homeId: true, custodianAccountId: true, controllerMachineId: true, controllerInstallationId: true,
        creationState: true, allocation: true, enrolledMachineId: true, archivedAt: true,
        admittedInput: true,
    } });
    if (!resource || resource.homeId !== birth.homeId
        || birth.homeId !== await readCurrentServerIdentityId(process.env, tx)
        || !sameManagedInput(readManagedController(resource), birth.controller)
        || resource.creationState !== 'active' || resource.allocation !== 'bound'
        || !resource.enrolledMachineId || resource.archivedAt !== null
        || input.executionMachineId !== undefined && resource.enrolledMachineId !== input.executionMachineId) return false;
    return isManagedMachineCreator(resource, input.accountId)
        || Boolean(await resolveManagedMachineRoleInTx(tx, resource, input.accountId));
}
