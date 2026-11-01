import type { Tx } from '@/storage/inTx';
import { resolveCurrentMachineRecipientAccountIdsInTx } from '@/app/machines/machineAccess';

/** A guest may act only for its own row; an Account daemon must have no other recipient. */
export async function resolveSignedManagedAccountExecutorInTx<TMachine extends Readonly<{
    id: string; accountId: string; kind: string; managedResource: { id: string } | null;
}>>(tx: Tx, machine: TMachine | null,
custody: Readonly<{ custodianAccountId: string; managedId?: string; enrolledMachineId?: string | null }>): Promise<TMachine | null> {
    if (!machine) return null;
    if (machine.id === custody.enrolledMachineId && machine.managedResource?.id === custody.managedId) return machine;
    if (machine.kind !== 'persistent' || machine.accountId !== custody.custodianAccountId || machine.managedResource) return null;
    const recipients = await resolveCurrentMachineRecipientAccountIdsInTx(tx, machine.id);
    return recipients.every(accountId => accountId === custody.custodianAccountId) ? machine : null;
}
