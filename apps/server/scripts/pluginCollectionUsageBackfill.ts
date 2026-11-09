import { pathToFileURL } from 'node:url';
import { requireDbProviderFromEnv } from '../sources/storage/db';
import { runPluginCollectionUsageBackfill } from '../sources/app/plugins/data/collections/usageTotalsBackfill';

export * from '../sources/app/plugins/data/collections/usageTotalsBackfill';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const provider = requireDbProviderFromEnv(process.env, 'postgres');
    void runPluginCollectionUsageBackfill({ provider, databaseUrl: process.env.DATABASE_URL }).then(result => {
        process.stdout.write(`${JSON.stringify({ provider, ...result })}\n`);
    }).catch(() => {
        process.stderr.write('Collection usage backfill failed; inspect the database connection and rerun the idempotent command.\n');
        process.exitCode = 1;
    });
}
