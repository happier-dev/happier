import { resolveServerWorkspaceRoot } from "./prismaCli";
import { runPrismaMigrateCli } from "./prismaMigrateCli";
import {
    hasSessionSystemRecordContractMigration,
    runSessionSystemRecordFinalContractBackfill,
} from "../sources/app/session/systemRecords/sessionSystemRecordBackfillExecution";
import {
    runSessionSystemRecordMigrationDeployment,
} from "../sources/app/session/systemRecords/sessionSystemRecordMigrationDeployment";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveMigrationEnv } from "./migrationEnv";
import { runPluginCollectionUsageMigrationDeployment } from '../sources/app/plugins/data/collections/usageTotalsBackfill';

export async function runPostgresMigrationDeploy(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
    const env = resolveMigrationEnv(environment, "postgres");
    const serverRoot = resolveServerWorkspaceRoot(import.meta.url);
    await runSessionSystemRecordMigrationDeployment({
        migrationsDir: join(serverRoot, "prisma", "migrations"),
        schemaPath: join(serverRoot, "prisma", "schema.prisma"),
        isContractApplied: async () => await hasSessionSystemRecordContractMigration({
            provider: "postgres",
            databaseUrl: String(env.DATABASE_URL ?? "").trim(),
        }),
        deploy: async (stage) => {
            await runPluginCollectionUsageMigrationDeployment({
                ...stage, provider: 'postgres', databaseUrl: String(env.DATABASE_URL ?? '').trim(), env,
                deploy: async target => await runPrismaMigrateCli({ serverRoot, schemaPath: target.schemaPath!, args: ['deploy'], env }),
            });
        },
        runFinalContractBackfill: async () => {
            await runSessionSystemRecordFinalContractBackfill({
                provider: "postgres",
                databaseUrl: String(env.DATABASE_URL ?? "").trim(),
            });
        },
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    runPostgresMigrationDeploy().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
