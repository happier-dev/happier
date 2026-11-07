import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderPrismaCompatibleSqliteDatabaseUrl } from "@happier-dev/cli-common/firstPartyRuntime/server";
import { resolveServerScriptCommandInvocation } from "../../scripts/runCommand";
import {
    createServerLightTemplateCacheKey,
    prepareCachedDataDir,
    resolveServerLightTemplateCacheRoot,
} from "../../../../packages/tests/src/testkit/process/serverLightTemplateCache.mjs";
import { resolveSqliteMigrationsDir } from "@/flavors/light/sqliteMigrations";

import { applyLightDefaultEnv, ensureHandyMasterSecret } from "@/flavors/light/env";
import { initEncrypt } from "@/modules/encrypt";
import { initFilesLocalFromEnv, loadFiles } from "@/storage/blob/files";
import { db, initDbSqlite, shutdownDbClient } from "@/storage/db";
import { applyEnvValues, restoreEnv as restoreSnapshotEnv, snapshotEnv, type EnvValues } from "./env";

/** Cross-program fixtures mint genuine tokens without compiling server auth in the caller. */
export async function createAccountTokenForTests(accountId: string, options: Readonly<{
    kind: 'account' | 'terminal';
    authority: 'present_user' | 'account_automation';
}>): Promise<string> {
    const authSource = '@/app/auth/auth';
    // The loaded server module is the real token issuer at this testkit boundary.
    const { vi } = await import('vitest');
    const { auth } = await vi.importActual<{ auth: {
        createToken(accountId: string, extras: undefined, provenance: typeof options): Promise<string>;
    } }>(authSource);
    return auth.createToken(accountId, undefined, options);
}

export type LightSqliteHarness = {
    readonly baseDir: string;
    readonly dbPath: string;
    readonly envBase: NodeJS.ProcessEnv;
    restoreEnv: () => void;
    resetEnv: (overrides?: EnvValues) => NodeJS.ProcessEnv;
    resetDbTables: (fns: Array<() => Promise<unknown>>) => Promise<void>;
    close: () => Promise<void>;
};

export type LightSqliteSetupPhase =
    | 'sqlite_storage_prepare_started'
    | 'sqlite_storage_prepare_returned'
    | 'sqlite_migration_started'
    | 'sqlite_migration_returned'
    | 'sqlite_prisma_init_started'
    | 'sqlite_prisma_init_returned'
    | 'sqlite_prisma_connect_started'
    | 'sqlite_prisma_connect_returned'
    | 'sqlite_auth_init_started'
    | 'sqlite_auth_init_returned';

export type LightSqliteHarnessOptions = Readonly<{
    observeSetup?: (phase: LightSqliteSetupPhase) => void;
    tempDirPrefix: string;
    tempDirBase?: string;
    sqliteConnectionLimit?: number;
    initAuth?: boolean;
    initEncrypt?: boolean;
    initFiles?: boolean;
    env?: EnvValues;
}>;

function runSqliteMigrations(params: { cwd: string; env: NodeJS.ProcessEnv;
    observeSetup?: LightSqliteHarnessOptions['observeSetup'];
}): void {
    const invocation = resolveServerScriptCommandInvocation("pnpm", ["--silent", "run", "migrate:sqlite:deploy"], params.env);
    params.observeSetup?.('sqlite_migration_started');
    const res = spawnSync(
        invocation.command,
        invocation.args,
        {
            cwd: params.cwd,
            env: { ...(params.env as Record<string, string>), RUST_LOG: "info" },
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
        },
    );
    params.observeSetup?.('sqlite_migration_returned');
    if (res.status !== 0) {
        const spawnErr = res.error ? ` Spawn error: ${res.error.message}.` : "";
        const out = `${res.stdout ?? ""}\n${res.stderr ?? ""}`.trim();
        throw new Error(`sqlite migration deploy failed (status=${res.status}).${spawnErr} ${out}`.trim());
    }
}

