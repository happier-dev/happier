import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { applyLightDefaultEnv, resolveLightSqliteDatabaseUrl } from "../sources/flavors/light/env";
import { resolveSqliteDatabaseFilePath } from "../sources/flavors/light/sqliteMigrations";
import { requireLightDataDir } from "./migrate.light.deployPlan";
import { applySqliteMigrations } from "./prismaMigrations";
import { resolveServerWorkspaceRoot } from "./prismaCli";

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, {
            env: env as Record<string, string>,
            stdio: "inherit",
            shell: false,
            cwd: resolveServerWorkspaceRoot(import.meta.url),
        });
        child.on("error", reject);
        child.on("exit", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`${cmd} exited with code ${code}`));
        });
    });
}

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

async function main() {
    const env: NodeJS.ProcessEnv = { ...process.env };
    const serverRoot = resolveServerWorkspaceRoot(import.meta.url);
    applyLightDefaultEnv(env);

    const dataDir = requireLightDataDir(env);
    await mkdir(dataDir, { recursive: true });

    await run("yarn", ["-s", "schema:sync", "--quiet"], env);

    ensureSqliteDatabaseUrl(env);
    await ensureSqliteDbDir(env);
    await applySqliteMigrations({
        databasePath: resolveSqliteDatabaseFilePath(env.DATABASE_URL ?? "") || join(dataDir, "happier-server-light.sqlite"),
        migrationsDir: join(serverRoot, "prisma", "sqlite", "migrations"),
    });
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
