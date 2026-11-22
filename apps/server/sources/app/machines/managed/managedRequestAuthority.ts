import type { FastifyRequest } from 'fastify';
import type { Tx } from '@/storage/inTx';
import { resolveCurrentMachineRecipientAccountIdsInTx } from '@/app/machines/machineAccess';

/** Authentication has already applied the credential's authority ceiling. */
export function isManagedPresentUser(request: Pick<FastifyRequest, 'authTokenKind' | 'authAuthority' | 'authTokenLegacy'>): boolean {
    return request.authTokenKind === 'account' && request.authAuthority === 'present_user' && request.authTokenLegacy === false;
}

/** A guest may act only for its own row. A shared Account daemon needs the owner's scoped control proof. */
export async function resolveSignedManagedAccountExecutorInTx<TMachine extends Readonly<{
    id: string; accountId: string; kind: string; managedResource: { id: string } | null;
}>>(tx: Tx, machine: TMachine | null,
custody: Readonly<{ custodianAccountId: string; managedId?: string; enrolledMachineId?: string | null; ownerControlProof?: boolean }>): Promise<TMachine | null> {
    if (!machine) return null;
    if (machine.id === custody.enrolledMachineId && machine.managedResource?.id === custody.managedId) return machine;
    if (machine.kind !== 'persistent' || machine.accountId !== custody.custodianAccountId || machine.managedResource) return null;
    if (custody.ownerControlProof) return machine;
    const recipients = await resolveCurrentMachineRecipientAccountIdsInTx(tx, machine.id);
    return recipients.every(accountId => accountId === custody.custodianAccountId) ? machine : null;
}
