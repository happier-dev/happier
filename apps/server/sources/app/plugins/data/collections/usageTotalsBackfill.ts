import { acquireAccountSessionOwnerMetadataFenceInTx } from '@/app/encryption/accountSessionOwnerMetadataFence';
import { backfillPluginCollectionUsageTotalsInTx } from './usageTotals';
import { readDatabaseTransactionConfigFromEnv } from '@/config/databaseTransactions';
import { createDbMaintenanceClient, type DbProvider } from '@/storage/db';
import { runBackfilledMigrationDeployment, type BackfilledMigrationStage, type BackfilledMigrationDeployResult } from '@/migrations/backfilledMigrationDeployment';

export const PLUGIN_COLLECTION_USAGE_EXPAND_MIGRATION = '20261030193000_plugin_collection_usage_totals';
export const PLUGIN_COLLECTION_USAGE_BACKFILLED_MIGRATION = '20261030193100_plugin_collection_usage_backfilled';

/** One explicit repair command; each Account shares the normal writer's transaction fence. */
export async function runPluginCollectionUsageBackfill(input: Readonly<{
    provider: DbProvider; databaseUrl?: string; env?: NodeJS.ProcessEnv;
}>): Promise<{ accounts: number }> {
    const client = await createDbMaintenanceClient(input.provider, input.databaseUrl);
    const config = readDatabaseTransactionConfigFromEnv(input.env ?? process.env, input.provider);
    try {
        await client.$connect();
        let accounts = 0;
        let afterId: string | undefined;
        for (;;) {
            const account = await client.account.findFirst({ where: afterId ? { id: { gt: afterId } } : {},
                orderBy: { id: 'asc' }, select: { id: true } });
            if (!account) break;
            await client.$transaction(async tx => {
                await acquireAccountSessionOwnerMetadataFenceInTx(tx, account.id, 'serializing', input.provider);
                await backfillPluginCollectionUsageTotalsInTx({ tx, accountId: account.id });
            }, { timeout: config.timeoutMs, maxWait: config.maxWaitMs });
            accounts += 1;
            afterId = account.id;
        }
        return { accounts };
    } finally {
        await client.$disconnect();
    }
}

async function hasBackfilledMigration(input: Readonly<{ provider: DbProvider; databaseUrl?: string }>): Promise<boolean> {
    const client = await createDbMaintenanceClient(input.provider, input.databaseUrl);
    try {
        await client.$connect();
        const rows = await client.$queryRawUnsafe<Array<{ migration_name: string }>>(
            `SELECT migration_name FROM _prisma_migrations WHERE migration_name = '${PLUGIN_COLLECTION_USAGE_BACKFILLED_MIGRATION}' AND finished_at IS NOT NULL AND rolled_back_at IS NULL`,
        );
        return rows.length > 0;
    } catch (error) {
        const message = error instanceof Error ? error.message.toLowerCase() : '';
        if (message.includes('no such table') || message.includes('does not exist') || message.includes("doesn't exist") || message.includes('unknown table')) return false;
        throw error;
    } finally {
        await client.$disconnect();
    }
}

/** Reuses the existing migration ledger/staging owner; no recurring runtime reconciliation. */
export async function runPluginCollectionUsageMigrationDeployment<T>(input: Readonly<{
    provider: DbProvider; databaseUrl?: string; env?: NodeJS.ProcessEnv; migrationsDir: string; schemaPath?: string;
    deploy: (stage: BackfilledMigrationStage) => Promise<T>;
}>): Promise<BackfilledMigrationDeployResult<T>> {
    return runBackfilledMigrationDeployment({
        migrationsDir: input.migrationsDir,
        ...(input.schemaPath ? { schemaPath: input.schemaPath } : {}),
        migrationSequence: { expandMigration: PLUGIN_COLLECTION_USAGE_EXPAND_MIGRATION, contractMigration: PLUGIN_COLLECTION_USAGE_BACKFILLED_MIGRATION },
        isContractApplied: () => hasBackfilledMigration(input),
        deploy: input.deploy,
        runFinalContractBackfill: async () => { await runPluginCollectionUsageBackfill(input); },
    });
}

