import type { TransactionClient } from '@/storage/db';
import type { Machine } from '@prisma/client';
import { getDbProviderFromEnv, resolveDbSqlDialect } from '@/config/databaseProvider';
import { prismaRuntime } from '@/storage/prisma';

export type MachinePresenceRow = Pick<Machine,
    'id' | 'accountId' | 'installationId' | 'active' | 'lastActiveAt' | 'kind' | 'revokedAt' | 'replacedByMachineId'>;

/** Acquire admission facts in the same read that serializes presence writers. */
export async function lockMachinePresenceInTx(
    tx: Pick<TransactionClient, '$queryRaw' | 'machine'>,
    machineId: string,
    alreadyLockedRow?: MachinePresenceRow,
): Promise<MachinePresenceRow | null> {
    const dialect = resolveDbSqlDialect(getDbProviderFromEnv(process.env, 'postgres'));
    // The containing semantic publisher may supply its post-lock row. Its
    // PostgreSQL Machine lock (or SQLite writer admission) lasts through this
    // transaction. MySQL's publisher has only an Account fence, so acquire the
    // Machine row here even when the caller supplies previously admitted facts.
    if (alreadyLockedRow && dialect !== 'mysql') return alreadyLockedRow;
    if (dialect === 'postgres') {
        const rows = await tx.$queryRaw<MachinePresenceRow[]>`
            SELECT "id", "accountId", "installationId", "active", "lastActiveAt", "kind", "revokedAt", "replacedByMachineId"
            FROM "Machine" WHERE "id" = ${machineId} FOR UPDATE`;
        return rows[0] ?? null;
    }
    if (dialect === 'mysql') {
        const rows = await tx.$queryRaw<Array<Omit<MachinePresenceRow, 'active'> & { active: boolean | number }>>`
            SELECT \`id\`, \`accountId\`, \`installationId\`, \`active\`, \`lastActiveAt\`, \`kind\`, \`revokedAt\`, \`replacedByMachineId\`
            FROM \`Machine\` WHERE \`id\` = ${machineId} FOR UPDATE`;
        const row = rows[0];
        return row ? { ...row, active: row.active === true || row.active === 1 } : null;
    }
    // SQLite's containing write transaction already owns writer admission.
    return tx.machine.findUnique({ where: { id: machineId }, select: { id: true, accountId: true, installationId: true,
        active: true, lastActiveAt: true, kind: true, revokedAt: true, replacedByMachineId: true } });
}

/** Presence batches may settle after a newer heartbeat or daemon publication. */
export async function persistMachinePresence(
    tx: Pick<TransactionClient, '$executeRaw'>,
    presence: Readonly<{ accountId: string; machineId: string; timestamp: number }>,
    currentPublisher?: Readonly<{ installationId: string | null }>,
): Promise<number> {
    const lastActiveAt = new Date(presence.timestamp);
    // Prisma's @updatedAt would turn this observation into a content edit.
    // Leave that column untouched in the same atomic, monotonic presence write;
    // reading and restoring its value could roll back a concurrent content edit.
    const dialect = resolveDbSqlDialect(getDbProviderFromEnv(process.env, 'postgres'));
    if (dialect === 'postgres') {
        // Prisma DateTime columns contain timezone-free UTC. Raw Date parameters
        // are timestamptz; assigning/comparing them would apply the session zone.
        const utcObservation = lastActiveAt.toISOString();
        return await tx.$executeRaw`
            UPDATE "Machine" SET "lastActiveAt" = CAST(${utcObservation} AS timestamp), "active" = true
            WHERE "accountId" = ${presence.accountId} AND "id" = ${presence.machineId}
                AND "revokedAt" IS NULL AND "replacedByMachineId" IS NULL
                AND "lastActiveAt" <= CAST(${utcObservation} AS timestamp)
                ${currentPublisher ? prismaRuntime.sql`AND "active" = true
                    AND "installationId" IS NOT DISTINCT FROM ${currentPublisher.installationId}` : prismaRuntime.empty}
        `;
    } else if (dialect === 'mysql') {
        return await tx.$executeRaw`
            UPDATE \`Machine\` SET \`lastActiveAt\` = ${lastActiveAt}, \`active\` = true
            WHERE \`accountId\` = ${presence.accountId} AND \`id\` = ${presence.machineId}
                AND \`revokedAt\` IS NULL AND \`replacedByMachineId\` IS NULL
                AND \`lastActiveAt\` <= ${lastActiveAt}
                ${currentPublisher ? prismaRuntime.sql`AND \`active\` = true
                    AND \`installationId\` <=> ${currentPublisher.installationId}` : prismaRuntime.empty}
        `;
    } else {
        return await tx.$executeRaw`
            UPDATE "Machine" SET "lastActiveAt" = ${lastActiveAt}, "active" = true
            WHERE "accountId" = ${presence.accountId} AND "id" = ${presence.machineId}
                AND "revokedAt" IS NULL AND "replacedByMachineId" IS NULL
                AND "lastActiveAt" <= ${lastActiveAt}
                ${currentPublisher ? prismaRuntime.sql`AND "active" = true
                    AND "installationId" IS ${currentPublisher.installationId}` : prismaRuntime.empty}
        `;
    }
}

/** Only the current observation can expire; presence must not touch content clocks. */
export async function markMachinePresenceInactive(
    tx: Pick<TransactionClient, '$executeRaw'>,
    presence: Readonly<{ accountId: string; machineId: string; lastActiveAt: Date }>,
): Promise<number> {
    const dialect = resolveDbSqlDialect(getDbProviderFromEnv(process.env, 'postgres'));
    if (dialect === 'postgres') {
        const utcObservation = presence.lastActiveAt.toISOString();
        return await tx.$executeRaw`
            UPDATE "Machine" SET "active" = false
            WHERE "accountId" = ${presence.accountId} AND "id" = ${presence.machineId}
                AND "active" = true AND "lastActiveAt" = CAST(${utcObservation} AS timestamp)
                AND "revokedAt" IS NULL AND "replacedByMachineId" IS NULL
        `;
    }
    if (dialect === 'mysql') {
        return await tx.$executeRaw`
            UPDATE \`Machine\` SET \`active\` = false
            WHERE \`accountId\` = ${presence.accountId} AND \`id\` = ${presence.machineId}
                AND \`active\` = true AND \`lastActiveAt\` = ${presence.lastActiveAt}
                AND \`revokedAt\` IS NULL AND \`replacedByMachineId\` IS NULL
        `;
    }
    return await tx.$executeRaw`
        UPDATE "Machine" SET "active" = false
        WHERE "accountId" = ${presence.accountId} AND "id" = ${presence.machineId}
            AND "active" = true AND "lastActiveAt" = ${presence.lastActiveAt}
            AND "revokedAt" IS NULL AND "replacedByMachineId" IS NULL
    `;
}
