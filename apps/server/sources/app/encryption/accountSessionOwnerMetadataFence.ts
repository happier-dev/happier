import type { Tx } from "@/storage/inTx";
import { getDbProviderFromEnv } from "@/storage/prisma";

function assertExactlyOneAccountRow(
    rowCount: number,
    accountId: string,
): void {
    if (rowCount !== 1) {
        throw new Error(
            `Account Session owner-metadata fence requires exactly one Account row for ${accountId}`,
        );
    }
}

/**
 * Acquires the Account-first serialization fence shared by Session owner-metadata writers.
 *
 * PostgreSQL-compatible providers and MySQL lock the Account row directly. SQLite reserves
 * the database writer with a bound no-op column update so Prisma's `@updatedAt` behavior is
 * not invoked.
 */
export async function acquireAccountSessionOwnerMetadataFenceInTx(
    tx: Tx,
    accountId: string,
): Promise<void> {
    const provider = getDbProviderFromEnv(process.env, "postgres");

    if (provider === "sqlite") {
        const affectedRows = await tx.$executeRawUnsafe(
            'UPDATE "Account" SET "settingsVersion" = "settingsVersion" WHERE "id" = ?',
            accountId,
        );
        assertExactlyOneAccountRow(affectedRows, accountId);
        return;
    }

    const query = provider === "mysql"
        ? "SELECT `id` FROM `Account` WHERE `id` = ? FOR UPDATE"
        : 'SELECT "id" FROM "Account" WHERE "id" = $1 FOR UPDATE';
    const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        query,
        accountId,
    );
    assertExactlyOneAccountRow(rows.length, accountId);
}
