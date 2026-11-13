import { randomUUID } from "node:crypto";
import { copyFile, cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { PrismaClient as PostgresPrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { PrismaClient as MysqlPrismaClient } from "../../generated/mysql-client/index.js";
import { applySqliteMigrations } from "../prismaMigrations";
import { runPrismaCli } from "../prismaCli";

type Provider = "sqlite" | "postgres" | "mysql";
type Row = Record<string, unknown>;
type Database = Readonly<{
    execute: (sql: string) => Promise<unknown>;
    query: (sql: string) => Promise<Row[]>;
}>;

const serverRoot = join(import.meta.dirname, "../..");
const finalMigration = "20261031181500_managed_machine_optional_controller";

function providerRoot(provider: Provider): string {
    return join(serverRoot, "prisma", ...(provider === "postgres" ? [] : [provider]));
}

async function stageMigrations(provider: Provider, stage: string, includeFinal: boolean): Promise<void> {
    const root = providerRoot(provider);
    await mkdir(join(stage, "migrations"), { recursive: true });
    await copyFile(join(root, "schema.prisma"), join(stage, "schema.prisma"));
    await copyFile(join(root, "migrations/migration_lock.toml"), join(stage, "migrations/migration_lock.toml"));
    for (const entry of await readdir(join(root, "migrations"), { withFileTypes: true })) {
        // This contract isolates the controller cut; later migrations have
        // their own schema and retention contracts.
        if (entry.isDirectory() && (entry.name < finalMigration || (includeFinal && entry.name === finalMigration))) {
            await cp(join(root, "migrations", entry.name), join(stage, "migrations", entry.name), { recursive: true });
        }
    }
}

async function proveControllerTransition(provider: Provider, db: Database, deployFinal: () => Promise<void>): Promise<void> {
    const q = (name: string) => provider === "mysql" ? `\`${name}\`` : `"${name}"`;
    const now = provider === "mysql" ? "CURRENT_TIMESTAMP(3)" : "CURRENT_TIMESTAMP";
    const json = (value: unknown) => {
        const text = JSON.stringify(value).replaceAll("'", "''");
        return `'${provider === "mysql" ? text.replaceAll("\\", "\\\\") : text}'`;
    };
    const insert = (table: string, fields: Record<string, string>) => db.execute(
        `INSERT INTO ${q(table)} (${Object.keys(fields).map(q)}) VALUES (${Object.values(fields)})`,
    );
    await insert("Account", { id: "'owner'", publicKey: "'owner-key'", updatedAt: now });
    await insert("Machine", { id: "'enrolled'", accountId: "'owner'", metadata: "'retained-metadata'", updatedAt: now });
    // Raw persisted fixtures describe the pre-cut row, independent of generated
    // client nullability. These are paid allocations, not disposable projections.
    for (const id of ["paid", "local", "team", "cleanup-unknown"]) {
        await insert("ManagedMachine", {
            id: `'${id}'`, homeId: "'home'", custodianAccountId: "'owner'",
            controllerMachineId: "'controller'", controllerInstallationId: "'installation'",
            admittedActionRequestId: `'${id}'`, admittedInput: json({ retained: [true, null, { unknown: 3 }] }),
            presetId: "'preset'", presetRevision: "7", launch: json({ provider: "fixture" }),
            reviewedFacts: json({ nativeScope: { team: "native-team", project: "native-project" } }),
            machineSetup: json({ state: "failed", operation: { operationId: "setup" }, unknown: [null, true] }),
            allocation: "'may-exist'", creationState: "'active'",
            resource: json({ nativeId: id, scope: { project: "native-project" } }),
            nativeOperationRef: json({ operationId: `allocate-${id}` }), recovery: json({ kind: "inspect" }),
            bootstrapCredentialRef: json({ resourceId: "credential-reference" }),
            enrolledMachineId: id === "paid" ? "'enrolled'" : "NULL",
            desired: "'stop'", desiredWhen: "'idle'", desiredAfterMs: "1234", intentRevision: "8",
            archivedAt: id === "cleanup-unknown" ? now : "NULL",
            retention: json({ kind: "until-delete" }), wakeOnAcceptedMessage: provider === "postgres" ? "true" : "1",
            observation: json({ powerState: "unknown", unknown: false }),
            cleanup: json({ status: "unknown", pendingNativeId: id }), updatedAt: now,
        });
    }
    await insert("Session", {
        id: "'birth-session'", tag: "'birth'", accountId: "'owner'", metadata: "'{}'",
        managedCreationId: "'paid'", updatedAt: now,
    });
    await insert("AutomationRun", {
        id: "'birth-run'", accountId: "'owner'", managedCreationId: "'paid'",
        originKind: "'direct'", causeKind: "NULL", workflowAcceptedSnapshotEnvelope: "'retained-envelope'",
        workflowCustodyState: "'settled'", scheduledAt: now, dueAt: now, updatedAt: now,
    });
    const managedRows = () => db.query(`SELECT * FROM ${q("ManagedMachine")} ORDER BY ${q("id")}`);
    const ledger = () => db.query("SELECT * FROM _prisma_migrations ORDER BY migration_name");
    const before = await managedRows();
    const machinesBefore = await db.query(`SELECT * FROM ${q("Machine")}`);
    const ledgerBefore = await ledger();
    await deployFinal();
    expect(await managedRows()).toEqual(before);
    expect(await db.query(`SELECT * FROM ${q("Machine")}`)).toEqual(machinesBefore);
    for (const table of ["Session", "AutomationRun"]) {
        expect(await db.query(`SELECT ${q("managedCreationId")} FROM ${q(table)}`)).toEqual([{ managedCreationId: "paid" }]);
    }
    const ledgerAfter = await ledger();
    expect(ledgerAfter.filter((row) => row.migration_name !== finalMigration)).toEqual(ledgerBefore);

    // The pre-cut NOT NULL columns fail here; the completed cut must support
    // absent personal control without changing any other paid/native custody.
    await db.execute(`UPDATE ${q("ManagedMachine")} SET ${q("controllerMachineId")}=NULL, ${q("controllerInstallationId")}=NULL WHERE ${q("id")}='paid'`);
    const afterClear = await managedRows();
    expect(afterClear).toEqual(before.map((row) => row.id === "paid"
        ? { ...row, controllerMachineId: null, controllerInstallationId: null } : row));
    for (const [column, value] of [["controllerMachineId", "'partial'"], ["controllerInstallationId", "'partial'"]] as const) {
        await expect(db.execute(`UPDATE ${q("ManagedMachine")} SET ${q(column)}=${value} WHERE ${q("id")}='paid'`)).rejects.toThrow();
    }
    await expect(db.execute(`UPDATE ${q("ManagedMachine")} SET ${q("controllerInstallationId")}=NULL WHERE ${q("id")}='local'`)).rejects.toThrow();
    await db.execute(`UPDATE ${q("ManagedMachine")} SET ${q("controllerMachineId")}='new-controller', ${q("controllerInstallationId")}='new-installation' WHERE ${q("id")}='paid'`);
    await deployFinal();
    expect(await ledger()).toEqual(ledgerAfter);
    expect((await managedRows()).find((row) => row.id === "paid")).toEqual({
        ...before.find((row) => row.id === "paid"), controllerMachineId: "new-controller", controllerInstallationId: "new-installation",
    });
}

describe("Managed Machine nullable controller pair FINAL migration", () => {
    it("preserves paid rows, birth references and ordinary Machines through the real SQLite migration runner", async () => {
        const stage = await mkdtemp(join(tmpdir(), "happier-managed-controller-sqlite-"));
        const path = join(stage, "upgrade.sqlite");
        const sqlite = new DatabaseSync(path);
        const db: Database = { execute: async (sql) => sqlite.exec(sql), query: async (sql) => sqlite.prepare(sql).all() };
        try {
            await stageMigrations("sqlite", stage, false);
            await applySqliteMigrations({ databasePath: path, migrationsDir: join(stage, "migrations") });
            const schemaBefore = sqlite.prepare("SELECT type,name,sql FROM sqlite_schema WHERE tbl_name='ManagedMachine' AND type='index' ORDER BY name").all();
            const foreignKeysBefore = sqlite.prepare("PRAGMA foreign_key_list('ManagedMachine')").all();
            const columnsBefore = sqlite.prepare("PRAGMA table_info('ManagedMachine')").all();
            await proveControllerTransition("sqlite", db, async () => {
                await stageMigrations("sqlite", stage, true);
                await applySqliteMigrations({ databasePath: path, migrationsDir: join(stage, "migrations") });
            });
            expect(sqlite.prepare("SELECT type,name,sql FROM sqlite_schema WHERE tbl_name='ManagedMachine' AND type='index' ORDER BY name").all()).toEqual(schemaBefore);
            expect(sqlite.prepare("PRAGMA foreign_key_list('ManagedMachine')").all()).toEqual(foreignKeysBefore);
            expect(sqlite.prepare("PRAGMA table_info('ManagedMachine')").all()).toEqual(columnsBefore.map((column) =>
                ["controllerMachineId", "controllerInstallationId"].includes(String(column.name)) ? { ...column, notnull: 0 } : column));
            expect(sqlite.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
            expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        } finally {
            sqlite.close();
            await rm(stage, { recursive: true, force: true });
        }
    }, 120_000);

    for (const provider of ["postgres", "mysql"] as const) {
        const url = process.env[provider === "postgres" ? "HAPPIER_TEST_POSTGRES_DATABASE_URL" : "HAPPIER_TEST_MYSQL_DATABASE_URL"];
        (url ? it : it.skip)(`preserves retained rows and enforces the pair through real ${provider} deploys`, async () => {
            const stage = await mkdtemp(join(tmpdir(), `happier-managed-controller-${provider}-`));
            const id = `controller_${randomUUID().replaceAll("-", "")}`;
            const Client = provider === "postgres" ? PostgresPrismaClient : MysqlPrismaClient;
            const admin = new Client({ datasourceUrl: url });
            const scoped = new URL(url!);
            if (provider === "postgres") scoped.searchParams.set("schema", id);
            else scoped.pathname = `/${id}`;
            const client = new Client({ datasourceUrl: scoped.toString() });
            const db: Database = { execute: (sql) => client.$executeRawUnsafe(sql), query: (sql) => client.$queryRawUnsafe<Row[]>(sql) };
            const deploy = () => runPrismaCli({ serverRoot, args: ["migrate", "deploy", "--schema", join(stage, "schema.prisma")],
                env: { ...process.env, DATABASE_URL: scoped.toString(), HAPPIER_DB_PROVIDER: provider }, quiet: true });
            let created = false;
            try {
                await admin.$executeRawUnsafe(provider === "postgres" ? `CREATE SCHEMA "${id}"` : `CREATE DATABASE \`${id}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
                created = true;
                await stageMigrations(provider, stage, false);
                await deploy();
                await proveControllerTransition(provider, db, async () => { await stageMigrations(provider, stage, true); await deploy(); });
            } finally {
                await client.$disconnect();
                if (created) await admin.$executeRawUnsafe(provider === "postgres" ? `DROP SCHEMA "${id}" CASCADE` : `DROP DATABASE \`${id}\``);
                await admin.$disconnect();
                await rm(stage, { recursive: true, force: true });
            }
        }, 120_000);
    }
});
