import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { applyLightDefaultEnv, resolveLightSqliteDatabaseUrl } from "../sources/flavors/light/env";
import { resolveSqliteDatabaseFilePath } from "../sources/flavors/light/sqliteMigrations";
import { requireLightDataDir } from "./migrate.light.deployPlan";
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

async function main() {
    const env: NodeJS.ProcessEnv = { ...process.env };
    applyLightDefaultEnv(env);

    const dataDir = requireLightDataDir(env);
    await mkdir(dataDir, { recursive: true });

    await runCommand("yarn", ["-s", "schema:sync", "--quiet"], env);

    ensureSqliteDatabaseUrl(env);
    await ensureSqliteDbDir(env);
    // Work around a Prisma CLI behavior where SQLite migrate errors can surface as a blank
    // "Schema engine error:" on some Node/engine combinations. Enabling Rust logging restores
    // normal output and behavior.
    await runCommand("yarn", ["-s", "prisma", "migrate", "deploy", "--schema", "prisma/sqlite/schema.prisma"], {
        ...env,
        RUST_LOG: "info",
    });
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
