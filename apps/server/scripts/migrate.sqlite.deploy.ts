import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
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

async function main() {
    const env: NodeJS.ProcessEnv = { ...process.env };
    applyLightDefaultEnv(env);

    const dataDir = requireLightDataDir(env);
    await mkdir(dataDir, { recursive: true });

    await run("yarn", ["-s", "schema:sync", "--quiet"], env);

    ensureSqliteDatabaseUrl(env);
    await ensureSqliteDbDir(env);
    await run("yarn", ["-s", "prisma", "migrate", "deploy", "--schema", "prisma/sqlite/schema.prisma"], env);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});

