import { runPrismaCli, resolveServerWorkspaceRoot } from "./prismaCli";
import {
    hasSessionSystemRecordContractMigration,
    runSessionSystemRecordFinalContractBackfill,
} from "../sources/app/session/systemRecords/sessionSystemRecordBackfillExecution";
import {
    runSessionSystemRecordMigrationDeployment,
} from "../sources/app/session/systemRecords/sessionSystemRecordMigrationDeployment";
import { join } from "node:path";

async function main() {
    const env: NodeJS.ProcessEnv = { ...process.env };
    const serverRoot = resolveServerWorkspaceRoot(import.meta.url);
    await runSessionSystemRecordMigrationDeployment({
        migrationsDir: join(serverRoot, "prisma", "migrations"),
        schemaPath: join(serverRoot, "prisma", "schema.prisma"),
        isContractApplied: async () => await hasSessionSystemRecordContractMigration({
            provider: "postgres",
            databaseUrl: String(env.DATABASE_URL ?? "").trim(),
        }),
        deploy: async (stage) => await runPrismaCli({
            serverRoot,
            args: ["migrate", "deploy", "--schema", stage.schemaPath!],
            env,
        }),
        runFinalContractBackfill: async () => {
            await runSessionSystemRecordFinalContractBackfill({
                provider: "postgres",
                databaseUrl: String(env.DATABASE_URL ?? "").trim(),
            });
        },
    });
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
