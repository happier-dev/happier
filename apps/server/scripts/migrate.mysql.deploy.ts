import { pathToFileURL } from "node:url";

import { createDbMaintenanceClient } from "../sources/storage/db";
import {
    hasSessionSystemRecordContractMigration,
    runSessionSystemRecordFinalContractBackfill,
} from "../sources/app/session/systemRecords/sessionSystemRecordBackfillExecution";
import {
    runSessionSystemRecordMigrationDeployment,
} from "../sources/app/session/systemRecords/sessionSystemRecordMigrationDeployment";
import { resolveServerWorkspaceRoot, runPrismaCli } from "./prismaCli";
import { join } from "node:path";
import { runPluginCollectionUsageMigrationDeployment } from '../sources/app/plugins/data/collections/usageTotalsBackfill';

export const MYSQL_VOICE_GRANT_PROVENANCE_MIGRATION =
    "20260729102000_add_voice_conversation_grant_provenance";

const MYSQL_VOICE_GRANT_PROVENANCE_TRIGGER =
    "VoiceSessionLease_preserve_conversation_grant";
const MYSQL_MIGRATION_APPROVAL_ENV = "HAPPIER_DB_MIGRATION_APPROVAL";

type MysqlTriggerExpectation = Readonly<{
    name: string;
    timing: "BEFORE";
    event: "DELETE" | "INSERT" | "UPDATE";
    tableName: string;
}>;

type MysqlTriggerMigration = Readonly<{
    migrationName: string;
    requiredPrivileges: ReadonlyArray<Readonly<{ privilege: string; tableName: string }>>;
    triggers: ReadonlyArray<MysqlTriggerExpectation>;
}>;

export const MYSQL_TRIGGER_MIGRATIONS: ReadonlyArray<MysqlTriggerMigration> = [
    {
        migrationName: MYSQL_VOICE_GRANT_PROVENANCE_MIGRATION,
        requiredPrivileges: [
            { privilege: "ALTER", tableName: "VoiceConversation" },
            { privilege: "UPDATE", tableName: "VoiceConversation" },
            { privilege: "TRIGGER", tableName: "VoiceSessionLease" },
        ],
        triggers: [{
            name: MYSQL_VOICE_GRANT_PROVENANCE_TRIGGER,
            timing: "BEFORE",
            event: "DELETE",
            tableName: "VoiceSessionLease",
        }],
    },
    {
        migrationName: "20260905230000_add_session_follow_edges",
        requiredPrivileges: [{ privilege: "TRIGGER", tableName: "SessionFollowEdge" }],
        triggers: [
            {
                name: "SessionFollowEdge_distinct_sessions_insert",
                timing: "BEFORE",
                event: "INSERT",
                tableName: "SessionFollowEdge",
            },
            {
                name: "SessionFollowEdge_distinct_sessions_update",
                timing: "BEFORE",
                event: "UPDATE",
                tableName: "SessionFollowEdge",
            },
        ],
    },
    {
        migrationName: "20260906210000_add_managed_identity_providers",
        requiredPrivileges: [{ privilege: "TRIGGER", tableName: "TeamProvisionedIdentity" }],
        triggers: [
            {
                name: "TeamProvisionedIdentity_membership_team_insert",
                timing: "BEFORE",
                event: "INSERT",
                tableName: "TeamProvisionedIdentity",
            },
            {
                name: "TeamProvisionedIdentity_membership_team_update",
                timing: "BEFORE",
                event: "UPDATE",
                tableName: "TeamProvisionedIdentity",
            },
        ],
    },
    {
        migrationName: "20260908120000_add_workflow_run_invocations",
        requiredPrivileges: [{ privilege: "TRIGGER", tableName: "AutomationRun" }],
        triggers: [
            {
                name: "AutomationRun_origin_kind_insert",
                timing: "BEFORE",
                event: "INSERT",
                tableName: "AutomationRun",
            },
            {
                name: "AutomationRun_origin_kind_update",
                timing: "BEFORE",
                event: "UPDATE",
                tableName: "AutomationRun",
            },
        ],
    },
    {
        migrationName: "20261002200000_stored_content_public_shares",
        requiredPrivileges: [{ privilege: "TRIGGER", tableName: "PublicSessionShare" }],
        triggers: [
            {
                name: "PublicSessionShare_subject_insert",
                timing: "BEFORE",
                event: "INSERT",
                tableName: "PublicSessionShare",
            },
            {
                name: "PublicSessionShare_subject_update",
                timing: "BEFORE",
                event: "UPDATE",
                tableName: "PublicSessionShare",
            },
        ],
    },
    {
        migrationName: "20261008143000_add_managed_machine_authority",
        requiredPrivileges: [{ privilege: "TRIGGER", tableName: "ManagedMachinePreset" }],
        triggers: [
            {
                name: "ManagedMachinePreset_owner_insert",
                timing: "BEFORE",
                event: "INSERT",
                tableName: "ManagedMachinePreset",
            },
            {
                name: "ManagedMachinePreset_owner_update",
                timing: "BEFORE",
                event: "UPDATE",
                tableName: "ManagedMachinePreset",
            },
        ],
    },
];

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
    return new Map(MYSQL_TRIGGER_MIGRATIONS.map(({ migrationName }) => {
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
                            deploy: async target => await runPrismaCli({ serverRoot, args: ['migrate', 'deploy', '--schema', target.schemaPath!], env }),
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
