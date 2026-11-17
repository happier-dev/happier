import { pathToFileURL } from "node:url";
import { readFileSync, readdirSync } from "node:fs";

import { createDbMaintenanceClient } from "../sources/storage/db";
import {
    hasSessionSystemRecordContractMigration,
    runSessionSystemRecordFinalContractBackfill,
} from "../sources/app/session/systemRecords/sessionSystemRecordBackfillExecution";
import {
    runSessionSystemRecordMigrationDeployment,
} from "../sources/app/session/systemRecords/sessionSystemRecordMigrationDeployment";
import { resolveServerWorkspaceRoot } from "./prismaCli";
import { runPrismaMigrateCli } from "./prismaMigrateCli";
import { join } from "node:path";
import { runPluginCollectionUsageMigrationDeployment } from '../sources/app/plugins/data/collections/usageTotalsBackfill';

export const MYSQL_VOICE_GRANT_PROVENANCE_MIGRATION =
    "20260729102000_add_voice_conversation_grant_provenance";

const MYSQL_MIGRATION_APPROVAL_ENV = "HAPPIER_DB_MIGRATION_APPROVAL";

type MysqlTriggerExpectation = Readonly<{
    name: string;
    timing: "BEFORE" | "AFTER";
    event: "DELETE" | "INSERT" | "UPDATE";
    tableName: string;
}>;

type MysqlTriggerMigration = Readonly<{
    migrationName: string;
    requiredPrivileges: ReadonlyArray<Readonly<{ privilege: string; tableName: string }>>;
    triggers: ReadonlyArray<MysqlTriggerExpectation>;
}>;

