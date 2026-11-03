import { MachinePresenceTransitionsV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { markAccountChanged } from '@/app/changes/markAccountChanged';
import { readAccessibleMachineAccessInTx } from '@/app/machines/machineAccess';
import { getDbProviderFromEnv, resolveDbSqlDialect } from '@/config/databaseProvider';
import type { Tx } from '@/storage/inTx';

export async function readMachinePresenceForAccountInTx(tx: Tx, input: Readonly<{ actorAccountId: string; machineId: string }>) {
    const access = await readAccessibleMachineAccessInTx(tx, input);
    if (!access) return { kind: 'refused' as const, code: 'machine_unavailable' as const };
    return { kind: 'present' as const, machineId: input.machineId,
        transitions: await readMachinePresenceTransitionsInTx(tx, input.machineId) };
}

/** The containing presence transaction already locks and decides this Machine. */
export async function readMachinePresenceTransitionsInTx(tx: Pick<Tx, '$queryRaw'>, machineId: string) {
    const dialect = resolveDbSqlDialect(getDbProviderFromEnv(process.env, 'postgres'));
    const rows = dialect === 'mysql'
        ? await tx.$queryRaw<Array<{ presenceTransitions: string | null }>>`SELECT \`presenceTransitions\` FROM \`Machine\` WHERE \`id\` = ${machineId}`
        : await tx.$queryRaw<Array<{ presenceTransitions: string | null }>>`SELECT "presenceTransitions" FROM "Machine" WHERE "id" = ${machineId}`;
    const stored = rows[0]?.presenceTransitions;
    return stored == null ? null : MachinePresenceTransitionsV1Schema.parse(JSON.parse(stored));
}

/** Retain only decided changes, with identity independent of heartbeat clocks.
 * The first alive observation has no prior offline occurrence and emits none. */
export async function retainMachinePresenceTransitionInTx(tx: Tx, input: Readonly<{
    machineId: string; active: boolean; occurredAt: number; recipientAccountIds: readonly string[];
}>): Promise<void> {
    const previous = await readMachinePresenceTransitionsInTx(tx, input.machineId);
    if (input.active && previous === null) return;
    const revision = (previous?.revision ?? 0) + 1;
    const occurrence = { revision, occurredAt: input.occurredAt };
    const transitions = MachinePresenceTransitionsV1Schema.parse({ v: 1, revision,
        offline: input.active ? previous?.offline ?? null : occurrence,
        online: input.active ? occurrence : previous?.online ?? null });
    const stored = JSON.stringify(transitions);
    const dialect = resolveDbSqlDialect(getDbProviderFromEnv(process.env, 'postgres'));
    // Like the owning presence write, this must leave content clocks untouched.
    if (dialect === 'mysql') await tx.$executeRaw`UPDATE \`Machine\` SET \`presenceTransitions\` = ${stored} WHERE \`id\` = ${input.machineId}`;
    else await tx.$executeRaw`UPDATE "Machine" SET "presenceTransitions" = ${stored} WHERE "id" = ${input.machineId}`;
    for (const accountId of input.recipientAccountIds) await markAccountChanged(tx, { accountId, kind: 'machine', entityId: input.machineId });
}
