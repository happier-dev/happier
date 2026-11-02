import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PrismaClient as PostgresClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { PrismaClient as MysqlClient } from '../../generated/mysql-client/index.js';
import { applySqliteMigrations } from '../prismaMigrations';
import { runPrismaCli } from '../prismaCli';
import { assertDeploymentPendingContent, deploymentPendingContentMigration } from './deploymentPendingMigration.testkit';
import { assertDeploymentAcceptedExecutionUpgrade, deploymentAcceptedExecutionMigration } from './deploymentAcceptedExecutionMigration.testkit';
import { assertDeploymentDomainStorage, deploymentDomainMigration } from './deploymentDomainMigration.testkit';
import { deploymentParentIdentitySql, deploymentS0Migrations, deploymentTargetLinkIdentityMigration,
    seedDeploymentS0Rows, readDeploymentS0Custody, assertDeploymentTargetIdentityArms,
    type DeploymentMigrationDatabase, type DeploymentMigrationProvider } from './deploymentTargetLinkMigration.testkit';

const serverRoot = join(import.meta.dirname, '../..');
const root = (provider: DeploymentMigrationProvider) => join(serverRoot, 'prisma', ...(provider === 'postgres' ? [] : [provider]));

async function stageS0(provider: DeploymentMigrationProvider, stage: string) {
    await mkdir(join(stage, 'migrations', '00000000000000_contract_parent_identities'), { recursive: true });
    await writeFile(join(stage, 'migrations', '00000000000000_contract_parent_identities', 'migration.sql'), deploymentParentIdentitySql(provider));
    await copyFile(join(root(provider), 'schema.prisma'), join(stage, 'schema.prisma'));
    await copyFile(join(root(provider), 'migrations', 'migration_lock.toml'), join(stage, 'migrations', 'migration_lock.toml'));
    for (const migration of deploymentS0Migrations) {
        await mkdir(join(stage, 'migrations', migration), { recursive: true });
        await copyFile(join(root(provider), 'migrations', migration, 'migration.sql'), join(stage, 'migrations', migration, 'migration.sql'));
    }
}

async function stageWidening(provider: DeploymentMigrationProvider, stage: string) {
    const source = join(root(provider), 'migrations', deploymentTargetLinkIdentityMigration, 'migration.sql');
    const sql = await readFile(source, 'utf8');
    await mkdir(join(stage, 'migrations', deploymentTargetLinkIdentityMigration), { recursive: true });
    await writeFile(join(stage, 'migrations', deploymentTargetLinkIdentityMigration, 'migration.sql'), sql);
}