function readMysqlTriggerMigrations(): ReadonlyArray<MysqlTriggerMigration> {
    const migrationsDir = join(resolveServerWorkspaceRoot(import.meta.url), "prisma", "mysql", "migrations");
    const migrations: MysqlTriggerMigration[] = [];
    const currentDefinitions = new Map<string, { migrationName: string; trigger: MysqlTriggerExpectation }>();
    for (const entry of readdirSync(migrationsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory() || !/^\d{14}_/u.test(entry.name)) continue;
        const sql = readFileSync(join(migrationsDir, entry.name, "migration.sql"), "utf8");
        const triggerTables = new Set<string>();
        for (const match of sql.matchAll(/^CREATE\s+TRIGGER\s+`([^`]+)`\s+(BEFORE|AFTER)\s+(INSERT|UPDATE|DELETE)\s+ON\s+`([^`]+)`|^DROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?`([^`]+)`/gimu)) {
            if (match[5]) {
                currentDefinitions.delete(match[5]);
                continue;
            }
            const trigger: MysqlTriggerExpectation = {
                name: match[1]!,
                // The SQL header expression restricts these values to the MySQL trigger vocabulary.
                timing: match[2]!.toUpperCase() as MysqlTriggerExpectation["timing"],
                event: match[3]!.toUpperCase() as MysqlTriggerExpectation["event"],
                tableName: match[4]!,
            };
            triggerTables.add(trigger.tableName);
            currentDefinitions.set(trigger.name, { migrationName: entry.name, trigger });
        }
        if (triggerTables.size === 0) continue;
        migrations.push({
            migrationName: entry.name,
            requiredPrivileges: [
                ...(entry.name === MYSQL_VOICE_GRANT_PROVENANCE_MIGRATION ? [
                    { privilege: "ALTER", tableName: "VoiceConversation" },
                    { privilege: "UPDATE", tableName: "VoiceConversation" },
                ] : []),
                ...Array.from(triggerTables, (tableName) => ({ privilege: "TRIGGER", tableName })),
            ],
            triggers: [],
        });
    }
    // Admission covers every CREATE, including temporary triggers; postflight checks final definitions.
    const currentTriggers = [...currentDefinitions.values()];
    return migrations.map((migration) => ({
        ...migration,
        triggers: currentTriggers
            .filter(({ migrationName }) => migrationName === migration.migrationName)
            .map(({ trigger }) => trigger),
    }));
}

export const MYSQL_TRIGGER_MIGRATIONS = readMysqlTriggerMigrations();

type QueryRows = ReadonlyArray<Record<string, unknown>>;

export interface MysqlMigrationAdmissionDatabase {
    query(sql: string, ...values: unknown[]): Promise<QueryRows>;
}

type MigrationState =
    | Readonly<{ status: "pending" }>
    | Readonly<{ status: "applied" }>
    | Readonly<{ status: "failed" }>;

type TriggerAuthority = Readonly<{
    currentUser: string;
    databaseName: string;
}>;

function readRowValue(row: Record<string, unknown>, key: string): unknown {
    if (Object.prototype.hasOwnProperty.call(row, key)) return row[key];
    const entry = Object.entries(row).find(([candidate]) => candidate.toLowerCase() === key.toLowerCase());
    return entry?.[1];
}

function requireNonEmptyString(value: unknown, label: string): string {
    if (typeof value !== "string" || value.trim() === "") {
        throw new Error(`[mysql-migration-admission] MySQL did not return ${label}.`);
    }
    return value.trim();
}

function isEnabled(value: unknown): boolean {
    if (typeof value === "bigint") return value !== 0n;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "boolean") return value;
    return ["1", "ON", "TRUE", "YES"].includes(String(value ?? "").trim().toUpperCase());
}

function readCount(value: unknown): number {
    if (typeof value === "bigint") return Number(value);
    if (typeof value === "number") return value;
    const parsed = Number.parseInt(String(value ?? ""), 10);
    return Number.isFinite(parsed) ? parsed : 0;
}

async function readMigrationStates(
    database: MysqlMigrationAdmissionDatabase,
    options: Readonly<{ ledgerExists?: boolean }> = {},
): Promise<ReadonlyMap<string, MigrationState>> {
    let ledgerExists = options.ledgerExists;
    if (ledgerExists === undefined) {
        const tableRows = await database.query(
            "SELECT COUNT(*) AS table_count FROM INFORMATION_SCHEMA.TABLES " +
            "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '_prisma_migrations'",
        );
        ledgerExists = readCount(readRowValue(tableRows[0] ?? {}, "table_count")) > 0;
    }
    if (!ledgerExists) {
        return new Map(MYSQL_TRIGGER_MIGRATIONS.map(({ migrationName }) => [
            migrationName,
            { status: "pending" } as const,
        ]));
    }

    const rows = await database.query(
        "SELECT migration_name, finished_at, rolled_back_at FROM `_prisma_migrations` " +
        `WHERE migration_name IN (${MYSQL_TRIGGER_MIGRATIONS.map(() => "?").join(", ")}) ` +
        "ORDER BY migration_name, started_at DESC",
        ...MYSQL_TRIGGER_MIGRATIONS.map(({ migrationName }) => migrationName),
    );
    const latestRows = new Map<string, Record<string, unknown>>();
    for (const row of rows) {
        const migrationName = readRowValue(row, "migration_name");
        if (typeof migrationName === "string" && !latestRows.has(migrationName)) {
            latestRows.set(migrationName, row);
        }
    }
    return new Map(MYSQL_TRIGGER_MIGRATIONS.map(({ migrationName }): [string, MigrationState] => {
        const row = latestRows.get(migrationName);
        if (!row || readRowValue(row, "rolled_back_at") != null) {
            return [migrationName, { status: "pending" } as const];
        }
        if (readRowValue(row, "finished_at") != null) {
            return [migrationName, { status: "applied" } as const];
        }
        return [migrationName, { status: "failed" } as const];
    }));
}

function assertOperatorApproval(env: NodeJS.ProcessEnv): void {
    const approval = String(env[MYSQL_MIGRATION_APPROVAL_ENV] ?? "").trim();
    if (approval === MYSQL_VOICE_GRANT_PROVENANCE_MIGRATION) return;
    throw new Error(
        `[mysql-migration-admission] ${MYSQL_VOICE_GRANT_PROVENANCE_MIGRATION} is pending. ` +
        "MySQL cannot atomically install its compatibility trigger with the preceding ALTER. " +
        "Keep every old API and worker writer stopped, complete the MySQL Voice rollout preflight, " +
        `then set ${MYSQL_MIGRATION_APPROVAL_ENV}=${MYSQL_VOICE_GRANT_PROVENANCE_MIGRATION} ` +
        "for this migration invocation. This exact value records operator admission; it does not detect or drain writers.",
    );
}

type ParsedGrant = Readonly<{
    privileges: ReadonlySet<string>;
    scope: string;
}>;

function normalizeGrantScope(scope: string): string {
    return scope
        .replace(/`((?:``|[^`])*)`/g, (_match: string, identifier: string) => identifier.replace(/``/g, "`"))
        .replace(/\s+/g, "")
        .toUpperCase();
}

function parseGrant(raw: string): ParsedGrant | null {
    const match = raw.match(/^GRANT\s+(.+?)\s+ON\s+(.+?)\s+TO\s+/i);
    if (!match) return null;
    return {
        privileges: new Set(
            match[1]
                .split(",")
                .map((value) => value.trim().toUpperCase())
                .filter(Boolean),
        ),
        scope: normalizeGrantScope(match[2]),
    };
}

function grantHasPrivilege(grant: ParsedGrant, privilege: string): boolean {
    return grant.privileges.has("ALL PRIVILEGES") || grant.privileges.has(privilege);
}

function grantCoversTarget(
    grant: ParsedGrant,
    databaseName: string,
    tableName: string,
): boolean {
    const normalizedDatabase = databaseName.toUpperCase();
    const normalizedTable = tableName.toUpperCase();
    return grant.scope === "*.*"
        || grant.scope === `${normalizedDatabase}.*`
        || grant.scope === `${normalizedDatabase}.${normalizedTable}`;
}

function hasPrivilege(
    grants: readonly ParsedGrant[],
    input: Readonly<{ privilege: string; databaseName: string; tableName: string }>,
): boolean {
    return grants.some(
        (grant) =>
            grantHasPrivilege(grant, input.privilege)
            && grantCoversTarget(grant, input.databaseName, input.tableName),
    );
}

function hasGlobalSuper(grants: readonly ParsedGrant[]): boolean {
    return grants.some(
        (grant) => grant.scope === "*.*" && grantHasPrivilege(grant, "SUPER"),
    );
}

async function verifyTriggerAuthority(
    database: MysqlMigrationAdmissionDatabase,
    pendingMigrations: readonly MysqlTriggerMigration[],
): Promise<TriggerAuthority> {
    const identityRows = await database.query(
        "SELECT DATABASE() AS database_name, CURRENT_USER() AS current_user_name, " +
        "@@GLOBAL.log_bin AS log_bin_value, " +
        "@@GLOBAL.log_bin_trust_function_creators AS trust_value",
    );
    const identity = identityRows[0] ?? {};
    const databaseName = requireNonEmptyString(
        readRowValue(identity, "database_name"),
        "the selected database name",
    );
    const currentUser = requireNonEmptyString(
        readRowValue(identity, "current_user_name"),
        "CURRENT_USER()",
    );
    const logBinEnabled = isEnabled(readRowValue(identity, "log_bin_value"));
    const trustFunctionCreators = isEnabled(readRowValue(identity, "trust_value"));

    const grantRows = await database.query("SHOW GRANTS FOR CURRENT_USER");
    const grants = grantRows
        .flatMap((row) => Object.values(row))
        .filter((value): value is string => typeof value === "string")
        .map(parseGrant)
        .filter((grant): grant is ParsedGrant => grant !== null);

    const requiredPrivileges = Array.from(new Map(
        pendingMigrations
            .flatMap(({ requiredPrivileges: privileges }) => privileges)
            .map((privilege) => [`${privilege.privilege}:${privilege.tableName}`, privilege]),
    ).values());
    const missing = requiredPrivileges
        .filter(({ privilege, tableName }) => !hasPrivilege(grants, {
            privilege,
            databaseName,
            tableName,
        }))
        .map(({ privilege, tableName }) => `${privilege} on ${tableName}`);
    if (missing.length > 0) {
        throw new Error(
            `[mysql-migration-admission] CURRENT_USER() ${currentUser} lacks provable ` +
            `${missing.join(", ")} authority required before installing pending MySQL triggers. ` +
            "Grant the authority directly or through " +
            "a schema/global grant visible to SHOW GRANTS, then rerun the preflight before Prisma.",
        );
    }

    if (logBinEnabled && !trustFunctionCreators && !hasGlobalSuper(grants)) {
        throw new Error(
            `[mysql-migration-admission] MySQL has binary logging enabled and ` +
            "log_bin_trust_function_creators=OFF, while CURRENT_USER() has no provable global SUPER authority. " +
            `CREATE TRIGGER can fail only after the preceding ALTER commits. Set ` +
            "log_bin_trust_function_creators=ON through the database operator, or use an identity whose " +
            "equivalent trigger-creation authority was proven against the same MySQL policy, before retrying.",
        );
    }

    return { currentUser, databaseName };
}

async function verifyTriggerPostflight(
    database: MysqlMigrationAdmissionDatabase,
    authority: TriggerAuthority,
    pendingMigrations: readonly MysqlTriggerMigration[],
): Promise<void> {
    const migrationStates = await readMigrationStates(database, { ledgerExists: true });
    const incompleteMigration = pendingMigrations.find(
        ({ migrationName }) => migrationStates.get(migrationName)?.status !== "applied",
    );
    if (incompleteMigration) {
        throw new Error(
            `[mysql-migration-admission] Prisma returned without a finished ` +
            `${incompleteMigration.migrationName} migration record.`,
        );
    }

    const expectedTriggers = pendingMigrations.flatMap(({ triggers }) => triggers);
    if (expectedTriggers.length === 0) return;
    const triggerRows = await database.query(
        "SELECT TRIGGER_NAME AS trigger_name, DEFINER AS definer, ACTION_TIMING AS action_timing, " +
        "EVENT_MANIPULATION AS event_manipulation, EVENT_OBJECT_TABLE AS event_object_table " +
        "FROM INFORMATION_SCHEMA.TRIGGERS WHERE TRIGGER_SCHEMA = ? " +
        `AND TRIGGER_NAME IN (${expectedTriggers.map(() => "?").join(", ")})`,
        authority.databaseName,
        ...expectedTriggers.map(({ name }) => name),
    );
    const actualTriggers = new Map(triggerRows.flatMap((row) => {
        const name = readRowValue(row, "trigger_name");
        return typeof name === "string" ? [[name, row] as const] : [];
    }));
    const invalidTrigger = expectedTriggers.find(({ name, timing, event, tableName }) => {
        const trigger = actualTriggers.get(name);
        return trigger === undefined
            || readRowValue(trigger, "definer") !== authority.currentUser
            || String(readRowValue(trigger, "action_timing") ?? "").toUpperCase() !== timing
            || String(readRowValue(trigger, "event_manipulation") ?? "").toUpperCase() !== event
            || readRowValue(trigger, "event_object_table") !== tableName;
    });
    if (invalidTrigger) {
        throw new Error(
            `[mysql-migration-admission] Prisma returned without the expected MySQL trigger ` +
            `${invalidTrigger.name} owned by CURRENT_USER() ${authority.currentUser}. ` +
            "Inspect INFORMATION_SCHEMA.TRIGGERS before starting the server.",
        );
    }
}

export async function runMysqlMigrationDeploy(input: Readonly<{
    database: MysqlMigrationAdmissionDatabase;
    env: NodeJS.ProcessEnv;
    deploy(): Promise<void>;
}>): Promise<void> {
    const states = await readMigrationStates(input.database);
    const failedMigration = MYSQL_TRIGGER_MIGRATIONS.find(
        ({ migrationName }) => states.get(migrationName)?.status === "failed",
    );
    if (failedMigration) {
        throw new Error(
            `[mysql-migration-admission] ${failedMigration.migrationName} has an unfinished failed ` +
            "Prisma record. Keep old writers stopped and use an approved provider-specific recovery procedure; " +
            "do not retry DDL or run prisma migrate resolve automatically.",
        );
    }
    const pendingMigrations = MYSQL_TRIGGER_MIGRATIONS.filter(
        ({ migrationName }) => states.get(migrationName)?.status === "pending",
    );
    if (pendingMigrations.length === 0) {
        await input.deploy();
        return;
    }

    if (pendingMigrations.some(({ migrationName }) => migrationName === MYSQL_VOICE_GRANT_PROVENANCE_MIGRATION)) {
        assertOperatorApproval(input.env);
    }
    const authority = await verifyTriggerAuthority(input.database, pendingMigrations);
    await input.deploy();
    await verifyTriggerPostflight(input.database, authority, pendingMigrations);
}

export async function runMysqlMigrationDeployMain(): Promise<void> {
    const env: NodeJS.ProcessEnv = { ...process.env };
    const serverRoot = resolveServerWorkspaceRoot(import.meta.url);
    const prisma = await createDbMaintenanceClient("mysql");
    const database: MysqlMigrationAdmissionDatabase = {
        query: (sql, ...values) => prisma.$queryRawUnsafe<QueryRows>(sql, ...values),
    };
    try {
        await runMysqlMigrationDeploy({
            database,
            env,
            deploy: async () => {
                await runSessionSystemRecordMigrationDeployment({
                    migrationsDir: join(serverRoot, "prisma", "mysql", "migrations"),
                    schemaPath: join(serverRoot, "prisma", "mysql", "schema.prisma"),
                    isContractApplied: async () => await hasSessionSystemRecordContractMigration({
                        provider: "mysql",
                        databaseUrl: String(env.DATABASE_URL ?? "").trim(),
                    }),
                    deploy: async (stage) => {
                        await runPluginCollectionUsageMigrationDeployment({ ...stage, provider: 'mysql', databaseUrl: String(env.DATABASE_URL ?? '').trim(), env,
                            deploy: async target => await runPrismaMigrateCli({ serverRoot, schemaPath: target.schemaPath!, args: ['deploy'], env }),
                        });
                    },
                    runFinalContractBackfill: async () => {
                        await runSessionSystemRecordFinalContractBackfill({
                            provider: "mysql",
                            databaseUrl: String(env.DATABASE_URL ?? "").trim(),
                        });
                    },
                });
            },
        });
    } finally {
        await prisma.$disconnect();
    }
}

const invokedAsMain =
    process.argv[1] !== undefined
    && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedAsMain) {
    void runMysqlMigrationDeployMain().catch((error: unknown) => {
        console.error(error);
        process.exit(1);
    });
}
