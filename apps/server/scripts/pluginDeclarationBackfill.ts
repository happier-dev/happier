import { backfillPluginDeclarations } from '../sources/app/plugins/availability/declarationBackfill';
import { createDbMaintenanceClient, requireDbProviderFromEnv } from '../sources/storage/db';

async function main(): Promise<void> {
    if (!process.env.DATABASE_URL?.trim()) throw new Error('DATABASE_URL is required');
    const provider = requireDbProviderFromEnv(process.env, 'postgres');
    const client = await createDbMaintenanceClient(provider, process.env.DATABASE_URL);
    const apply = process.argv.includes('--apply');
    try {
        await client.$connect();
        const result = await backfillPluginDeclarations(client, apply);
        console.log(JSON.stringify({ provider, apply, ...result }));
        if (result.conflicts || result.unsupported || result.incomplete) process.exitCode = 1;
    } finally { await client.$disconnect(); }
}
void main().catch(() => {
    // Prisma errors may include connection strings or declaration bodies.
    console.error('Plugin declaration backfill failed; verify the explicit database target and rerun.');
    process.exitCode = 1;
});