export async function createLightSqliteHarness(options: LightSqliteHarnessOptions): Promise<LightSqliteHarness> {
    const envBackup = snapshotEnv();
    const tempDirBase = typeof options.tempDirBase === "string" && options.tempDirBase.trim().length > 0
        ? options.tempDirBase
        : tmpdir();
    const baseDir = await mkdtemp(join(tempDirBase, options.tempDirPrefix));
    const dbPath = join(baseDir, "happier-server-light.sqlite");
    try {
        applyEnvValues({
            HAPPIER_DB_PROVIDER: "sqlite",
            HAPPY_DB_PROVIDER: "sqlite",
            DATABASE_URL: renderPrismaCompatibleSqliteDatabaseUrl({
                dbPath,
                platform: process.platform,
                ...(options.sqliteConnectionLimit !== undefined
                    ? { sqlite: { connectionLimit: options.sqliteConnectionLimit } }
                    : {}),
            }),
            HAPPY_SERVER_LIGHT_DATA_DIR: baseDir,
            HAPPIER_SERVER_LIGHT_DATA_DIR: baseDir,
            ...options.env,
        });
        applyLightDefaultEnv(process.env);
        await ensureHandyMasterSecret(process.env);
        const envBase = snapshotEnv();

        options.observeSetup?.('sqlite_storage_prepare_started');
        const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
        const templateKey = await createServerLightTemplateCacheKey({
            rootDir: resolve(serverRoot, '../..'),
            provider: 'sqlite',
            migrationsDir: resolveSqliteMigrationsDir(envBase, '') || undefined,
        });
        await prepareCachedDataDir({
            cacheRootDir: resolveServerLightTemplateCacheRoot(resolve(serverRoot, '../..')),
            templateKey,
            targetDir: baseDir,
            buildTemplateInto: async (templateDataDir) => {
                runSqliteMigrations({
                    cwd: serverRoot,
                    observeSetup: options.observeSetup,
                    env: {
                        ...envBase,
                        HAPPIER_SERVER_LIGHT_DATA_DIR: templateDataDir,
                        HAPPY_SERVER_LIGHT_DATA_DIR: templateDataDir,
                        DATABASE_URL: renderPrismaCompatibleSqliteDatabaseUrl({
                            dbPath: join(templateDataDir, 'happier-server-light.sqlite'),
                            platform: process.platform,
                        }),
                    },
                });
            },
        });
        options.observeSetup?.('sqlite_storage_prepare_returned');
        options.observeSetup?.('sqlite_prisma_init_started');
        await initDbSqlite();
        options.observeSetup?.('sqlite_prisma_init_returned');
        options.observeSetup?.('sqlite_prisma_connect_started');
        await db.$connect();
        options.observeSetup?.('sqlite_prisma_connect_returned');

        if (options.initAuth) {
            options.observeSetup?.('sqlite_auth_init_started');
            const { auth } = await import("@/app/auth/auth");
            await auth.init();
            options.observeSetup?.('sqlite_auth_init_returned');
        }
        if (options.initEncrypt) {
            await initEncrypt();
        }
        if (options.initFiles) {
            initFilesLocalFromEnv(process.env);
            await loadFiles();
        }

        const restoreEnv = () => {
            restoreSnapshotEnv(envBase);
        };

        const resetEnv = (overrides: EnvValues = {}) => {
            restoreEnv();
            applyEnvValues(overrides);
            return snapshotEnv();
        };

        const resetDbTables = async (fns: Array<() => Promise<unknown>>) => {
            for (const fn of fns) {
                await fn().catch(() => {});
            }
        };

        const close = async () => {
            await shutdownDbClient();
            restoreSnapshotEnv(envBackup);
            await rm(baseDir, { recursive: true, force: true });
        };

        return { baseDir, dbPath, envBase, restoreEnv, resetEnv, resetDbTables, close };
    } catch (error) {
        try {
            await shutdownDbClient();
        } catch {
            // ignore cleanup disconnect errors
        }
        restoreSnapshotEnv(envBackup);
        try {
            await rm(baseDir, { recursive: true, force: true });
        } catch {
            // ignore cleanup delete errors
        }
        throw error;
    }
}
