import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { applyLightDefaultEnv } from "@/flavors/light/env";
import { requireLightDataDir } from "./migrate.light.deployPlan";

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, {
            env: env as Record<string, string>,
            stdio: "inherit",
            shell: false,
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
    env.DATABASE_URL = `file:${join(dataDir, "happier-server-light.sqlite")}`;
}

async function ensureSqliteDbDir(env: NodeJS.ProcessEnv): Promise<void> {
    const url = env.DATABASE_URL?.trim() ?? "";
    if (!url.startsWith("file:")) return;
    const filePath = url.slice("file:".length);
    if (!filePath) return;
    await mkdir(dirname(filePath), { recursive: true });
}

export async function runSqliteMigrateDeploy(env: NodeJS.ProcessEnv = process.env): Promise<void> {
    const nextEnv: NodeJS.ProcessEnv = { ...env };
    applyLightDefaultEnv(nextEnv);

    const dataDir = requireLightDataDir(nextEnv);
    await mkdir(dataDir, { recursive: true });

    await run("yarn", ["-s", "schema:sync", "--quiet"], nextEnv);

    ensureSqliteDatabaseUrl(nextEnv);
    await ensureSqliteDbDir(nextEnv);
    // Work around a Prisma CLI behavior where SQLite migrate errors can surface as a blank
    // "Schema engine error:" on some Node/engine combinations. Enabling Rust logging restores
    // normal output and behavior.
    await run("yarn", ["-s", "prisma", "migrate", "deploy", "--schema", "prisma/sqlite/schema.prisma"], {
        ...nextEnv,
        RUST_LOG: "info",
    });
}

export async function main(): Promise<void> {
    await runSqliteMigrateDeploy(process.env);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    void main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
