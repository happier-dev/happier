import { createHash, randomUUID } from 'node:crypto';
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient as PostgresClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { PrismaClient as MysqlClient } from '../../generated/mysql-client/index.js';
import { runPrismaCli } from '../prismaCli';

const serverRoot = join(import.meta.dirname, '../..');
const taskMigration = '20261031120000_add_task_resource_grants';
const taskTables = ['TaskAccountGrant', 'TaskGroupGrant', 'TaskKeyEnvelope', 'TaskTeamGrant'];

describe('Task grants additive migration upgrade', () => {
    for (const provider of ['postgres', 'mysql'] as const) {
        const databaseUrl = process.env[provider === 'postgres' ? 'HAPPIER_TEST_POSTGRES_DATABASE_URL' : 'HAPPIER_TEST_MYSQL_DATABASE_URL'];
        (databaseUrl ? it : it.skip)(`upgrades a pre-T9 ${provider} ledger without rewriting task bytes and deploys twice`, async () => {
            if (!process.env.HAPPIER_DB_CONTRACT_CONTAINER_ID) throw new Error('Use the canonical disposable Docker DB-contract runner');
            const stage = await mkdtemp(join(tmpdir(), `happier-task-grants-${provider}-`));
            const name = `task_upgrade_${randomUUID().replaceAll('-', '')}`;
            const root = join(serverRoot, 'prisma', ...(provider === 'postgres' ? [] : [provider]));
            const Client = provider === 'postgres' ? PostgresClient : MysqlClient;
            const admin = new Client({ datasourceUrl: databaseUrl });
            const scoped = new URL(databaseUrl!);
            if (provider === 'postgres') scoped.searchParams.set('schema', name);
            else scoped.pathname = `/${name}`;
            const client = new Client({ datasourceUrl: scoped.toString() });
            const q = (value: string) => provider === 'mysql' ? `\`${value}\`` : `"${value}"`;
            const query = (sql: string) => client.$queryRawUnsafe<Record<string, unknown>[]>(sql);
            const ledger = () => query('SELECT * FROM _prisma_migrations ORDER BY migration_name');
            const retainedRows = () => query(`SELECT * FROM ${q('UserKVStore')} ORDER BY ${q('id')}`);
            const tables = () => query(provider === 'postgres'
                ? `SELECT table_name AS name FROM information_schema.tables WHERE table_schema=current_schema() AND table_name LIKE 'Task%' ORDER BY table_name`
                : `SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'Task%' ORDER BY TABLE_NAME`);
            const stageMigrations = async (names: string[]) => {
                await mkdir(join(stage, 'migrations'), { recursive: true });
                await copyFile(join(root, 'schema.prisma'), join(stage, 'schema.prisma'));
                await copyFile(join(root, 'migrations/migration_lock.toml'), join(stage, 'migrations/migration_lock.toml'));
                for (const migration of names) await cp(join(root, 'migrations', migration), join(stage, 'migrations', migration), { recursive: true });
            };
            const deploy = (quiet = true) => runPrismaCli({ serverRoot,
                args: ['migrate', 'deploy', '--schema', join(stage, 'schema.prisma')],
                env: { ...process.env, DATABASE_URL: scoped.toString(), HAPPIER_DB_PROVIDER: provider }, quiet });
            let created = false;
            try {
                await admin.$executeRawUnsafe(provider === 'postgres' ? `CREATE SCHEMA "${name}"`
                    : `CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
                created = true;
                const names = (await readdir(join(root, 'migrations'), { withFileTypes: true }))
                    .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
                expect(names).toContain(taskMigration);
                const oldNames = names.filter(migration => migration < taskMigration);
                await stageMigrations(oldNames);
                await deploy();
                const now = provider === 'mysql' ? 'CURRENT_TIMESTAMP(3)' : 'CURRENT_TIMESTAMP';
                await client.$executeRawUnsafe(`INSERT INTO ${q('Account')} (${q('id')},${q('publicKey')},${q('updatedAt')}) VALUES ('owner','owner-key',${now}),('recipient','recipient-key',${now})`);
                await client.$executeRawUnsafe(`INSERT INTO ${q('Team')} (${q('id')},${q('name')},${q('updatedAt')}) VALUES ('team','Retained team',${now})`);
                await client.$executeRawUnsafe(`INSERT INTO ${q('TeamGroup')} (${q('id')},${q('teamId')},${q('name')},${q('nameKey')},${q('updatedAt')}) VALUES ('group','team','Retained group','retained',${now})`);
                const payloads = [
                    { id: 'legacy', key: 'todo.legacy', value: new Uint8Array([0, 255, 128, 1, 2]) },
                    { id: 'plain', key: 'todo.plain', value: new TextEncoder().encode('{"t":"plain","v":{"title":"retained"}}') },
                    { id: 'index', key: 'todo.index', value: new TextEncoder().encode('{"ids":["legacy","plain"]}') },
                ];
                for (const row of payloads) {
                    const values = provider === 'postgres' ? "$1,'owner',$2,$3" : "?,'owner',?,?";
                    await client.$executeRawUnsafe(`INSERT INTO ${q('UserKVStore')} (${q('id')},${q('accountId')},${q('key')},${q('value')},${q('version')},${q('updatedAt')}) VALUES (${values},7,${now})`, row.id, row.key, row.value);
                }
                const oldRows = await retainedRows();
                const oldLedger = await ledger();
                expect(oldLedger.map(row => row.migration_name)).toEqual(oldNames);
                expect(await tables()).toEqual([]);
                for (const table of taskTables) await expect(query(`SELECT * FROM ${q(table)}`)).rejects.toThrow();
                console.log(`[task-migration-upgrade] ${provider} old-ledger=${oldLedger.length}; retained-rows=${oldRows.length}; RED: all four Task relations absent`);

                await stageMigrations(names);
                await deploy(false);
                expect((await tables()).map(row => row.name)).toEqual(taskTables);
                expect(await retainedRows()).toEqual(oldRows);
                const upgradedLedger = await ledger();
                expect(upgradedLedger.filter(row => oldNames.includes(String(row.migration_name)))).toEqual(oldLedger);
                expect(upgradedLedger.map(row => row.migration_name)).toEqual(names);
                for (const row of upgradedLedger) {
                    expect(row.finished_at).not.toBeNull();
                    expect(row.rolled_back_at).toBeNull();
                    expect(row.checksum).toBe(createHash('sha256').update(await readFile(
                        join(root, 'migrations', String(row.migration_name), 'migration.sql'))).digest('hex'));
                }
                const insertRelations = async (taskId: string) => {
                    for (const [table, column, principal, access] of [
                        ['TaskAccountGrant', 'accountId', 'recipient', 'view'],
                        ['TaskTeamGrant', 'teamId', 'team', 'edit'],
                        ['TaskGroupGrant', 'teamGroupId', 'group', 'admin'],
                    ]) await client.$executeRawUnsafe(`INSERT INTO ${q(table)} (${q('taskId')},${q(column)},${q('accessLevel')},${q('createdByAccountId')}) VALUES ('${taskId}','${principal}','${access}','owner')`);
                    const bytes = provider === 'postgres' ? "decode('00ff80','hex')" : "UNHEX('00ff80')";
                    await client.$executeRawUnsafe(`INSERT INTO ${q('TaskKeyEnvelope')} (${q('taskId')},${q('recipientAccountId')},${q('encryptedDataKey')},${q('recipientContentPublicKeyFingerprint')},${q('updatedAt')}) VALUES ('${taskId}','owner',${bytes},'owner-fingerprint',${now}),('${taskId}','recipient',${bytes},'recipient-fingerprint',${now})`);
                };
                await insertRelations('legacy');
                const relationships = await Promise.all(taskTables.map(table => query(`SELECT * FROM ${q(table)} ORDER BY 1,2`)));
                expect(relationships.map(rows => rows.length)).toEqual([1, 1, 2, 1]);
                for (const table of taskTables) {
                    await expect(client.$executeRawUnsafe(`INSERT INTO ${q(table)} SELECT * FROM ${q(table)}`)).rejects.toThrow();
                    await expect(client.$executeRawUnsafe(`UPDATE ${q(table)} SET ${q('taskId')}='missing-task'`)).rejects.toThrow();
                }
                for (const [table, column] of [
                    ['TaskAccountGrant', 'accountId'], ['TaskTeamGrant', 'teamId'],
                    ['TaskGroupGrant', 'teamGroupId'], ['TaskKeyEnvelope', 'recipientAccountId'],
                ]) await expect(client.$executeRawUnsafe(`UPDATE ${q(table)} SET ${q(column)}='missing-principal'`)).rejects.toThrow();
                await client.$executeRawUnsafe(`INSERT INTO ${q('UserKVStore')} (${q('id')},${q('accountId')},${q('key')},${q('version')},${q('updatedAt')}) VALUES ('cascade','owner','todo.cascade',0,${now})`);
                await insertRelations('cascade');
                await client.$executeRawUnsafe(`DELETE FROM ${q('UserKVStore')} WHERE ${q('id')}='cascade'`);
                expect(await Promise.all(taskTables.map(table => query(`SELECT * FROM ${q(table)} ORDER BY 1,2`)))).toEqual(relationships);
                expect(await retainedRows()).toEqual(oldRows);
                console.log(`[task-migration-upgrade] ${provider} GREEN: four relations; owner+recipient envelopes; unique/FK/cascade constraints; original ledger and binary/Plain/index rows retained; all ${names.length} checksums current`);

                await deploy(false);
                expect(await ledger()).toEqual(upgradedLedger);
                expect(await retainedRows()).toEqual(oldRows);
                expect(await Promise.all(taskTables.map(table => query(`SELECT * FROM ${q(table)} ORDER BY 1,2`)))).toEqual(relationships);
                console.log(`[task-migration-upgrade] ${provider} second-deploy idempotent: no pending migrations; complete ledger, retained rows and relations unchanged`);
            } finally {
                await client.$disconnect();
                if (created) await admin.$executeRawUnsafe(provider === 'postgres' ? `DROP SCHEMA "${name}" CASCADE` : `DROP DATABASE \`${name}\``);
                await admin.$disconnect();
                await rm(stage, { recursive: true, force: true });
            }
        }, 120_000);
    }
});
