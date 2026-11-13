import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../generated/mysql-client/index.js";

import {
    MYSQL_TRIGGER_MIGRATIONS,
    MYSQL_VOICE_GRANT_PROVENANCE_MIGRATION,
    runMysqlMigrationDeploy,
    runMysqlMigrationDeployMain,
    type MysqlMigrationAdmissionDatabase,
} from "./migrate.mysql.deploy";

type QueryResult = ReadonlyArray<Record<string, unknown>>;

function createDatabase(results: QueryResult[]): MysqlMigrationAdmissionDatabase & {
    query: ReturnType<typeof vi.fn>;
} {
    const query = vi.fn(async (_sql: string, ..._values: unknown[]) => {
        const next = results.shift();
        if (!next) throw new Error("Unexpected query");
        return next;
    });
    return { query };
}

function appliedMigrationRows(names = MYSQL_TRIGGER_MIGRATIONS.map(({ migrationName }) => migrationName)): QueryResult {
    return names.map((migrationName) => ({
        migration_name: migrationName,
        finished_at: new Date("2026-09-13T00:00:00.000Z"),
        rolled_back_at: null,
    }));
}

const pendingMigrationQueries: QueryResult[] = [[{ table_count: 1n }], []];

const capableIdentityQueries: QueryResult[] = [
    [{
        database_name: "happier",
        current_user_name: "migrator@%",
        log_bin_value: 1n,
        trust_value: 1n,
    }],
    [{
        "Grants for migrator@%":
            "GRANT SELECT, UPDATE, ALTER, TRIGGER ON `happier`.* TO `migrator`@`%`",
    }],
];

function triggerRows(names = MYSQL_TRIGGER_MIGRATIONS.flatMap(({ triggers }) => triggers)): QueryResult {
    return names.map(({ name, timing, event, tableName }) => ({
        trigger_name: name,
        definer: "migrator@%",
        action_timing: timing,
        event_manipulation: event,
        event_object_table: tableName,
    }));
}

