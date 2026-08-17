import { describe, expect, it, vi } from "vitest";

import {
    MYSQL_VOICE_GRANT_PROVENANCE_MIGRATION,
    runMysqlMigrationDeploy,
    type MysqlMigrationAdmissionDatabase,
} from "./migrate.mysql.deploy";

type QueryResult = ReadonlyArray<Record<string, unknown>>;

function createDatabase(results: QueryResult[]): MysqlMigrationAdmissionDatabase & {
    query: ReturnType<typeof vi.fn>;
} {
    const query = vi.fn(async () => {
        const next = results.shift();
        if (!next) throw new Error("Unexpected query");
        return next;
    });
    return {
        query,
        disconnect: vi.fn(async () => {}),
    };
}

const pendingMigrationQueries: QueryResult[] = [
    [{ table_count: 1n }],
    [],
];

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

const successfulPostflightQueries: QueryResult[] = [
    [{ finished_at: new Date("2026-07-30T00:00:00.000Z"), rolled_back_at: null }],
    [{
        definer: "migrator@%",
        action_timing: "BEFORE",
        event_manipulation: "DELETE",
        event_object_table: "VoiceSessionLease",
    }],
];

describe("MySQL migration deploy admission", () => {
    it("skips the one-time admission after the migration is already applied", async () => {
        const database = createDatabase([
            [{ table_count: 1n }],
            [{ finished_at: new Date("2026-07-30T00:00:00.000Z"), rolled_back_at: null }],
        ]);
        const deploy = vi.fn(async () => {});

        await runMysqlMigrationDeploy({
            database,
            env: {},
            deploy,
        });

        expect(deploy).toHaveBeenCalledOnce();
        expect(database.query).toHaveBeenCalledTimes(2);
    });

    it("fails before Prisma when the pending migration lacks exact maintenance approval", async () => {
        const database = createDatabase([...pendingMigrationQueries]);
        const deploy = vi.fn(async () => {});

        await expect(runMysqlMigrationDeploy({
            database,
            env: {},
            deploy,
        })).rejects.toThrow(
            `HAPPIER_DB_MIGRATION_APPROVAL=${MYSQL_VOICE_GRANT_PROVENANCE_MIGRATION}`,
        );

        expect(deploy).not.toHaveBeenCalled();
    });

    it("fails before Prisma when the migration ledger contains an unfinished attempt", async () => {
        const database = createDatabase([
            [{ table_count: 1n }],
            [{ finished_at: null, rolled_back_at: null }],
        ]);
        const deploy = vi.fn(async () => {});

        await expect(runMysqlMigrationDeploy({
            database,
            env: {
                HAPPIER_DB_MIGRATION_APPROVAL: MYSQL_VOICE_GRANT_PROVENANCE_MIGRATION,
            },
            deploy,
        })).rejects.toThrow("approved provider-specific recovery procedure");

        expect(deploy).not.toHaveBeenCalled();
    });

    it("fails before Prisma when binary logging rejects the schema-scoped trigger grant", async () => {
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
            env: {
                HAPPIER_DB_MIGRATION_APPROVAL: MYSQL_VOICE_GRANT_PROVENANCE_MIGRATION,
            },
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
            [{
                "Grants for root@%":
                    "GRANT ALL PRIVILEGES ON *.* TO `root`@`%` WITH GRANT OPTION",
            }],
            [{ finished_at: new Date("2026-07-30T00:00:00.000Z"), rolled_back_at: null }],
            [{
                definer: "root@%",
                action_timing: "BEFORE",
                event_manipulation: "DELETE",
                event_object_table: "VoiceSessionLease",
            }],
        ]);
        const deploy = vi.fn(async () => {});

        await runMysqlMigrationDeploy({
            database,
            env: {
                HAPPIER_DB_MIGRATION_APPROVAL: MYSQL_VOICE_GRANT_PROVENANCE_MIGRATION,
            },
            deploy,
        });

        expect(deploy).toHaveBeenCalledOnce();
    });

    it("fails before Prisma when the trigger definer lacks UPDATE authority", async () => {
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
            env: {
                HAPPIER_DB_MIGRATION_APPROVAL: MYSQL_VOICE_GRANT_PROVENANCE_MIGRATION,
            },
            deploy,
        })).rejects.toThrow("UPDATE");

        expect(deploy).not.toHaveBeenCalled();
    });

    it("deploys only after admission and verifies the migration and trigger definer", async () => {
        const database = createDatabase([
            ...pendingMigrationQueries,
            ...capableIdentityQueries,
            ...successfulPostflightQueries,
        ]);
        const deploy = vi.fn(async () => {});

        await runMysqlMigrationDeploy({
            database,
            env: {
                HAPPIER_DB_MIGRATION_APPROVAL: MYSQL_VOICE_GRANT_PROVENANCE_MIGRATION,
            },
            deploy,
        });

        expect(deploy).toHaveBeenCalledOnce();
        expect(database.query).toHaveBeenCalledTimes(6);
    });

    it("fails closed when Prisma returns without the expected trigger", async () => {
        const database = createDatabase([
            ...pendingMigrationQueries,
            ...capableIdentityQueries,
            [{ finished_at: new Date("2026-07-30T00:00:00.000Z"), rolled_back_at: null }],
            [],
        ]);
        const deploy = vi.fn(async () => {});

        await expect(runMysqlMigrationDeploy({
            database,
            env: {
                HAPPIER_DB_MIGRATION_APPROVAL: MYSQL_VOICE_GRANT_PROVENANCE_MIGRATION,
            },
            deploy,
        })).rejects.toThrow("expected compatibility trigger");

        expect(deploy).toHaveBeenCalledOnce();
    });
});
