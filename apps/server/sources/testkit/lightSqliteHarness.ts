import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyLightDefaultEnv, ensureHandyMasterSecret } from "@/flavors/light/env";
import { auth } from "@/app/auth/auth";
import { initEncrypt } from "@/modules/encrypt";
import { initFilesLocalFromEnv, loadFiles } from "@/storage/blob/files";
import { db, initDbSqlite } from "@/storage/db";

export type LightSqliteHarness = {
    readonly baseDir: string;
    readonly dbPath: string;
    readonly envBase: NodeJS.ProcessEnv;
    restoreEnv: () => void;
    resetDbTables: (fns: Array<() => Promise<unknown>>) => Promise<void>;
    close: () => Promise<void>;
};

export type LightSqliteHarnessOptions = Readonly<{
    tempDirPrefix: string;
    tempDirBase?: string;
    initAuth?: boolean;
    initEncrypt?: boolean;
    initFiles?: boolean;
}>;

function restoreEnvFromSnapshot(snapshot: NodeJS.ProcessEnv): void {
    for (const key of Object.keys(process.env)) {
        if (!(key in snapshot)) {
            delete (process.env as any)[key];
        }
    }
    for (const [key, value] of Object.entries(snapshot)) {
        if (typeof value === "string") {
            process.env[key] = value;
        }
    }
}

function runSqliteMigrations(params: { cwd: string; env: NodeJS.ProcessEnv }): void {
    const res = spawnSync(
        "yarn",
        ["-s", "prisma", "migrate", "deploy", "--schema", "prisma/sqlite/schema.prisma"],
        {
            cwd: params.cwd,
            env: { ...(params.env as Record<string, string>), RUST_LOG: "info" },
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        },
    );
    if (res.status !== 0) {
        const spawnErr = res.error ? ` Spawn error: ${res.error.message}.` : "";
        const out = `${res.stdout ?? ""}\n${res.stderr ?? ""}`.trim();
        throw new Error(`prisma migrate deploy failed (status=${res.status}).${spawnErr} ${out}`.trim());
    }
}

export async function createLightSqliteHarness(options: LightSqliteHarnessOptions): Promise<LightSqliteHarness> {
    const envBackup = { ...process.env };
    const tempDirBase = typeof options.tempDirBase === "string" && options.tempDirBase.trim().length > 0
        ? options.tempDirBase
        : tmpdir();
    const baseDir = await mkdtemp(join(tempDirBase, options.tempDirPrefix));
    const dbPath = join(baseDir, "test.sqlite");
    try {
        process.env.HAPPIER_DB_PROVIDER = "sqlite";
        process.env.HAPPY_DB_PROVIDER = "sqlite";
        process.env.DATABASE_URL = `file:${dbPath}`;
        process.env.HAPPY_SERVER_LIGHT_DATA_DIR = baseDir;
        process.env.HAPPIER_SERVER_LIGHT_DATA_DIR = baseDir;
        applyLightDefaultEnv(process.env);
        await ensureHandyMasterSecret(process.env);
        const envBase = { ...process.env };

        runSqliteMigrations({ cwd: process.cwd(), env: process.env });
        await initDbSqlite();
        await db.$connect();

        if (options.initAuth) {
            await auth.init();
        }
        if (options.initEncrypt) {
            await initEncrypt();
        }
        if (options.initFiles) {
            initFilesLocalFromEnv(process.env);
            await loadFiles();
        }

        const restoreEnv = () => {
            restoreEnvFromSnapshot(envBase);
        };

        const resetDbTables = async (fns: Array<() => Promise<unknown>>) => {
            for (const fn of fns) {
                await fn().catch(() => {});
            }
        };

        const close = async () => {
            await db.$disconnect();
            restoreEnvFromSnapshot(envBackup);
            await rm(baseDir, { recursive: true, force: true });
        };

        return { baseDir, dbPath, envBase, restoreEnv, resetDbTables, close };
    } catch (error) {
        try {
            await db.$disconnect();
        } catch {
            // ignore cleanup disconnect errors
        }
        restoreEnvFromSnapshot(envBackup);
        try {
            await rm(baseDir, { recursive: true, force: true });
        } catch {
            // ignore cleanup delete errors
        }
        throw error;
    }
}