describe("MySQL migration deploy admission", () => {
    it("prepares the native runtime before the command's first ledger query", async () => {
        vi.stubEnv("DATABASE_URL", "mysql://fixture:fixture@localhost/fixture?connection_limit=2");
        vi.stubEnv("HAPPIER_DB_CONNECTION_LIMIT", "3");
        vi.stubEnv("TOKIO_WORKER_THREADS", undefined);
        const limitsAtLoad: Array<string | undefined> = [];
        const dlopen = process.dlopen;
        const loader = vi.spyOn(process, "dlopen").mockImplementation((module, filename, flags) => {
            if (filename.includes("query_engine")) limitsAtLoad.push(process.env.TOKIO_WORKER_THREADS);
            return dlopen(module, filename, flags);
        });
        // Stop at the actual persistent-database boundary; keep entry composition and native construction real.
        const query = vi.spyOn(PrismaClient.prototype, "$queryRawUnsafe").mockRejectedValue(new Error("database-boundary-stop"));
        try {
            await expect(runMysqlMigrationDeployMain()).rejects.toThrow("database-boundary-stop");
            expect(limitsAtLoad.length).toBeGreaterThan(0);
            expect(new Set(limitsAtLoad)).toEqual(new Set(["3"]));
        } finally {
            query.mockRestore();
            loader.mockRestore();
            vi.unstubAllEnvs();
        }
    });

    it("catalogs every MySQL trigger migration with only its surviving trigger definitions", () => {
        const migrationsRoot = join(import.meta.dirname, "../prisma/mysql/migrations");
        const currentDefinitions = new Map<string, string>();
        const migrationTriggers = readdirSync(migrationsRoot, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .sort((a, b) => a.name.localeCompare(b.name))
            .flatMap((entry) => {
                const sql = readFileSync(join(migrationsRoot, entry.name, "migration.sql"), "utf8");
                for (const match of sql.matchAll(/\b(CREATE|DROP)\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?`([^`]+)`/giu)) {
                    if (match[1]!.toUpperCase() === "CREATE") currentDefinitions.set(match[2]!, entry.name);
                    else currentDefinitions.delete(match[2]!);
                }
                const triggers = Array.from(sql.matchAll(/CREATE\s+TRIGGER\s+`([^`]+)`/giu), (match) => match[1]!);
                return triggers.length > 0 ? [{ migrationName: entry.name, triggers: triggers.sort() }] : [];
            })
            .map(({ migrationName, triggers }) => ({
                migrationName,
                triggers: triggers.filter((name) => currentDefinitions.get(name) === migrationName),
            }));
        const catalogTriggers = MYSQL_TRIGGER_MIGRATIONS
            .map(({ migrationName, triggers }) => ({
                migrationName,
                triggers: triggers.map(({ name }) => name).sort(),
            }))
            .sort((a, b) => a.migrationName.localeCompare(b.migrationName));

        expect(catalogTriggers).toEqual(migrationTriggers);
    });

    it("skips trigger admission after every trigger migration is already applied", async () => {
        const database = createDatabase([[{ table_count: 1n }], appliedMigrationRows()]);
        const deploy = vi.fn(async () => {});

        await runMysqlMigrationDeploy({ database, env: {}, deploy });

        expect(deploy).toHaveBeenCalledOnce();
        expect(database.query).toHaveBeenCalledTimes(2);
    });

    it("requires trigger authority before deploying a pending generic Follow source migration", async () => {
        const pendingMigration = "20261024200000_execution_run_follow_machine_source";
        const database = createDatabase([
            [{ table_count: 1n }],
            appliedMigrationRows().filter((row) => row.migration_name !== pendingMigration),
            capableIdentityQueries[0]!,
            [{ "Grants for migrator@%": "GRANT SELECT ON `happier`.* TO `migrator`@`%`" }],
        ]);
        const deploy = vi.fn(async () => {});

        await expect(runMysqlMigrationDeploy({ database, env: {}, deploy }))
            .rejects.toThrow("TRIGGER on AccountSessionFollow");

        expect(deploy).not.toHaveBeenCalled();
    });

    it("preserves the one-time Voice operator admission when its migration is pending", async () => {
        const database = createDatabase([...pendingMigrationQueries]);
        const deploy = vi.fn(async () => {});

        await expect(runMysqlMigrationDeploy({ database, env: {}, deploy })).rejects.toThrow(
            `HAPPIER_DB_MIGRATION_APPROVAL=${MYSQL_VOICE_GRANT_PROVENANCE_MIGRATION}`,
        );

        expect(deploy).not.toHaveBeenCalled();
    });

    it("fails before Prisma when any trigger migration ledger record is unfinished", async () => {
        const laterMigration = MYSQL_TRIGGER_MIGRATIONS[1]!.migrationName;
        const database = createDatabase([
            [{ table_count: 1n }],
            [
                ...appliedMigrationRows([MYSQL_VOICE_GRANT_PROVENANCE_MIGRATION]),
                { migration_name: laterMigration, finished_at: null, rolled_back_at: null },
            ],
        ]);
        const deploy = vi.fn(async () => {});

        await expect(runMysqlMigrationDeploy({ database, env: {}, deploy }))
            .rejects.toThrow(`${laterMigration} has an unfinished failed Prisma record`);

        expect(deploy).not.toHaveBeenCalled();
    });

    it("fails before Prisma when binary logging rejects schema-scoped trigger authority", async () => {
        const database = createDatabase([
            ...pendingMigrationQueries,
            [{
                database_name: "happier",
                current_user_name: "migrator@%",
                log_bin_value: 1n,
                trust_value: 0n,
            }],
            [{
                "Grants for migrator@%":
                    "GRANT SELECT, UPDATE, ALTER, TRIGGER ON `happier`.* TO `migrator`@`%`",
            }],
        ]);
        const deploy = vi.fn(async () => {});

        await expect(runMysqlMigrationDeploy({
            database,
            env: { HAPPIER_DB_MIGRATION_APPROVAL: MYSQL_VOICE_GRANT_PROVENANCE_MIGRATION },
            deploy,
        })).rejects.toThrow("log_bin_trust_function_creators");

        expect(deploy).not.toHaveBeenCalled();
    });

    it("accepts provable global SUPER authority when trusted creators are disabled", async () => {
        const database = createDatabase([
            ...pendingMigrationQueries,
            [{
                database_name: "happier",
                current_user_name: "root@%",
                log_bin_value: 1n,
                trust_value: 0n,
            }],
            [{ "Grants for root@%": "GRANT ALL PRIVILEGES ON *.* TO `root`@`%` WITH GRANT OPTION" }],
            appliedMigrationRows(),
            triggerRows().map((row) => ({ ...row, definer: "root@%" })),
        ]);
        const deploy = vi.fn(async () => {});

        await runMysqlMigrationDeploy({
            database,
            env: { HAPPIER_DB_MIGRATION_APPROVAL: MYSQL_VOICE_GRANT_PROVENANCE_MIGRATION },
            deploy,
        });

        expect(deploy).toHaveBeenCalledOnce();
    });

    it("checks table-scoped TRIGGER authority for every pending trigger migration", async () => {
        const database = createDatabase([
            [{ table_count: 1n }],
            appliedMigrationRows([MYSQL_VOICE_GRANT_PROVENANCE_MIGRATION]),
            [{
                database_name: "happier",
                current_user_name: "migrator@%",
                log_bin_value: 0n,
                trust_value: 0n,
            }],
            [{
                "Grants for migrator@%":
                    "GRANT TRIGGER ON `happier`.`VoiceSessionLease` TO `migrator`@`%`",
            }],
        ]);
        const deploy = vi.fn(async () => {});

        await expect(runMysqlMigrationDeploy({ database, env: {}, deploy }))
            .rejects.toThrow("TRIGGER on SessionFollowEdge");

        expect(deploy).not.toHaveBeenCalled();
    });

    it("still checks Voice UPDATE authority when the Voice trigger migration is pending", async () => {
        const database = createDatabase([
            ...pendingMigrationQueries,
            [{
                database_name: "happier",
                current_user_name: "migrator@%",
                log_bin_value: 0n,
                trust_value: 0n,
            }],
            [{
                "Grants for migrator@%":
                    "GRANT SELECT, ALTER, TRIGGER ON `happier`.* TO `migrator`@`%`",
            }],
        ]);
        const deploy = vi.fn(async () => {});

        await expect(runMysqlMigrationDeploy({
            database,
            env: { HAPPIER_DB_MIGRATION_APPROVAL: MYSQL_VOICE_GRANT_PROVENANCE_MIGRATION },
            deploy,
        })).rejects.toThrow("UPDATE on VoiceConversation");

        expect(deploy).not.toHaveBeenCalled();
    });

    it("admits later trigger migrations without inventing another operator approval", async () => {
        const laterMigrations = MYSQL_TRIGGER_MIGRATIONS.slice(1);
        const database = createDatabase([
            [{ table_count: 1n }],
            appliedMigrationRows([MYSQL_VOICE_GRANT_PROVENANCE_MIGRATION]),
            ...capableIdentityQueries,
            appliedMigrationRows(),
            triggerRows(laterMigrations.flatMap(({ triggers }) => triggers)),
        ]);
        const deploy = vi.fn(async () => {});

        await runMysqlMigrationDeploy({ database, env: {}, deploy });

        expect(deploy).toHaveBeenCalledOnce();
        expect(database.query).toHaveBeenCalledTimes(6);
    });

    it("settles a pending historical migration whose temporary triggers have been replaced", async () => {
        const historicalMigration = "20261018213000_merge_manager_follow_relation";
        const database = createDatabase([
            [{ table_count: 1n }],
            appliedMigrationRows().filter((row) => row.migration_name !== historicalMigration),
            ...capableIdentityQueries,
            appliedMigrationRows(),
        ]);
        const query = database.query.getMockImplementation()!;
        database.query.mockImplementation(async (sql: string) => {
            // MySQL rejects an empty IN list at the persistent-database boundary.
            if (/\bIN\s*\(\s*\)/u.test(sql)) throw new Error("MySQL syntax error: empty IN list");
            return query(sql);
        });
        const deploy = vi.fn(async () => {});

        await expect(runMysqlMigrationDeploy({ database, env: {}, deploy })).resolves.toBeUndefined();

        expect(deploy).toHaveBeenCalledOnce();
    });

    it("deploys only after admission and verifies every pending migration and trigger", async () => {
        const database = createDatabase([
            ...pendingMigrationQueries,
            ...capableIdentityQueries,
            appliedMigrationRows(),
            triggerRows(),
        ]);
        const deploy = vi.fn(async () => {});

        await runMysqlMigrationDeploy({
            database,
            env: { HAPPIER_DB_MIGRATION_APPROVAL: MYSQL_VOICE_GRANT_PROVENANCE_MIGRATION },
            deploy,
        });

        expect(deploy).toHaveBeenCalledOnce();
        expect(database.query).toHaveBeenCalledTimes(6);
    });

    it("fails closed when Prisma returns without any expected later trigger", async () => {
        const laterMigrations = MYSQL_TRIGGER_MIGRATIONS.slice(1);
        const expectedTriggers = laterMigrations.flatMap(({ triggers }) => triggers);
        const missingTrigger = expectedTriggers.at(-1)!;
        const database = createDatabase([
            [{ table_count: 1n }],
            appliedMigrationRows([MYSQL_VOICE_GRANT_PROVENANCE_MIGRATION]),
            ...capableIdentityQueries,
            appliedMigrationRows(),
            triggerRows(expectedTriggers.slice(0, -1)),
        ]);
        const deploy = vi.fn(async () => {});

        await expect(runMysqlMigrationDeploy({ database, env: {}, deploy }))
            .rejects.toThrow(missingTrigger.name);

        expect(deploy).toHaveBeenCalledOnce();
    });
});