async function proveWidening(provider: DeploymentMigrationProvider, stage: string, db: DeploymentMigrationDatabase, deploy: () => Promise<unknown>) {
    await deploy();
    await seedDeploymentS0Rows(provider, db);
    const original = await readDeploymentS0Custody(provider, db);
    const oldLedger = await db.query('SELECT migration_name,checksum FROM _prisma_migrations ORDER BY migration_name');
    await stageWidening(provider, stage);
    await deploy();
    expect(await readDeploymentS0Custody(provider, db)).toEqual(original);
    const upgradedLedger = await db.query('SELECT migration_name,checksum FROM _prisma_migrations ORDER BY migration_name');
    expect(upgradedLedger.filter(row => row.migration_name !== deploymentTargetLinkIdentityMigration)).toEqual(oldLedger);
    await assertDeploymentTargetIdentityArms(provider, db);
    const beforeReplay = await readDeploymentS0Custody(provider, db);
    await deploy();
    expect(await readDeploymentS0Custody(provider, db)).toEqual(beforeReplay);
    expect(await db.query('SELECT migration_name,checksum FROM _prisma_migrations ORDER BY migration_name')).toEqual(upgradedLedger);

    const predecessorMigration = '20261027111000_add_deployment_target_predecessor';
    const q = (name: string) => provider === 'mysql' ? `\`${name}\`` : `"${name}"`;
    await mkdir(join(stage, 'migrations', predecessorMigration), { recursive: true });
    await copyFile(join(root(provider), 'migrations', predecessorMigration, 'migration.sql'),
        join(stage, 'migrations', predecessorMigration, 'migration.sql'));
    await deploy();
    expect(await readDeploymentS0Custody(provider, db)).toEqual(beforeReplay);
    expect(await db.query(`SELECT ${q('predecessorTargetLinkId')} FROM ${q('DeploymentTargetLink')} WHERE ${q('id')}='runtime'`))
        .toEqual([{ predecessorTargetLinkId: null }]);
    const predecessorLedger = await db.query('SELECT migration_name,checksum FROM _prisma_migrations ORDER BY migration_name');
    expect(predecessorLedger.filter(row => row.migration_name !== predecessorMigration)).toEqual(upgradedLedger);
    await db.execute(`UPDATE ${q('DeploymentTargetLink')} SET ${q('predecessorTargetLinkId')}='runtime' WHERE ${q('id')}='plugin-runtime'`);
    await db.execute(`UPDATE ${q('DeploymentTargetLink')} SET ${q('predecessorTargetLinkId')}='plugin-runtime' WHERE ${q('id')}='empty-host'`);
    await expect(db.execute(`UPDATE ${q('DeploymentTargetLink')} SET ${q('predecessorTargetLinkId')}='missing' WHERE ${q('id')}='empty-host'`))
        .rejects.toThrow();
    await expect(db.execute(`DELETE FROM ${q('DeploymentTargetLink')} WHERE ${q('id')}='plugin-runtime'`)).rejects.toThrow();
    await deploy();
    expect(await readDeploymentS0Custody(provider, db)).toEqual(beforeReplay);
    expect(await db.query(`SELECT ${q('predecessorTargetLinkId')} FROM ${q('DeploymentTargetLink')} WHERE ${q('id')}='empty-host'`))
        .toEqual([{ predecessorTargetLinkId: 'plugin-runtime' }]);
    expect(await db.query('SELECT migration_name,checksum FROM _prisma_migrations ORDER BY migration_name')).toEqual(predecessorLedger);

    // Apply pending content to a nonempty upgraded database, then replay the
    // canonical deploy. Only the new nullable envelope may change the schema.
    const beforePending = await readDeploymentS0Custody(provider, db);
    await mkdir(join(stage, 'migrations', deploymentPendingContentMigration), { recursive: true });
    await copyFile(join(root(provider), 'migrations', deploymentPendingContentMigration, 'migration.sql'),
        join(stage, 'migrations', deploymentPendingContentMigration, 'migration.sql'));
    await deploy();
    await assertDeploymentPendingContent(provider, db);
    const pendingLedger = await db.query('SELECT migration_name,checksum FROM _prisma_migrations ORDER BY migration_name');
    expect(pendingLedger.filter(row => row.migration_name !== deploymentPendingContentMigration)).toEqual(predecessorLedger);
    expect(await readDeploymentS0Custody(provider, db)).toEqual(beforePending);
    await deploy();
    expect(await readDeploymentS0Custody(provider, db)).toEqual(beforePending);
    expect(await db.query('SELECT migration_name,checksum FROM _prisma_migrations ORDER BY migration_name')).toEqual(pendingLedger);

    const chosenMigration = '20261028184500_add_deployment_environment_deployer';
    const chosenSql = await readFile(join(root(provider), 'migrations', chosenMigration, 'migration.sql'), 'utf8')
        .catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
    if (chosenSql !== null) {
        await mkdir(join(stage, 'migrations', chosenMigration), { recursive: true });
        await writeFile(join(stage, 'migrations', chosenMigration, 'migration.sql'), chosenSql);
    }
    await deploy();
    const insertChosen = (kind: string, id: string, environment = 'environment', creator = 'owner') => db.execute(
        `INSERT INTO ${q('DeploymentEnvironmentDeployer')} (${['environmentId', 'principalKind', 'principalId', 'createdByAccountId'].map(q)})
            VALUES ('${environment}','${kind}','${id}','${creator}')`);
    await insertChosen('account', 'same-id');
    await insertChosen('teamGroup', 'same-id');
    await expect(insertChosen('account', 'same-id')).rejects.toThrow();
    await expect(insertChosen('team', 'wrong-kind')).rejects.toThrow();
    await expect(insertChosen('account', 'missing-environment', 'missing')).rejects.toThrow();
    await expect(insertChosen('account', 'missing-creator', 'environment', 'missing')).rejects.toThrow();
    const chosenRows = await db.query(`SELECT * FROM ${q('DeploymentEnvironmentDeployer')} ORDER BY ${q('principalKind')}`);
    expect(chosenRows.map(row => ({ principalKind: row.principalKind, principalId: row.principalId, createdByAccountId: row.createdByAccountId })))
        .toEqual([{ principalKind: 'account', principalId: 'same-id', createdByAccountId: 'owner' },
            { principalKind: 'teamGroup', principalId: 'same-id', createdByAccountId: 'owner' }]);
    const chosenLedger = await db.query('SELECT migration_name,checksum FROM _prisma_migrations ORDER BY migration_name');
    expect(chosenLedger.filter(row => row.migration_name !== chosenMigration)).toEqual(pendingLedger);
    expect(await readDeploymentS0Custody(provider, db)).toEqual(beforePending);
    await deploy();
    expect(await db.query(`SELECT * FROM ${q('DeploymentEnvironmentDeployer')} ORDER BY ${q('principalKind')}`)).toEqual(chosenRows);
    expect(await db.query('SELECT migration_name,checksum FROM _prisma_migrations ORDER BY migration_name')).toEqual(chosenLedger);
    const beforeCapture = await readDeploymentS0Custody(provider, db);
    await mkdir(join(stage, 'migrations', deploymentAcceptedExecutionMigration), { recursive: true });
    await copyFile(join(root(provider), 'migrations', deploymentAcceptedExecutionMigration, 'migration.sql'),
        join(stage, 'migrations', deploymentAcceptedExecutionMigration, 'migration.sql'));
    await deploy();
    await assertDeploymentAcceptedExecutionUpgrade(provider, db);
    expect(await readDeploymentS0Custody(provider, db)).toEqual(beforeCapture);
    const captureLedger = await db.query('SELECT migration_name,checksum FROM _prisma_migrations ORDER BY migration_name');
    expect(captureLedger.filter(row => row.migration_name !== deploymentAcceptedExecutionMigration)).toEqual(chosenLedger);
    await deploy();
    expect(await readDeploymentS0Custody(provider, db)).toEqual(beforeCapture);
    expect(await db.query('SELECT migration_name,checksum FROM _prisma_migrations ORDER BY migration_name')).toEqual(captureLedger);

    const domainSql = await readFile(join(root(provider), 'migrations', deploymentDomainMigration, 'migration.sql'), 'utf8')
        .catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
    if (domainSql !== null) {
        await mkdir(join(stage, 'migrations', deploymentDomainMigration), { recursive: true });
        await writeFile(join(stage, 'migrations', deploymentDomainMigration, 'migration.sql'), domainSql);
    }
    await deploy();
    const domains = await assertDeploymentDomainStorage(provider, db);
    expect(domains).toHaveLength(6);
    const domainLedger = await db.query('SELECT migration_name,checksum FROM _prisma_migrations ORDER BY migration_name');
    expect(domainLedger.filter(row => row.migration_name !== deploymentDomainMigration)).toEqual(captureLedger);
    expect(await readDeploymentS0Custody(provider, db)).toEqual(beforeCapture);
    await deploy();
    expect(await db.query(`SELECT * FROM ${q('DeploymentDomain')} ORDER BY ${q('id')}`)).toEqual(domains);
    expect(await db.query('SELECT migration_name,checksum FROM _prisma_migrations ORDER BY migration_name')).toEqual(domainLedger);
    expect(await readDeploymentS0Custody(provider, db)).toEqual(beforeCapture);
}

