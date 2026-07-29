import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyLightDefaultEnv, resolveLightSqliteDatabaseUrl } from "../sources/flavors/light/env";
import {
    resolveSqliteDatabaseFilePath,
    resolveSqliteMigrationBusyTimeoutMs,
    resolveSqliteMigrationsDir,
} from "../sources/flavors/light/sqliteMigrations";
import { requireLightDataDir } from "./migrate.light.deployPlan";
import { applySqliteMigrations } from "./prismaMigrations";
import { resolveServerWorkspaceRoot } from "./prismaCli";
import { runCommand } from "./runCommand";

function ensureSqliteDatabaseUrl(env: NodeJS.ProcessEnv): void {
    const raw = env.DATABASE_URL?.trim();
    if (raw) return;

    const dataDir = requireLightDataDir(env);
    env.DATABASE_URL = resolveLightSqliteDatabaseUrl(dataDir);
}

async function ensureSqliteDbDir(env: NodeJS.ProcessEnv): Promise<void> {
    const url = env.DATABASE_URL?.trim() ?? "";
    const filePath = resolveSqliteDatabaseFilePath(url);
    if (!filePath) return;
    await mkdir(dirname(filePath), { recursive: true });
}

type RunSqliteMigrationDeployParams = Readonly<{
    env?: NodeJS.ProcessEnv;
    serverRoot?: string;
    runSchemaSync?: (params: Readonly<{ env: NodeJS.ProcessEnv; serverRoot: string }>) => Promise<void>;
}>;

export async function runSqliteMigrationDeploy(
    params: RunSqliteMigrationDeployParams = {},
): Promise<{ applied: string[] }> {
    const env: NodeJS.ProcessEnv = params.env ?? { ...process.env };
    const serverRoot = params.serverRoot ?? resolveServerWorkspaceRoot(import.meta.url);
    applyLightDefaultEnv(env);

    const dataDir = requireLightDataDir(env);
    await mkdir(dataDir, { recursive: true });

    if (params.runSchemaSync) {
        await params.runSchemaSync({ env, serverRoot });
    } else {
        await runCommand("yarn", ["-s", "schema:sync", "--quiet"], env, { cwd: serverRoot });
    }

    ensureSqliteDatabaseUrl(env);
    await ensureSqliteDbDir(env);
    const databaseUrl = String(env.DATABASE_URL ?? "").trim();
    const databasePath = resolveSqliteDatabaseFilePath(databaseUrl);
    if (!databasePath) {
        throw new Error("SQLite migration deploy requires DATABASE_URL=file:... to be set");
    }
    env.HAPPIER_SQLITE_MIGRATIONS_DIR =
        String(env.HAPPIER_SQLITE_MIGRATIONS_DIR ?? env.HAPPY_SQLITE_MIGRATIONS_DIR ?? "").trim()
        || join(serverRoot, "prisma", "sqlite", "migrations");

    return await applySqliteMigrations({
        databasePath,
        busyTimeoutMs: resolveSqliteMigrationBusyTimeoutMs(databaseUrl),
        migrationsDir: resolveSqliteMigrationsDir(env, dataDir),
    });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    void runSqliteMigrationDeploy().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
