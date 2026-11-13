import { randomUUID } from 'node:crypto';
import { copyFile, cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PrismaClient as PostgresClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { encodeSessionTeamCredentialSlotKeyV1 } from '@happier-dev/protocol/teams/credentials/sessionBindingIntentV1';
import { PrismaClient as MysqlClient } from '../../generated/mysql-client/index.js';
import { readTeamCredentialAllowedRoutes, readTeamCredentialDeliveryConfiguration } from '../../sources/app/teams/credentials/resourceDeliveryRead';
import { applySqliteMigrations } from '../prismaMigrations';
import { runPrismaCli } from '../prismaCli';
import { readTeamCredentialDeliveryMigrationSql, teamCredentialDeliveryMigrationId, type TeamCredentialMigrationProvider } from './teamCredentialDeliveryMigration.testkit';

const serverRoot = join(import.meta.dirname, '../..');
interface Database {
    execute(sql: string): Promise<unknown>;
    query(sql: string): Promise<Record<string, unknown>[]>;
}

async function stageLegacy(provider: TeamCredentialMigrationProvider, stage: string) {
    const root = join(serverRoot, 'prisma', ...(provider === 'postgres' ? [] : [provider]));
    await mkdir(join(stage, 'migrations'), { recursive: true });
    await copyFile(join(root, 'schema.prisma'), join(stage, 'schema.prisma'));
    await copyFile(join(root, 'migrations/migration_lock.toml'), join(stage, 'migrations/migration_lock.toml'));
    for (const entry of await readdir(join(root, 'migrations'), { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name <= '20260907010000_add_team_credential_recipient_material') {
            await cp(join(root, 'migrations', entry.name), join(stage, 'migrations', entry.name), { recursive: true });
        }
    }
}

async function proveMigration(provider: TeamCredentialMigrationProvider, stage: string, db: Database, deploy: () => Promise<unknown>) {
    const q = (name: string) => provider === 'mysql' ? `\`${name}\`` : `"${name}"`;
    const now = provider === 'mysql' ? 'CURRENT_TIMESTAMP(3)' : 'CURRENT_TIMESTAMP';
    const bytes = provider === 'postgres' ? "decode('010203','hex')" : "X'010203'";
    const slotHex = Buffer.from(encodeSessionTeamCredentialSlotKeyV1({ kind: 'provider_model' })).toString('hex');
    const slotBytes = provider === 'postgres' ? `decode('${slotHex}','hex')` : `X'${slotHex}'`;
    const sourceBindingJson = JSON.stringify({ v: 1, kind: 'provider_connection', connectionId: 'preserved-connection',
        connectionSecurityFingerprint: `connection-security:v1:${'c'.repeat(43)}`, credentialSlotId: 'apiKey' });
    await stageLegacy(provider, stage);
    await deploy();
    await db.execute(`INSERT INTO ${q('Account')} (${q('id')},${q('publicKey')},${q('updatedAt')}) VALUES ('custodian','custodian',${now}),('member','member',${now})`);
    await db.execute(`INSERT INTO ${q('Team')} (${q('id')},${q('name')},${q('updatedAt')}) VALUES ('team','Team',${now})`);
    await db.execute(`INSERT INTO ${q('TeamMembership')} (${q('id')},${q('teamId')},${q('accountId')},${q('role')}) VALUES ('membership','team','member','member')`);
    await db.execute(`INSERT INTO ${q('TeamGroup')} (${q('id')},${q('teamId')},${q('name')},${q('nameKey')},${q('updatedAt')}) VALUES ('group','team','Group','group',${now})`);
    await db.execute(`INSERT INTO ${q('Session')} (${q('id')},${q('tag')},${q('accountId')},${q('metadata')},${q('updatedAt')}) VALUES ('session','session','member','{}',${now})`);
    const cases = [
        { id: 'disabled', ceiling: 'direct_allowed', audience: 'NULL', enabled: false },
        { id: 'empty', ceiling: 'direct_allowed', audience: 'NULL', enabled: true },
        { id: 'broker-audience', ceiling: 'direct_allowed', audience: "'brokered'", enabled: true },
        { id: 'both', ceiling: 'direct_allowed', audience: "'both'", enabled: true },
        { id: 'direct-only', ceiling: 'direct_allowed', audience: "'direct'", enabled: true },
        { id: 'broker-only', ceiling: 'brokered_only', audience: "'brokered'", enabled: true },
    ];
    for (const c of cases) {
        await db.execute(`INSERT INTO ${q('TeamCredentialResource')} (${['id','teamId','custodianAccountId','displayName','enabled','revision','disclosureCeiling','sessionUsePolicy','sourceBindingJson','directSourceVersionsJson','allMembersDeliveryMode','updatedAt'].map(q).join(',')}) VALUES ('${c.id}','team','custodian','Shared',${c.enabled ? 'true' : 'false'},7,'${c.ceiling}','personal_allowed','${sourceBindingJson}','{"source":"v7"}',${c.audience},${now})`);
    }
    await db.execute(`INSERT INTO ${q('TeamCredentialGroupGrant')} (${['resourceId','teamGroupId','deliveryMode','updatedAt'].map(q).join(',')}) VALUES ('direct-only','group','direct',${now}),('both','group','both',${now})`);
    await db.execute(`INSERT INTO ${q('TeamCredentialMemberGrant')} (${['resourceId','teamMembershipId','deliveryMode','updatedAt'].map(q).join(',')}) VALUES ('direct-only','membership','direct',${now}),('broker-only','membership','brokered',${now})`);
    await db.execute(`INSERT INTO ${q('SessionTeamCredentialBinding')} (${['sessionId','slotKind','slotKey','resourceId','resourceRevision','updatedAt'].map(q).join(',')}) VALUES ('session','provider_model:direct',${slotBytes},'direct-only',7,${now})`);
    await db.execute(`INSERT INTO ${q('TeamCredentialRecipientMaterial')} (${['id','resourceId','recipientAccountId','sourceMemberKey','sourceVersion','recipientMode','storedMaterial','updatedAt'].map(q).join(',')}) VALUES ('material','direct-only','member','${'a'.repeat(43)}','v7','plain',${bytes},${now})`);
    const stableSelect = `SELECT ${['id','enabled','revision','sourceBindingJson','directSourceVersionsJson','brokerMachineId'].map(q).join(',')} FROM ${q('TeamCredentialResource')} ORDER BY ${q('id')}`;
    const before = await db.query(stableSelect);
    const bindingColumns = ['sessionId','slotKind','slotKey','resourceId','resourceRevision','createdAt','updatedAt'];
    const bindings = await db.query(`SELECT ${bindingColumns.map(q).join(',')} FROM ${q('SessionTeamCredentialBinding')}`);
    const material = await db.query(`SELECT * FROM ${q('TeamCredentialRecipientMaterial')}`);
    // Current readers must accept legacy rows before deployment, so the schema
    // migration can land only after this tolerant read boundary is available.
    for (const row of await db.query(`SELECT ${['id','disclosureCeiling','allMembersDeliveryMode'].map(q).join(',')} FROM ${q('TeamCredentialResource')}`)) {
        expect(readTeamCredentialDeliveryConfiguration(String(row.disclosureCeiling))).toEqual({
            success: true, data: { policy: { preferredAllowedModes: row.id === 'broker-only' ? ['brokered'] : ['brokered','direct'] } },
        });
        if (row.allMembersDeliveryMode !== null) {
            expect(readTeamCredentialAllowedRoutes(String(row.allMembersDeliveryMode))).toEqual({ success: true,
                data: row.id === 'direct-only' ? ['direct'] : row.id === 'both' ? ['brokered','direct'] : ['brokered'] });
        }
    }
    for (const table of ['TeamCredentialGroupGrant','TeamCredentialMemberGrant']) {
        for (const row of await db.query(`SELECT ${q('resourceId')},${q('deliveryMode')} FROM ${q(table)}`)) {
            expect(readTeamCredentialAllowedRoutes(String(row.deliveryMode))).toEqual({ success: true,
                data: row.resourceId === 'direct-only' ? ['direct'] : row.resourceId === 'both' ? ['brokered','direct'] : ['brokered'] });
        }
    }
    await mkdir(join(stage, 'migrations', teamCredentialDeliveryMigrationId));
    await writeFile(join(stage, 'migrations', teamCredentialDeliveryMigrationId, 'migration.sql'), await readTeamCredentialDeliveryMigrationSql(provider));
    await deploy();
    expect(await db.query(stableSelect)).toEqual(before);
    expect(await db.query(`SELECT * FROM ${q('TeamCredentialRecipientMaterial')}`)).toEqual(material);
    expect(await db.query(`SELECT ${[...bindingColumns,'nativeManagedId','nativeDeliveryJson'].map(q).join(',')} FROM ${q('SessionTeamCredentialBinding')}`)).toEqual(bindings.map(row => ({ ...row, nativeManagedId: null, nativeDeliveryJson: null })));
    for (const row of await db.query(`SELECT ${['id','disclosureCeiling','allMembersDeliveryMode'].map(q).join(',')} FROM ${q('TeamCredentialResource')}`)) {
        const expectedModes = row.id === 'broker-only' ? ['brokered'] : ['brokered', 'direct'];
        const normalized = { policy: { preferredAllowedModes: expectedModes } };
        expect(JSON.parse(String(row.disclosureCeiling))).toEqual({ ...normalized, experimentalBindingConfirmations: [] });
        expect(readTeamCredentialDeliveryConfiguration(String(row.disclosureCeiling))).toEqual({ success: true, data: normalized });
        const audience = row.id === 'disabled' || row.id === 'empty' ? null : row.id === 'both' ? ['brokered','direct'] : row.id === 'direct-only' ? ['direct'] : ['brokered'];
        expect(row.allMembersDeliveryMode === null ? null : JSON.parse(String(row.allMembersDeliveryMode))).toEqual(audience);
        if (audience !== null) expect(readTeamCredentialAllowedRoutes(String(row.allMembersDeliveryMode))).toEqual({ success: true, data: audience });
    }
    for (const table of ['TeamCredentialGroupGrant','TeamCredentialMemberGrant']) {
        for (const row of await db.query(`SELECT ${q('resourceId')},${q('deliveryMode')} FROM ${q(table)}`)) {
            const expected = row.resourceId === 'direct-only' ? ['direct'] : row.resourceId === 'both' ? ['brokered','direct'] : ['brokered'];
            expect(JSON.parse(String(row.deliveryMode))).toEqual(expected);
            expect(readTeamCredentialAllowedRoutes(String(row.deliveryMode))).toEqual({ success: true, data: expected });
        }
    }
    const ledger = await db.query('SELECT migration_name,checksum FROM _prisma_migrations ORDER BY migration_name');
    await deploy();
    expect(await db.query('SELECT migration_name,checksum FROM _prisma_migrations ORDER BY migration_name')).toEqual(ledger);
    expect(await db.query(stableSelect)).toEqual(before);
    if (provider === 'mysql') {
        const large = JSON.stringify({ policy: { preferredAllowedModes: ['brokered','direct'] }, experimentalBindingConfirmations: [], evidence: 'x'.repeat(2048) });
        await db.execute(`UPDATE ${q('TeamCredentialResource')} SET ${q('disclosureCeiling')}='${large}' WHERE ${q('id')}='empty'`);
        expect(await db.query(`SELECT ${q('disclosureCeiling')} FROM ${q('TeamCredentialResource')} WHERE ${q('id')}='empty'`)).toEqual([{ disclosureCeiling: large }]);
    }
}

describe('Team credential normalized delivery canonical migration', () => {
    it('preserves dormant consent, narrow audiences and existing material on real SQLite', async () => {
        const stage = await mkdtemp(join(tmpdir(), 'happier-team-delivery-sqlite-'));
        const path = join(stage, 'contract.sqlite');
        const sqlite = new DatabaseSync(path);
        const db: Database = { execute: async sql => sqlite.exec(sql), query: async sql => sqlite.prepare(sql).all() };
        try {
            await proveMigration('sqlite', stage, db, () => applySqliteMigrations({ databasePath: path, migrationsDir: join(stage, 'migrations') }));
            expect(await db.query('PRAGMA foreign_key_check')).toEqual([]);
            expect(await db.query('PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }]);
        } finally { sqlite.close(); await rm(stage, { recursive: true, force: true }); }
    }, 120_000);

    for (const provider of ['postgres','mysql'] as const) {
        const databaseUrl = process.env[provider === 'postgres' ? 'HAPPIER_TEST_POSTGRES_DATABASE_URL' : 'HAPPIER_TEST_MYSQL_DATABASE_URL'];
        (databaseUrl ? it : it.skip)(`preserves legacy rows and deploy replay on real ${provider}`, async () => {
            const stage = await mkdtemp(join(tmpdir(), `happier-team-delivery-${provider}-`));
            const name = `team_delivery_${randomUUID().replaceAll('-', '')}`;
            const Client = provider === 'postgres' ? PostgresClient : MysqlClient;
            const admin = new Client({ datasourceUrl: databaseUrl });
            const scoped = new URL(databaseUrl!);
            if (provider === 'postgres') scoped.searchParams.set('schema', name); else scoped.pathname = `/${name}`;
            const client = new Client({ datasourceUrl: scoped.toString() });
            const db: Database = { execute: sql => client.$executeRawUnsafe(sql), query: sql => client.$queryRawUnsafe<Record<string, unknown>[]>(sql) };
            let created = false;
            try {
                await admin.$executeRawUnsafe(provider === 'postgres' ? `CREATE SCHEMA "${name}"` : `CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
                created = true;
                await proveMigration(provider, stage, db, () => runPrismaCli({ serverRoot, args: ['migrate','deploy','--schema',join(stage,'schema.prisma')], env: { ...process.env, DATABASE_URL: scoped.toString(), HAPPIER_DB_PROVIDER: provider }, quiet: true }));
            } finally {
                await client.$disconnect();
                if (created) await admin.$executeRawUnsafe(provider === 'postgres' ? `DROP SCHEMA "${name}" CASCADE` : `DROP DATABASE \`${name}\``);
                await admin.$disconnect();
                await rm(stage, { recursive: true, force: true });
            }
        }, 120_000);
    }
});
