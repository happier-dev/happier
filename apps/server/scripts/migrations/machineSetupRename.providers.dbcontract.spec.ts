import { createHash, randomUUID } from "node:crypto";
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { PrismaClient as PostgresPrismaClient } from "@prisma/client";
import { ManagedMachineSetupV1Schema } from "@happier-dev/protocol/machines/managed/managedMachineV1";
import { createStoredReadSchema } from "@happier-dev/protocol/json/storedReadSchema";
import { describe, expect, it } from "vitest";

import type { PrismaClient as MysqlPrismaClient } from "../../generated/mysql-client/index.js";
import { runPrismaMigrateCli } from "../prismaMigrateCli";
import { applySqliteMigrations } from "../prismaMigrations";
import { readPostgresSemanticSchema } from './postgresSchema.testkit';
import { createDbMaintenanceClient } from "../../sources/storage/prisma";

type Provider = "postgres" | "mysql" | "sqlite";
type Row = Record<string, unknown>;
type Database = Readonly<{
    execute: (sql: string) => Promise<unknown>;
    query: (sql: string) => Promise<Row[]>;
}>;

const serverRoot = join(import.meta.dirname, "../..");
const originalMigration = "20261009160000_add_machine_preset_environment";
const renameMigration = "20261026172000_rename_machine_setup_columns";
// Pre-cut writer contract: managedAcquire.ts's admitted preset snapshot and
// machineEnvironment.ts's failed-operation report, inspected before the rename.
const oldDefinition = {
    setupScript: "printf '%s\\n' 'setup retained'",
    toolchain: { adapterId: "mise", config: '[tools]\nnode = "22"\n' },
};
const { setupScript: retainedScript, ...retainedSetupFields } = oldDefinition;
const projectedDefinition = { ...retainedSetupFields, scripts: [{ body: retainedScript }] };
const setupReadSchema = createStoredReadSchema(ManagedMachineSetupV1Schema);
const oldSetup = {
    environment: oldDefinition,
    state: "failed",
    operation: { operationId: "setup-operation" },
    errorCode: "setup_failed",
};
// Captured pre-cut schema/writer basis: managedConfigurationV1.ts and
// managedAcquire.ts at HEAD, before this lane's vocabulary changes.
const retainedLaunch = { provider: { pluginId: "fixture.machine-test", localId: "compute" }, schemaVersion: 1, name: "Retained", choices: {} };
const oldReviewedFacts = {
    launch: retainedLaunch, controller: { machineId: "controller", installationId: "installation" },
    optionStatus: "current", prerequisites: [], billing: { location: "local", stoppedBilling: "not-billed" },
    retentionCapabilities: { supportedIntents: ["start", "stop", "delete"] },
    retention: { kind: "until-delete" }, wakeOnAcceptedMessage: false, environment: oldDefinition,
    preset: { id: "setup-preset", revision: 0 },
};
const oldComputeInput = {
    selection: { kind: "preset", homeId: "home", id: "setup-preset", revision: 0 },
    controller: oldReviewedFacts.controller, retention: oldReviewedFacts.retention,
    wakeOnAcceptedMessage: false, reviewedFacts: oldReviewedFacts,
};
const oldAdmission = {
    computeInput: oldComputeInput, continuation: null,
    environmentSetup: { requestEnvelopeDigest: "retained-setup-envelope" },
};
const { environment: retainedDefinition, ...retainedFacts } = oldReviewedFacts;
const currentReviewedFacts = { ...retainedFacts, setup: retainedDefinition };
const currentAdmission = {
    computeInput: { ...oldComputeInput, reviewedFacts: currentReviewedFacts }, continuation: null,
    machineSetup: oldAdmission.environmentSetup,
};
const controls = [
    { id: "absent", value: { state: "pending", unknown: [true, null, { nested: "retained" }] } },
    { id: "json-null", value: { environment: null, state: "skipped", unknown: false } },
    { id: "unknown", value: { ...oldSetup, unknown: { array: [true, false, null, { number: 3 }] } } },
] as const;

function providerRoot(provider: Provider): string {
    return join(serverRoot, "prisma", ...(provider === "postgres" ? [] : [provider]));
}