describe('deployment target identity canonical migration deployment', () => {
    it('upgrades S0 rows through the light SQLite migration owner and deploys twice without changing custody', async () => {
        const stage = await mkdtemp(join(tmpdir(), 'happier-deployment-identity-sqlite-'));
        const path = join(stage, 'contract.sqlite');
        const sqlite = new DatabaseSync(path);
        const db = { execute: async (sql: string) => sqlite.exec(sql), query: async (sql: string) => sqlite.prepare(sql).all() };
        try {
            sqlite.exec('PRAGMA foreign_keys=ON');
            await stageS0('sqlite', stage);
            await proveWidening('sqlite', stage, db, () => applySqliteMigrations({ databasePath: path, migrationsDir: join(stage, 'migrations') }));
            expect(await db.query('PRAGMA foreign_key_check')).toEqual([]);
            expect(await db.query('PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }]);
        } finally { sqlite.close(); await rm(stage, { recursive: true, force: true }); }
    }, 120_000);

    for (const provider of ['postgres', 'mysql'] as const) {
        const databaseUrl = process.env[provider === 'postgres' ? 'HAPPIER_TEST_POSTGRES_DATABASE_URL' : 'HAPPIER_TEST_MYSQL_DATABASE_URL'];
        (databaseUrl ? it : it.skip)(`upgrades S0 rows and preserves constraints through native ${provider} deploys`, async () => {
            const stage = await mkdtemp(join(tmpdir(), `happier-deployment-identity-${provider}-`));
            const name = `deployment_identity_${randomUUID().replaceAll('-', '')}`;
            const Client = provider === 'postgres' ? PostgresClient : MysqlClient;
            const admin = new Client({ datasourceUrl: databaseUrl });
            const scoped = new URL(databaseUrl!);
            if (provider === 'postgres') scoped.searchParams.set('schema', name); else scoped.pathname = `/${name}`;
            const client = new Client({ datasourceUrl: scoped.toString() });
            const db: DeploymentMigrationDatabase = { execute: sql => client.$executeRawUnsafe(sql),
                query: sql => client.$queryRawUnsafe<Record<string, unknown>[]>(sql) };
            let created = false;
            try {
                await admin.$executeRawUnsafe(provider === 'postgres' ? `CREATE SCHEMA "${name}"`
                    : `CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
                created = true;
                await stageS0(provider, stage);
                await proveWidening(provider, stage, db, () => runPrismaCli({ serverRoot,
                    args: ['migrate', 'deploy', '--schema', join(stage, 'schema.prisma')],
                    env: { ...process.env, DATABASE_URL: scoped.toString(), HAPPIER_DB_PROVIDER: provider }, quiet: true }));
            } finally {
                await client.$disconnect();
                if (created) await admin.$executeRawUnsafe(provider === 'postgres' ? `DROP SCHEMA "${name}" CASCADE` : `DROP DATABASE \`${name}\``);
                await admin.$disconnect();
                await rm(stage, { recursive: true, force: true });
            }
        }, 120_000);
    }
});
