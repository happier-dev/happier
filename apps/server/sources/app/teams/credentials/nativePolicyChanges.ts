import type { Prisma } from '@prisma/client';
import type { Tx } from '@/storage/inTx';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import { invalidateManagedMachineInTx, readManagedMachinePolicyPublicationAudienceInTx } from '@/app/machines/managed/managedRows';

/** Capture the controller identities before FK cascade. Existing managed
 * publication delivers the wake after commit; reconnect reconstructs missed work. */
type NativePolicyScope =
    Readonly<{ sessionIds: readonly string[] }> | Readonly<{ resourceIds: readonly string[] }>
    | Readonly<{ accountId: string }>;

async function readNativePolicyMachinesInTx(tx: Tx, input: NativePolicyScope) {
    const scopes: Prisma.SessionTeamCredentialBindingWhereInput[] = 'accountId' in input
        ? [{ OR: [{ session: { accountId: input.accountId } }, { resource: { custodianAccountId: input.accountId } }] }]
        : [...portableQueryChunks({ values: [...new Set('sessionIds' in input ? input.sessionIds : input.resourceIds)],
            bindingsPerValue: 1 })].map(ids => ({ ['sessionIds' in input ? 'sessionId' : 'resourceId']: { in: [...ids] } }));
    const managedIds = new Set<string>();
    for (const scope of scopes) {
        const rows = await tx.sessionTeamCredentialBinding.findMany({
            where: { ...scope, nativeManagedId: { not: null } }, select: { nativeManagedId: true },
        });
        for (const row of rows) if (row.nativeManagedId) managedIds.add(row.nativeManagedId);
    }
    const machines = [];
    for (const ids of portableQueryChunks({ values: [...managedIds], bindingsPerValue: 1 })) {
        machines.push(...await tx.managedMachine.findMany({ where: { id: { in: [...ids] } } }));
    }
    return machines;
}

export async function readNativeCredentialPolicyPublicationAccountIdsInTx(tx: Tx, input: NativePolicyScope): Promise<string[]> {
    const machines = await readNativePolicyMachinesInTx(tx, input);
    const audiences = await Promise.all(machines.map(machine => readManagedMachinePolicyPublicationAudienceInTx(tx, machine)));
    return [...new Set(audiences.flatMap(audience => audience.resourceAccountIds))];
}

export async function publishNativeCredentialPolicyChangesInTx(tx: Tx, input: NativePolicyScope): Promise<void> {
    await (await prepareNativeCredentialPolicyChangesInTx(tx, input))();
}

/** Conditional deletes capture before cascade and publish only after their CAS wins. */
export async function prepareNativeCredentialPolicyChangesInTx(tx: Tx, input: NativePolicyScope): Promise<() => Promise<void>> {
    const machines = await readNativePolicyMachinesInTx(tx, input);
    return async () => {
        for (const machine of machines) await invalidateManagedMachineInTx(tx, machine);
    };
}