async function migrationNames(provider: Provider): Promise<string[]> {
    return (await readdir(join(providerRoot(provider), "migrations"), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

async function stageMigrations(provider: Provider, stage: string, names: readonly string[]): Promise<void> {
    await mkdir(join(stage, "migrations"), { recursive: true });
    await copyFile(join(providerRoot(provider), "schema.prisma"), join(stage, "schema.prisma"));
    await copyFile(join(providerRoot(provider), "migrations/migration_lock.toml"), join(stage, "migrations/migration_lock.toml"));
    for (const name of names) {
        await cp(join(providerRoot(provider), "migrations", name), join(stage, "migrations", name), { recursive: true });
    }
}

function decodeJson(value: unknown): unknown {
    return typeof value === "string" ? JSON.parse(value) : value;
}

function sqlJsonFor(provider: Provider, value: unknown): string {
    const text = JSON.stringify(value).replaceAll("'", "''");
    return `'${provider === "mysql" ? text.replaceAll("\\", "\\\\") : text}'`;
}

async function seedOldProducer(provider: Provider, db: Database): Promise<void> {
    const q = (name: string) => provider === "mysql" ? `\`${name}\`` : `"${name}"`;
    const now = provider === "mysql" ? "CURRENT_TIMESTAMP(3)" : "CURRENT_TIMESTAMP";
    await db.execute(`INSERT INTO ${q("Account")} (${q("id")},${q("publicKey")},${q("updatedAt")}) VALUES ('setup-owner','setup-owner-key',${now})`);
    const launch = retainedLaunch;
    for (const preset of [{ id: "setup-preset", value: oldDefinition }, { id: "setup-empty", value: null }]) {
        await db.execute(`INSERT INTO ${q("ManagedMachinePreset")} (${["id", "homeId", "custodianAccountId", "name", "launch", "environment", "controllerMachineId", "controllerInstallationId", "updatedAt"].map(q)}) VALUES ('${preset.id}','home','setup-owner','Retained',${sqlJsonFor(provider, launch)},${preset.value === null ? "NULL" : sqlJsonFor(provider, preset.value)},'controller','installation',${now})`);
    }
    const rows: ReadonlyArray<{ id: string; value: unknown }> = [
        { id: "retained", value: oldSetup }, { id: "sql-null", value: null }, ...controls,
    ];
    for (const row of rows) {
        const admission = row.id === "retained" ? oldAdmission : row.id === "unknown"
            ? { ...oldAdmission, unknown: controls[2].value.unknown,
                computeInput: { ...oldComputeInput, unknown: [false, null],
                    reviewedFacts: { ...oldReviewedFacts, unknown: { retained: true } } } }
            : row.id === "json-null" ? { environmentSetup: null, computeInput: { reviewedFacts: { environment: null } } } : {};
        const facts = row.id === "retained" ? oldReviewedFacts : row.id === "unknown"
            ? { ...oldReviewedFacts, unknown: controls[2].value.unknown }
            : row.id === "json-null" ? { environment: null } : row.id === "absent" ? { unknown: [true, null] } : null;
        await db.execute(`INSERT INTO ${q("ManagedMachine")} (${["id", "homeId", "custodianAccountId", "controllerMachineId", "controllerInstallationId", "admittedActionRequestId", "admittedInput", "reviewedFacts", "presetId", "presetRevision", "launch", "environmentSetup", "retention", "wakeOnAcceptedMessage", "updatedAt"].map(q)}) VALUES ('${row.id}','home','setup-owner','controller','installation','${row.id}',${sqlJsonFor(provider, admission)},${facts === null ? "NULL" : sqlJsonFor(provider, facts)},'setup-preset',0,${sqlJsonFor(provider, launch)},${row.value === null ? "NULL" : sqlJsonFor(provider, row.value)},'{"kind":"until-delete"}',${provider === "postgres" ? "false" : "0"},${now})`);
    }
}

async function readFinal(provider: Provider, db: Database): Promise<Row[]> {
    const q = (name: string) => provider === "mysql" ? `\`${name}\`` : `"${name}"`;
    return db.query(`SELECT ${["id", "presetId", "presetRevision", "machineSetup", "admittedInput", "reviewedFacts"].map(q)} FROM ${q("ManagedMachine")} ORDER BY ${q("id")}`);
}

async function readPresetRows(provider: Provider, db: Database, beforeRename = false): Promise<Row[]> {
    const q = (name: string) => provider === "mysql" ? `\`${name}\`` : `"${name}"`;
    const columns = ["id", "homeId", "custodianAccountId", "teamId", "name", "revision", "launch",
        "controllerMachineId", "controllerInstallationId", "retentionOverride", "wakeOnAcceptedMessage",
        "simultaneousMaximum", "archivedAt", "createdAt", "updatedAt"].map(q);
    columns.push(`${q(beforeRename ? "environment" : "setup")} AS ${q("setup")}`);
    return db.query(`SELECT ${columns} FROM ${q("ManagedMachinePreset")} ORDER BY ${q("id")}`);
}

async function assertSetupOnlyPreset(provider: Provider, db: Database): Promise<void> {
    const q = (name: string) => provider === "mysql" ? `\`${name}\`` : `"${name}"`;
    const now = provider === "mysql" ? "CURRENT_TIMESTAMP(3)" : "CURRENT_TIMESTAMP";
    await db.execute(`INSERT INTO ${q("Account")} (${q("id")},${q("publicKey")},${q("updatedAt")}) VALUES ('setup-only-owner','setup-only-key',${now})`);
    // SQL NULL, rather than JSON null, is the storage contract consumed by the
    // existing Preset codec for an omitted creation part.
    await db.execute(`INSERT INTO ${q("ManagedMachinePreset")} (${["id", "homeId", "custodianAccountId", "name", "launch", "setup", "controllerMachineId", "controllerInstallationId", "updatedAt"].map(q)}) VALUES ('setup-only','home','setup-only-owner','Setup only',NULL,${sqlJsonFor(provider, oldDefinition)},NULL,NULL,${now})`);
    const rows = await db.query(`SELECT ${["launch", "setup", "controllerMachineId", "controllerInstallationId"].map(q)} FROM ${q("ManagedMachinePreset")} WHERE ${q("id")}='setup-only' AND ${q("launch")} IS NULL`);
    expect(rows.map((row) => ({ ...row, setup: decodeJson(row.setup) }))).toEqual([{
        launch: null, setup: oldDefinition, controllerMachineId: null, controllerInstallationId: null,
    }]);
    // SQLite needs a table rebuild for nullability; it must retain the
    // pre-existing ownership and positive-limit constraints as well as data.
    await expect(db.execute(`UPDATE ${q("ManagedMachinePreset")} SET ${q("custodianAccountId")}=NULL WHERE ${q("id")}='setup-only'`)).rejects.toThrow();
    await expect(db.execute(`UPDATE ${q("ManagedMachinePreset")} SET ${q("simultaneousMaximum")}=0 WHERE ${q("id")}='setup-only'`)).rejects.toThrow();
}

async function assertRetainedData(provider: Provider, db: Database): Promise<void> {
    const rows = await readFinal(provider, db);
    expect(rows.map((row) => [row.id, row.presetId, row.presetRevision])).toEqual(
        ["absent", "json-null", "retained", "sql-null", "unknown"].map((id) => [id, "setup-preset", 0]),
    );
    const setupFor = (id: string) => decodeJson(rows.find((row) => row.id === id)?.machineSetup);
    expect(setupFor("retained")).toEqual({ setup: oldDefinition, state: oldSetup.state, operation: oldSetup.operation, errorCode: oldSetup.errorCode });
    expect(setupReadSchema.parse(setupFor("retained"))).toEqual({ setup: projectedDefinition, state: oldSetup.state, operation: oldSetup.operation, errorCode: oldSetup.errorCode });
    expect(setupFor("sql-null")).toBeNull();
    expect(setupFor("absent")).toEqual(controls[0].value);
    expect(setupFor("json-null")).toEqual({ setup: null, state: "skipped", unknown: false });
    expect(setupFor("unknown")).toEqual({ setup: oldDefinition, state: oldSetup.state, operation: oldSetup.operation, errorCode: oldSetup.errorCode, unknown: controls[2].value.unknown });
    const rowFor = (id: string) => rows.find((row) => row.id === id)!;
    expect(decodeJson(rowFor("retained").admittedInput)).toEqual(currentAdmission);
    expect(decodeJson(rowFor("retained").reviewedFacts)).toEqual(currentReviewedFacts);
    expect(decodeJson(rowFor("unknown").admittedInput)).toEqual({ ...currentAdmission, unknown: controls[2].value.unknown,
        computeInput: { ...currentAdmission.computeInput, unknown: [false, null],
            reviewedFacts: { ...currentReviewedFacts, unknown: { retained: true } } } });
    expect(decodeJson(rowFor("unknown").reviewedFacts)).toEqual({ ...currentReviewedFacts, unknown: controls[2].value.unknown });
    expect(decodeJson(rowFor("json-null").admittedInput)).toEqual({ machineSetup: null, computeInput: { reviewedFacts: { setup: null } } });
    expect(decodeJson(rowFor("json-null").reviewedFacts)).toEqual({ setup: null });
    expect(decodeJson(rowFor("absent").admittedInput)).toEqual({});
    expect(decodeJson(rowFor("absent").reviewedFacts)).toEqual({ unknown: [true, null] });
    expect(rowFor("sql-null").reviewedFacts).toBeNull();
    const q = provider === "mysql" ? "`" : '"';
    const presets = await db.query(`SELECT ${q}id${q},${q}setup${q} FROM ${q}ManagedMachinePreset${q} ORDER BY ${q}id${q}`);
    expect(presets.map((row) => ({ id: row.id, setup: decodeJson(row.setup) }))).toEqual([
        { id: "setup-empty", setup: null }, { id: "setup-preset", setup: oldDefinition },
    ]);
}

async function assertRetainedReplay(provider: Provider, db: Database): Promise<void> {
    // Read through the actual admission owner, not a copy of its stored schema.
    const { readManagedAcquisitionIdentity, readManagedAdmissionState, sameManagedInput } = await import("../../sources/app/machines/managed/managedRows");
    const retained = (await readFinal(provider, db)).find((row) => row.id === "retained")!;
    const admitted = decodeJson(retained.admittedInput);
    expect(sameManagedInput(readManagedAcquisitionIdentity(admitted), {
        computeInput: { ...currentAdmission.computeInput,
            reviewedFacts: { ...currentReviewedFacts, setup: projectedDefinition } }, continuation: null,
    })).toBe(true);
    const setup = readManagedAdmissionState(admitted).machineSetup;
    expect(setup).toEqual({ requestEnvelopeDigest: "retained-setup-envelope" });
}

async function ledger(db: Database): Promise<Row[]> {
    return db.query("SELECT * FROM _prisma_migrations ORDER BY migration_name");
}

async function semanticSchema(provider: Provider, db: Database): Promise<unknown> {
    if (provider === "sqlite") {
        const tables = await db.query("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> '_prisma_migrations' ORDER BY name");
        return Promise.all(tables.map(async ({ name }) => ({
            name,
            columns: await db.query(`PRAGMA table_xinfo('${name}')`),
            foreignKeys: await db.query(`PRAGMA foreign_key_list('${name}')`),
            indexes: await Promise.all((await db.query(`PRAGMA index_list('${name}')`)).map(async (index) => ({
                ...index, columns: await db.query(`PRAGMA index_xinfo('${index.name}')`),
            }))),
            checksAndTriggers: (await db.query(`SELECT type,sql FROM sqlite_schema WHERE tbl_name='${name}' AND (type='trigger' OR sql LIKE '%CHECK%') ORDER BY type,name`))
                .map((row) => ({ ...row, sql: String(row.sql).replaceAll('"', "").replace(/\s+/gu, " ") })),
        })));
    }
    if (provider === "postgres") {
        return readPostgresSemanticSchema(db);
    }
    return {
        columns: await db.query(`SELECT TABLE_NAME,COLUMN_NAME,ORDINAL_POSITION,COLUMN_DEFAULT,IS_NULLABLE,COLUMN_TYPE,CHARACTER_SET_NAME,COLLATION_NAME,EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME <> '_prisma_migrations' ORDER BY TABLE_NAME,ORDINAL_POSITION`),
        indexes: await db.query(`SELECT TABLE_NAME,INDEX_NAME,NON_UNIQUE,SEQ_IN_INDEX,COLUMN_NAME,COLLATION,SUB_PART,INDEX_TYPE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME <> '_prisma_migrations' ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX`),
        constraints: await db.query(`SELECT TABLE_NAME,CONSTRAINT_NAME,COLUMN_NAME,ORDINAL_POSITION,REFERENCED_TABLE_NAME,REFERENCED_COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME <> '_prisma_migrations' ORDER BY TABLE_NAME,CONSTRAINT_NAME,ORDINAL_POSITION`),
        checks: await db.query(`SELECT CONSTRAINT_NAME,CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() ORDER BY CONSTRAINT_NAME`),
        foreignKeys: await db.query(`SELECT TABLE_NAME,CONSTRAINT_NAME,REFERENCED_TABLE_NAME,UPDATE_RULE,DELETE_RULE FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() ORDER BY TABLE_NAME,CONSTRAINT_NAME`),
        triggers: await db.query(`SELECT EVENT_OBJECT_TABLE,TRIGGER_NAME,EVENT_MANIPULATION,ACTION_STATEMENT FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() ORDER BY EVENT_OBJECT_TABLE,TRIGGER_NAME`),
    };
}

async function proveUpgrade(provider: Provider, upgraded: Database, fresh: Database, deploy: (fresh: boolean) => Promise<void>, oldLedger: Row[], retainedPresets: Row[]): Promise<void> {
    await deploy(false);
    // This is deliberately raw SQL: before D1, RED must be a missing final
    // database column, independent of future protocol exports/generated clients.
    await assertRetainedData(provider, upgraded);
    expect(await readPresetRows(provider, upgraded)).toEqual(retainedPresets);
    const after = await ledger(upgraded);
    const original = oldLedger.find((row) => row.migration_name === originalMigration);
    expect(original).toBeDefined();
    expect(after.find((row) => row.migration_name === originalMigration)).toEqual(original);
    expect(after.filter((row) => row.migration_name === renameMigration)).toHaveLength(1);
    expect(original?.checksum).toBe(createHash("sha256").update(await readFile(join(providerRoot(provider), "migrations", originalMigration, "migration.sql"))).digest("hex"));
    await deploy(true);
    expect(await semanticSchema(provider, upgraded)).toEqual(await semanticSchema(provider, fresh));
    await assertSetupOnlyPreset(provider, upgraded);
    await assertSetupOnlyPreset(provider, fresh);
    const freshLedger = await ledger(fresh);
    const data = await readFinal(provider, upgraded);
    const presets = await readPresetRows(provider, upgraded);
    await deploy(false);
    await deploy(true);
    expect(await ledger(upgraded)).toEqual(after);
    expect(await ledger(fresh)).toEqual(freshLedger);
    expect(await readFinal(provider, upgraded)).toEqual(data);
    expect(await readPresetRows(provider, upgraded)).toEqual(presets);
    await assertRetainedReplay(provider, upgraded);
}

describe("Machine setup rename and optional Preset creation", () => {
    it("preserves retained setup through the shipped light SQLite runner and matches a fresh deploy", async () => {
        const stage = await mkdtemp(join(tmpdir(), "happier-machine-setup-sqlite-"));
        const upgradedPath = join(stage, "upgraded.sqlite");
        const freshPath = join(stage, "fresh.sqlite");
        const upgradedSqlite = new DatabaseSync(upgradedPath);
        const freshSqlite = new DatabaseSync(freshPath);
        const upgradedClient = await createDbMaintenanceClient("sqlite", `file:${upgradedPath}`);
        const adapt = (db: DatabaseSync): Database => ({
            execute: async (sql) => db.exec(sql), query: async (sql) => db.prepare(sql).all(),
        });
        const upgraded = adapt(upgradedSqlite);
        const fresh = adapt(freshSqlite);
        const deploy = async (isFresh: boolean) => {
            await applySqliteMigrations({ databasePath: isFresh ? freshPath : upgradedPath, migrationsDir: join(stage, "migrations") });
        };
        try {
            const names = await migrationNames("sqlite");
            await stageMigrations("sqlite", stage, names.filter((name) => name < renameMigration));
            await deploy(false);
            await seedOldProducer("sqlite", upgraded);
            const before = await ledger(upgraded);
            const retainedPresets = await readPresetRows("sqlite", upgraded, true);
            await stageMigrations("sqlite", stage, names);
            await proveUpgrade("sqlite", upgraded, fresh, deploy, before, retainedPresets);
            const retained = await upgradedClient.managedMachine.findUniqueOrThrow({ where: { id: "retained" }, select: { machineSetup: true } });
            expect(setupReadSchema.parse(retained.machineSetup)).toEqual({ setup: projectedDefinition, state: oldSetup.state, operation: oldSetup.operation, errorCode: oldSetup.errorCode });
            expect(await upgradedClient.managedMachinePreset.findUniqueOrThrow({ where: { id: "setup-preset" }, select: { setup: true } })).toEqual({ setup: oldDefinition });
            expect(await upgraded.query("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
            expect(await upgraded.query("PRAGMA foreign_key_check")).toEqual([]);
        } finally {
            await upgradedClient.$disconnect();
            upgradedSqlite.close(); freshSqlite.close();
            await rm(stage, { recursive: true, force: true });
        }
    }, 120_000);

    for (const provider of ["postgres", "mysql"] as const) {
        const url = process.env[provider === "postgres" ? "HAPPIER_TEST_POSTGRES_DATABASE_URL" : "HAPPIER_TEST_MYSQL_DATABASE_URL"];
        (url ? it : it.skip)(`preserves retained setup through real ${provider} deploys and matches a fresh schema`, async () => {
            const stage = await mkdtemp(join(tmpdir(), `happier-machine-setup-${provider}-`));
            const id = `setup_${randomUUID().replaceAll("-", "")}`;
            const freshId = `${id}_fresh`;
            const admin = await createDbMaintenanceClient(provider, url);
            const scopedUrl = (name: string) => {
                const scoped = new URL(url!);
                if (provider === "postgres") scoped.searchParams.set("schema", name);
                else scoped.pathname = `/${name}`;
                return scoped.toString();
            };
            const upgradedClient = await createDbMaintenanceClient(provider, scopedUrl(id));
            const freshClient = await createDbMaintenanceClient(provider, scopedUrl(freshId));
            const adapt = (db: PostgresPrismaClient | MysqlPrismaClient): Database => ({
                execute: (sql) => db.$executeRawUnsafe(sql), query: (sql) => db.$queryRawUnsafe<Row[]>(sql),
            });
            const deploy = async (isFresh: boolean) => runPrismaMigrateCli({
                serverRoot, schemaPath: join(stage, "schema.prisma"), args: ['deploy'],
                env: { ...process.env, DATABASE_URL: scopedUrl(isFresh ? freshId : id), HAPPIER_DB_PROVIDER: provider }, quiet: true,
            });
            const created: string[] = [];
            try {
                for (const name of [id, freshId]) {
                    await admin.$executeRawUnsafe(provider === "postgres" ? `CREATE SCHEMA "${name}"` : `CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
                    created.push(name);
                }
                const names = await migrationNames(provider);
                await stageMigrations(provider, stage, names.filter((name) => name < renameMigration));
                await deploy(false);
                await seedOldProducer(provider, adapt(upgradedClient));
                const before = await ledger(adapt(upgradedClient));
                const retainedPresets = await readPresetRows(provider, adapt(upgradedClient), true);
                await stageMigrations(provider, stage, names);
                await proveUpgrade(provider, adapt(upgradedClient), adapt(freshClient), deploy, before, retainedPresets);
                const retained = await upgradedClient.managedMachine.findUniqueOrThrow({ where: { id: "retained" }, select: { machineSetup: true } });
                expect(setupReadSchema.parse(retained.machineSetup)).toEqual({ setup: projectedDefinition, state: oldSetup.state, operation: oldSetup.operation, errorCode: oldSetup.errorCode });
                const preset = await upgradedClient.managedMachinePreset.findUniqueOrThrow({ where: { id: "setup-preset" }, select: { setup: true } });
                expect(preset.setup).toEqual(oldDefinition);
            } finally {
                await upgradedClient.$disconnect(); await freshClient.$disconnect();
                for (const name of created) await admin.$executeRawUnsafe(provider === "postgres" ? `DROP SCHEMA "${name}" CASCADE` : `DROP DATABASE \`${name}\``);
                await admin.$disconnect();
                await rm(stage, { recursive: true, force: true });
            }
        }, 120_000);
    }
});
