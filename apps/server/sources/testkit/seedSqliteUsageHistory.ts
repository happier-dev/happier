import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prismaRuntime, type PrismaClientType } from '@/storage/db';

export type SqliteUsageHistoryRow = Readonly<{
    id?: string;
    accountId: string;
    recordId: string;
    observedAt: Date;
    payload: Prisma.InputJsonValue;
}>;

/** Retained fixtures only; current observations and projection backfills use their real producers. */
export async function seedSqliteUsageHistory(
    client: Pick<PrismaClientType, '$queryRaw' | '$executeRaw'>,
    rows: readonly SqliteUsageHistoryRow[],
): Promise<number> {
    if (rows.length === 0) return 0;
    const options = await client.$queryRaw<Array<{ compile_options: string }>>`PRAGMA compile_options`;
    const variableLimit = Number(options.find(row => row.compile_options.startsWith('MAX_VARIABLE_NUMBER='))?.compile_options.split('=')[1]);
    // This is the compiled engine's boundary, not Prisma createMany's smaller
    // connector partition. Five values bind id/account/record/time/JSON.
    if (!Number.isSafeInteger(variableLimit) || variableLimit < 5) {
        throw new Error('SQLite fixture seeding requires the compiled variable limit');
    }
    const rowsPerStatement = Math.floor(variableLimit / 5);
    let inserted = 0;
    for (let start = 0; start < rows.length; start += rowsPerStatement) {
        const tuples = rows.slice(start, start + rowsPerStatement).map(row => prismaRuntime.sql`(
            ${row.id ?? randomUUID()}, ${row.accountId}, ${row.recordId}, ${row.observedAt.getTime()}, ${JSON.stringify(row.payload)}
        )`);
        inserted += await client.$executeRaw(prismaRuntime.sql`
            INSERT INTO "ProviderAccountUsageHistory" ("id", "accountId", "recordId", "observedAt", "payload")
            VALUES ${prismaRuntime.join(tuples)}
        `);
    }
    return inserted;
}
