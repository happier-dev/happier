import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import {
    createQualifiedConnectedAccountGroupDigest,
    createQualifiedConnectedAccountIdentityDigest,
} from '../../sources/app/api/routes/connect/qualifiedConnectedAccounts/identity';
import {
    qualifiedConnectedAccountsV4PreparationDirective,
} from '../../sources/flavors/light/qualifiedConnectedAccountsV4SqliteMigration';
import {
    applySqliteMigrations,
    type SqliteMigrationExecutor,
} from '../../sources/flavors/light/sqliteMigrations';

const serverRoot = join(import.meta.dirname, '..', '..');
const activationMigrationName =
    '20260725100000_activate_qualified_connected_accounts_v4';
const SERVER_V021_CREDENTIAL_VECTORS = {
    'openai-codex': {
        service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
        serviceDigest: 'a8d53eff624b4a3b71570b0367fc4738a8ea4dc5f3018bbc501f281dad087bea',
        identityDigest: 'e322e4ed7ad719f14b6656dfe428decaf5dc9674bdbc165c797d3977ceb7d6e6',
        defaultAuthenticationModeId: 'oauth',
        authenticationModeByCredentialKind: { oauth: 'oauth' },
    },
    openai: {
        service: { pluginId: 'happier.voice.openai', localId: 'openai' },
        serviceDigest: 'ec3a0fd63cbee7f50c3e2977fc882d6183379e6392b5d51b3efa390cc53f7c9b',
        identityDigest: '83b9efc38d3798baec60a90bc6fdaf887ce992e737f4687d89c72acd6ec0107b',
        defaultAuthenticationModeId: 'api-key',
        authenticationModeByCredentialKind: { token: 'api-key' },
    },
    anthropic: {
        service: { pluginId: 'happier.agent.claude', localId: 'anthropic' },
        serviceDigest: '749d2df955d1d61572285abffa1d2324101c1433c355946eba65bb121a63987a',
        identityDigest: 'c5cf52f28c8133be6d08824ce720e369df6330c6aa490ddbc113be37a04b711e',
        defaultAuthenticationModeId: 'api-key',
        authenticationModeByCredentialKind: { token: 'api-key' },
    },
    'claude-subscription': {
        service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' },
        serviceDigest: '40a8a0ad2615b95f046a13632ac3d0aae5da32ef634dd11053ecad6e1884675e',
        identityDigest: '5665eb4390f0b796be2e655e455e123a9197003b03151b396fab5f6cb6d3d9db',
        defaultAuthenticationModeId: 'setup-token',
        authenticationModeByCredentialKind: { oauth: 'oauth', token: 'setup-token' },
    },
    gemini: {
        service: { pluginId: 'happier.agent.gemini', localId: 'gemini-account' },
        serviceDigest: '38b3ec1a4e87b7ce2a5bd41838eb0e5155170df35d937709d8db4836442f9e23',
        identityDigest: '540236a992365b18e9c560fa281852a5a70e42a4c76c77ed7be460ac0a6f1f86',
        defaultAuthenticationModeId: 'api-key',
        authenticationModeByCredentialKind: {
            oauth: 'legacy-oauth-unsupported',
            token: 'api-key',
        },
    },
} as const;
const PROSPECTIVE_REMOTE_CREDENTIAL_VECTORS = {
    github: {
        service: { pluginId: 'happier.scm.forge.github', localId: 'github-account' },
        serviceDigest: 'bafdd80f57f752d0867fef33b99a3750286f07a2c2dc4896c3b7f7bb7c707ebd',
        identityDigest: '84d661cc1ac10b954399ffb8a470834a35cda24a5d4c579262efccd41a4ebf68',
        defaultAuthenticationModeId: 'fine-grained-pat',
        authenticationModeByCredentialKind: { token: 'fine-grained-pat' },
    },
} as const;
const DEV_PREACTIVATION_CREDENTIAL_VECTORS = {
    bitbucket: {
        service: { pluginId: 'happier.scm.forge.bitbucket', localId: 'bitbucket-account' },
        serviceDigest: '4b276e5f5b66a036ede597b0926d7f7991772bfe891698b76fd7be0e52fa2616',
        identityDigest: '6b07d92ad31e3b77c5cf2988646293dee2d378bf7230ec02d17afb839fbf67da',
        defaultAuthenticationModeId: 'manual',
        authenticationModeByCredentialKind: { token: 'manual' },
    },
} as const;
const FROZEN_ACTIVATION_CREDENTIAL_VECTORS = {
    ...SERVER_V021_CREDENTIAL_VECTORS,
    ...PROSPECTIVE_REMOTE_CREDENTIAL_VECTORS,
    ...DEV_PREACTIVATION_CREDENTIAL_VECTORS,
} as const;
type FrozenCredentialId = keyof typeof FROZEN_ACTIVATION_CREDENTIAL_VECTORS;
const schemaPaths = [
    'prisma/schema.prisma',
    'prisma/mysql/schema.prisma',
    'prisma/sqlite/schema.prisma',
] as const;

async function read(relativePath: string): Promise<string> {
    return await readFile(join(serverRoot, relativePath), 'utf8');
}

function model(schema: string, name: string): string {
    const match = schema.match(new RegExp(`^model ${name} \\{[\\s\\S]*?^\\}`, 'm'));
    if (!match) throw new Error(`Missing Prisma model ${name}`);
    return match[0];
}

function serviceDigest(pluginId: string, localId: string): string {
    return createHash('sha256')
        .update(JSON.stringify(['service', pluginId, localId]))
        .digest('hex');
}

function identityDigest(
    kind: 'account' | 'group',
    pluginId: string,
    localId: string,
    localIdentity: string,
): string {
    const service = { pluginId, localId };
    return kind === 'account'
        ? createQualifiedConnectedAccountIdentityDigest({
            service,
            accountId: localIdentity,
        })
        : createQualifiedConnectedAccountGroupDigest({
            service,
            groupId: localIdentity,
        });
}

function expectedLegacyAuthenticationMode(
    legacyServiceId: FrozenCredentialId,
    credentialKind?: 'oauth' | 'token' | null,
): string {
    const vector = FROZEN_ACTIVATION_CREDENTIAL_VECTORS[legacyServiceId];
    if (!credentialKind) return vector.defaultAuthenticationModeId;
    const authenticationModeId = (
        vector.authenticationModeByCredentialKind as Partial<
            Record<'oauth' | 'token', string>
        >
    )[credentialKind];
    if (!authenticationModeId) {
        throw new Error(`Unsupported ${legacyServiceId} ${credentialKind} vector`);
    }
    return authenticationModeId;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripSqlComments(sql: string): string {
    return sql
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/--[^\r\n]*/g, '');
}

function createPreparedCredentialDatabase(): DatabaseSync {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys=ON');
    db.exec(`
        CREATE TABLE "Account" (
            "id" TEXT NOT NULL PRIMARY KEY
        );
        CREATE TABLE "ConnectedServiceAuthGroup" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "accountId" TEXT NOT NULL,
            "vendor" TEXT NOT NULL,
            "groupId" TEXT NOT NULL,
            "displayName" TEXT,
            "policyJson" TEXT NOT NULL,
            "activeProfileId" TEXT,
            "generation" INTEGER NOT NULL DEFAULT 0,
            "runtimeStateRevision" INTEGER NOT NULL DEFAULT 0,
            "stateJson" TEXT,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" DATETIME NOT NULL,
            CONSTRAINT "ConnectedServiceAuthGroup_accountId_fkey"
                FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
        );
        CREATE UNIQUE INDEX "ConnectedServiceAuthGroup_accountId_vendor_groupId_key"
            ON "ConnectedServiceAuthGroup"("accountId", "vendor", "groupId");
        CREATE INDEX "ConnectedServiceAuthGroup_accountId_vendor_idx"
            ON "ConnectedServiceAuthGroup"("accountId", "vendor");
        CREATE TABLE "ServiceAccountToken" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "accountId" TEXT NOT NULL,
            "vendor" TEXT NOT NULL,
            "token" BLOB NOT NULL,
            "metadata" JSONB,
            "lastUsedAt" DATETIME,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" DATETIME NOT NULL,
            "profileId" TEXT NOT NULL DEFAULT 'default',
            "expiresAt" DATETIME,
            "refreshLeaseOwnerMachineId" TEXT,
            "refreshLeaseExpiresAt" DATETIME,
            CONSTRAINT "ServiceAccountToken_accountId_fkey"
                FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
        );
        CREATE INDEX "ServiceAccountToken_accountId_idx"
            ON "ServiceAccountToken"("accountId");
        CREATE UNIQUE INDEX "ServiceAccountToken_accountId_vendor_profileId_key"
            ON "ServiceAccountToken"("accountId", "vendor", "profileId");
        CREATE TABLE "ConnectedServiceAuthGroupMember" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "groupDbId" TEXT NOT NULL,
            "accountId" TEXT NOT NULL,
            "vendor" TEXT NOT NULL,
            "groupId" TEXT NOT NULL,
            "profileId" TEXT NOT NULL,
            "priority" INTEGER NOT NULL DEFAULT 100,
            "enabled" BOOLEAN NOT NULL DEFAULT true,
            "stateJson" TEXT,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" DATETIME NOT NULL,
            CONSTRAINT "ConnectedServiceAuthGroupMember_groupDbId_fkey"
                FOREIGN KEY ("groupDbId") REFERENCES "ConnectedServiceAuthGroup" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
            CONSTRAINT "ConnectedServiceAuthGroupMember_accountId_vendor_profileId_fkey"
                FOREIGN KEY ("accountId", "vendor", "profileId") REFERENCES "ServiceAccountToken" ("accountId", "vendor", "profileId") ON DELETE CASCADE ON UPDATE CASCADE
        );
        CREATE UNIQUE INDEX "csagm_account_vendor_group_profile_key"
            ON "ConnectedServiceAuthGroupMember"("accountId", "vendor", "groupId", "profileId");
        CREATE INDEX "ConnectedServiceAuthGroupMember_groupDbId_idx"
            ON "ConnectedServiceAuthGroupMember"("groupDbId");
        CREATE INDEX "ConnectedServiceAuthGroupMember_accountId_vendor_profileId_idx"
            ON "ConnectedServiceAuthGroupMember"("accountId", "vendor", "profileId");
        CREATE TABLE "ProviderAccountUsageRecord" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "accountId" TEXT NOT NULL,
            "providerId" TEXT NOT NULL,
            "recordId" TEXT NOT NULL,
            "accountSubjectId" TEXT NOT NULL,
            "subjectKind" TEXT NOT NULL,
            "quotaScope" TEXT NOT NULL,
            "quotaScopeId" TEXT,
            "quotaScopeIdKey" TEXT NOT NULL,
            "recordKeyJson" JSONB NOT NULL,
            "payloadMode" TEXT NOT NULL,
            "status" TEXT NOT NULL,
            "snapshot" JSONB,
            "sealedPayload" JSONB,
            "fetchedAt" DATETIME,
            "staleAfterMs" INTEGER,
            "refreshRequestedAt" DATETIME,
            "metadata" JSONB,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" DATETIME NOT NULL,
            CONSTRAINT "ProviderAccountUsageRecord_accountId_fkey"
                FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
        );
        CREATE UNIQUE INDEX "ProviderAccountUsageRecord_accountId_recordId_key"
            ON "ProviderAccountUsageRecord"("accountId", "recordId");
        CREATE TABLE "ConnectedServiceUsageSource" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "accountId" TEXT NOT NULL,
            "serviceId" TEXT NOT NULL,
            "profileId" TEXT NOT NULL,
            "sourceKey" TEXT NOT NULL,
            "providerAccountUsageRecordId" TEXT NOT NULL,
            "bindingKind" TEXT NOT NULL,
            "groupId" TEXT,
            "groupGeneration" INTEGER,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" DATETIME NOT NULL,
            CONSTRAINT "csus_record_fkey"
                FOREIGN KEY ("accountId", "providerAccountUsageRecordId")
                REFERENCES "ProviderAccountUsageRecord" ("accountId", "recordId")
                ON DELETE CASCADE ON UPDATE CASCADE
        );
        CREATE UNIQUE INDEX "ConnectedServiceUsageSource_accountId_sourceKey_key"
            ON "ConnectedServiceUsageSource"("accountId", "sourceKey");
        CREATE INDEX "csus_account_service_profile_idx"
            ON "ConnectedServiceUsageSource"("accountId", "serviceId", "profileId");
        CREATE INDEX "csus_record_idx"
            ON "ConnectedServiceUsageSource"("accountId", "providerAccountUsageRecordId");
    `);
    return db;
}

async function applyMigration(db: DatabaseSync, sql: string): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), 'qualified-connected-accounts-v4-'));
    const migrationDir = join(root, activationMigrationName);
    try {
        await mkdir(migrationDir, { recursive: true });
        await writeFile(join(migrationDir, 'migration.sql'), sql, 'utf8');
        const executor: SqliteMigrationExecutor = {
            exec: (statement) => {
                db.exec(statement);
            },
            queryRows: (statement, params = []) =>
                db.prepare(statement).all(...params),
            run: (statement, params = []) => {
                db.prepare(statement).run(...params);
            },
            queryTableNames: () => new Set(
                db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
                    .all()
                    .map((row) => String((row as { name: unknown }).name)),
            ),
            queryAppliedMigrations: () => db.prepare(`
                SELECT migration_name AS name, checksum
                FROM _prisma_migrations
                WHERE rolled_back_at IS NULL AND finished_at IS NOT NULL
            `).all() as Array<{ name: string; checksum: string }>,
            insertAppliedMigration: ({ name, checksum }) => {
                db.prepare(`
                    INSERT INTO _prisma_migrations (
                        id, checksum, finished_at, migration_name, applied_steps_count
                    ) VALUES (?, ?, CURRENT_TIMESTAMP, ?, 1)
                `).run(randomUUID(), checksum, name);
            },
        };
        await applySqliteMigrations({ executor, migrationsDir: root });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

function expectActivationColumnsAbsent(db: DatabaseSync): void {
    expect(db.prepare(`
        SELECT "name"
        FROM pragma_table_info('ServiceAccountToken')
        WHERE "name" = 'qualified_identity_digest'
    `).all()).toEqual([]);
    expect(db.prepare(`
        SELECT "name"
        FROM pragma_table_info('ConnectedServiceAuthGroup')
        WHERE "name" = 'qualified_group_digest'
    `).all()).toEqual([]);
}

describe('qualified Connected Accounts V4 storage contract', () => {
    it.each(schemaPaths)('keeps qualified identity and account configuration on canonical rows: %s', async (schemaPath) => {
        const schema = await read(schemaPath);
        const credential = model(schema, 'ServiceAccountToken');
        expect(credential).toMatch(/servicePluginId\s+String(?:\s|@)/);
        expect(credential).toMatch(/serviceLocalId\s+String(?:\s|@)/);
        expect(credential).toMatch(/qualifiedServiceDigest\s+String(?:\s|@)/);
        expect(credential).toMatch(/connectedAccountId\s+String(?:\s|@)/);
        expect(credential).toMatch(/qualifiedIdentityDigest\s+String(?:\s|@)/);
        expect(credential).toMatch(/authenticationModeId\s+String(?:\s|@)/);
        expect(credential).toMatch(/configurationRevision\s+String\?/);
        expect(credential).toMatch(/configurationContent\s+Bytes\?/);
        expect(credential).toMatch(/vendor\s+String\?/);
        expect(credential).toMatch(/profileId\s+String\?/);
        expect(credential).toContain('@@unique([accountId, qualifiedIdentityDigest]');

        const group = model(schema, 'ConnectedServiceAuthGroup');
        expect(group).toMatch(/servicePluginId\s+String(?:\s|@)/);
        expect(group).toMatch(/serviceLocalId\s+String(?:\s|@)/);
        expect(group).toMatch(/qualifiedServiceDigest\s+String(?:\s|@)/);
        expect(group).toMatch(/qualifiedGroupDigest\s+String(?:\s|@)/);
        expect(group).toMatch(/activeConnectedAccountId\s+String\?/);
        expect(group).toMatch(/vendor\s+String\?/);
        expect(group).toContain('@@unique([accountId, qualifiedGroupDigest]');

        const member = model(schema, 'ConnectedServiceAuthGroupMember');
        expect(member).toMatch(/credentialId\s+String/);
        expect(member).toMatch(/qualifiedServiceDigest\s+String(?:\s|@)/);
        expect(member).toMatch(/qualifiedGroupDigest\s+String(?:\s|@)/);
        expect(member).toMatch(/qualifiedIdentityDigest\s+String(?:\s|@)/);
        expect(member).toContain('references: [accountId, qualifiedServiceDigest, qualifiedIdentityDigest, id]');
        expect(member).toContain('references: [accountId, qualifiedServiceDigest, qualifiedGroupDigest, id]');
        expect(member).toContain(
            '@@unique([accountId, vendor, groupId, profileId], map: "csagm_account_vendor_group_profile_key")',
        );
        expect(member).toContain('@@unique([groupDbId, credentialId]');

        const usageSource = model(schema, 'ConnectedServiceUsageSource');
        expect(usageSource).toMatch(/servicePluginId\s+String(?:\s|@)/);
        expect(usageSource).toMatch(/serviceLocalId\s+String(?:\s|@)/);
        expect(usageSource).toMatch(/qualifiedServiceDigest\s+String(?:\s|@)/);
        expect(usageSource).toMatch(/connectedAccountId\s+String(?:\s|@)/);
        expect(usageSource).toMatch(/qualifiedIdentityDigest\s+String(?:\s|@)/);
        expect(usageSource).toMatch(/credentialId\s+String/);
        expect(usageSource).toContain('references: [accountId, qualifiedServiceDigest, qualifiedIdentityDigest, id]');

        expect(schema).not.toContain('model QualifiedConnectedAccountProjection');
        expect(schema).not.toContain('QualifiedConnectedAccountProjection QualifiedConnectedAccountProjection[]');
    });

    it.each([
        'prisma/migrations',
        'prisma/mysql/migrations',
        'prisma/sqlite/migrations',
    ] as const)('owns the complete qualified-account activation in one final migration: %s', async (migrationRoot) => {
        const activate = stripSqlComments(
            await read(`${migrationRoot}/${activationMigrationName}/migration.sql`),
        );

        expect(activate).toMatch(/ServiceAccountToken/);
        expect(activate).toContain('configuration_content');
        expect(activate).toMatch(/vendor[\s\S]*null/i);
        expect(activate).toMatch(/profileId[\s\S]*null/i);
        for (const field of [
            'service_plugin_id',
            'service_local_id',
            'qualified_service_digest',
            'connected_account_id',
            'qualified_identity_digest',
            'authentication_mode_id',
        ]) {
            expect(activate).toContain(field);
        }
        expect(activate).toMatch(/NOT NULL|not null/i);
        expect(activate).toContain('sat_qualified_credential_fkey');
        expect(activate).toContain('ConnectedServiceAuthGroup');
        expect(activate).toContain('ConnectedServiceAuthGroupMember');
        expect(activate).toContain('ConnectedServiceUsageSource');
        expect(activate).toContain('csag_qualified_group_fkey');
        expect(activate).toContain('csagm_group_fkey');
        expect(activate).toContain('csagm_credential_fkey');
        expect(activate).toContain('csus_credential_fkey');

        if (migrationRoot === 'prisma/sqlite/migrations') {
            expect(activate).toContain(
                qualifiedConnectedAccountsV4PreparationDirective,
            );
            expect(activate).not.toMatch(/happier_sha256_hex/i);
        } else {
            expect(activate).toContain('_QualifiedActivationGuard');
            expect(activate).toMatch(
                /LEFT JOIN\s+[`"]_QualifiedLegacyServiceMap[`"][\s\S]+mapping\.[`"]serviceId[`"]\s+IS\s+NULL/i,
            );
            expect(activate).toMatch(
                /(?:kind|\$\.kind)[\s\S]+NOT IN\s*\(\s*'oauth'\s*,\s*'token'\s*\)/i,
            );
            expect(activate.match(/HAVING\s+COUNT\(\*\)\s*>\s*1/gi))
                .toHaveLength(2);
            expect(activate).toMatch(/sha256|sha2/i);
            expect(activate).toMatch(/metadata[\s\S]*(?:kind|\\$\.kind)/i);
            for (const table of [
                'ConnectedServiceAuthGroup',
                'ConnectedServiceAuthGroupMember',
                'ConnectedServiceUsageSource',
            ]) {
                expect(activate).toMatch(new RegExp(
                    `UPDATE\\s+[\`"]${table}[\`"]`,
                    'i',
                ));
            }
            for (const [legacyServiceId, vector] of Object.entries(
                FROZEN_ACTIVATION_CREDENTIAL_VECTORS,
            )) {
                expect(activate).toContain(`'${legacyServiceId}'`);
                expect(activate).toContain(`'${vector.service.pluginId}'`);
                expect(activate).toContain(`'${vector.service.localId}'`);
                expect(activate).toContain(`'${vector.defaultAuthenticationModeId}'`);
                for (const authenticationModeId of Object.values(
                    vector.authenticationModeByCredentialKind,
                )) {
                    expect(activate).toContain(authenticationModeId);
                }
                expect(vector.serviceDigest).toBe(serviceDigest(
                    vector.service.pluginId,
                    vector.service.localId,
                ));
                expect(activate).toContain(vector.serviceDigest);
            }
        }
        expect(Object.keys(FROZEN_ACTIVATION_CREDENTIAL_VECTORS)).toEqual([
            ...Object.keys(SERVER_V021_CREDENTIAL_VECTORS),
            ...Object.keys(PROSPECTIVE_REMOTE_CREDENTIAL_VECTORS),
            ...Object.keys(DEV_PREACTIVATION_CREDENTIAL_VECTORS),
        ]);
    });

    it.each([
        'prisma/migrations',
        'prisma/mysql/migrations',
        'prisma/sqlite/migrations',
    ] as const)(
        'replaces the legacy member credential lookup with the canonical credential-id index: %s',
        async (migrationRoot) => {
            const activate = await read(
                `${migrationRoot}/${activationMigrationName}/migration.sql`,
            );

            expect(activate).toContain(
                'ConnectedServiceAuthGroupMember_credential_id_idx',
            );
            if (migrationRoot === 'prisma/sqlite/migrations') {
                expect(activate).not.toContain(
                    'ConnectedServiceAuthGroupMember_accountId_vendor_profileId_idx',
                );
                return;
            }
            expect(activate).toMatch(
                /DROP INDEX\s+[`"]ConnectedServiceAuthGroupMember_accountId_vendor_profileId_idx[`"]/,
            );
        },
    );

    it('preflights every MySQL legacy-data violation before permanent DDL', async () => {
        const activate = stripSqlComments(
            await read(
                `prisma/mysql/migrations/${activationMigrationName}/migration.sql`,
            ),
        );
        const firstPermanentDdl = activate.search(
            /\b(?:ALTER\s+TABLE|CREATE\s+(?:UNIQUE\s+)?INDEX)\b/i,
        );
        const serviceMapStart = activate.indexOf(
            'CREATE TEMPORARY TABLE `_QualifiedLegacyServiceMap`',
        );
        const guardStart = activate.indexOf(
            'CREATE TEMPORARY TABLE `_QualifiedActivationGuard`',
        );
        const guardEnd = activate.indexOf(
            'DROP TEMPORARY TABLE `_QualifiedActivationGuard`',
            guardStart,
        );

        expect(firstPermanentDdl).toBeGreaterThan(-1);
        expect(serviceMapStart).toBeGreaterThan(-1);
        expect(guardStart).toBeGreaterThan(serviceMapStart);
        expect(guardEnd).toBeGreaterThan(guardStart);
        expect(guardEnd).toBeLessThan(firstPermanentDdl);

        const preflight = activate.slice(serviceMapStart, firstPermanentDdl);
        expect(preflight).toMatch(
            /CREATE TEMPORARY TABLE `_QualifiedLegacyServiceMap`[\s\S]+`serviceId`\s+VARBINARY\(191\)/i,
        );
        expect(preflight).toMatch(
            /mapping\.`serviceId`\s+IS\s+NULL/i,
        );
        expect(preflight).toMatch(
            /(?:kind|\$\.kind)[\s\S]+NOT IN\s*\(\s*'oauth'\s*,\s*'token'\s*\)/i,
        );
        expect(preflight).toContain('mapping.`oauthModeId` IS NULL');
        expect(preflight).toContain('mapping.`tokenModeId` IS NULL');
        expect(preflight).toMatch(
            /auth_group\.`activeProfileId`\s+IS\s+NOT\s+NULL[\s\S]+NOT\s+EXISTS/i,
        );
        expect(preflight).toMatch(
            /LEFT JOIN `ConnectedServiceAuthGroup`[\s\S]+LEFT JOIN `ServiceAccountToken`[\s\S]+auth_group\.`id`\s+IS\s+NULL\s+OR\s+credential\.`id`\s+IS\s+NULL/i,
        );
        expect(preflight).toMatch(
            /FROM `ConnectedServiceUsageSource`[\s\S]+LEFT JOIN `ServiceAccountToken`[\s\S]+WHERE credential\.`id`\s+IS\s+NULL/i,
        );
        expect(preflight.match(/HAVING\s+COUNT\(\*\)\s*>\s*1/gi))
            .toHaveLength(2);
        expect(preflight).toMatch(/SHA2/i);
        for (const statement of preflight.split(';')) {
            expect(
                statement.match(/_QualifiedLegacyServiceMap/g) ?? [],
                'a MySQL statement must not reopen the same temporary map',
            ).toHaveLength(
                statement.includes('_QualifiedLegacyServiceMap') ? 1 : 0,
            );
        }
        for (const expansionColumn of [
            'service_plugin_id',
            'service_local_id',
            'qualified_service_digest',
            'connected_account_id',
            'qualified_identity_digest',
            'authentication_mode_id',
            'credential_id',
        ]) {
            expect(preflight).not.toContain(`\`${expansionColumn}\``);
        }
        expect(activate.slice(firstPermanentDdl))
            .not.toContain('_QualifiedActivationGuard');
    });

    it('compares every MySQL legacy identity relation byte-exactly before activation', async () => {
        const activate = stripSqlComments(
            await read(
                `prisma/mysql/migrations/${activationMigrationName}/migration.sql`,
            ),
        );
        const exactComparisons = [
            ['mapping.`serviceId`', 'credential.`vendor`'],
            ['mapping.`serviceId`', 'auth_group.`vendor`'],
            ['active_member.`groupDbId`', 'auth_group.`id`'],
            ['active_member.`accountId`', 'auth_group.`accountId`'],
            ['active_member.`vendor`', 'auth_group.`vendor`'],
            ['active_member.`groupId`', 'auth_group.`groupId`'],
            ['active_member.`profileId`', 'auth_group.`activeProfileId`'],
            ['auth_group.`id`', 'member.`groupDbId`'],
            ['auth_group.`accountId`', 'member.`accountId`'],
            ['auth_group.`vendor`', 'member.`vendor`'],
            ['auth_group.`groupId`', 'member.`groupId`'],
            ['credential.`accountId`', 'member.`accountId`'],
            ['credential.`vendor`', 'member.`vendor`'],
            ['credential.`profileId`', 'member.`profileId`'],
            ['credential.`accountId`', 'source.`accountId`'],
            ['credential.`vendor`', 'source.`serviceId`'],
            ['credential.`profileId`', 'source.`profileId`'],
        ] as const;

        for (const [left, right] of exactComparisons) {
            const comparison =
                `CAST(${left} AS BINARY) = CAST(${right} AS BINARY)`;
            const rawComparison = new RegExp(
                `${left.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*`
                + right.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
                'i',
            );
            expect(
                activate,
                `${left} and ${right} must reject case and trailing-space variants`,
            ).toContain(comparison);
            expect(activate).not.toMatch(rawComparison);
        }
    });

    it('upgrades exact 0.2.1 legacy credential rows and admits a novel qualified credential on SQLite', async () => {
        const activation = await read(
            `prisma/sqlite/migrations/${activationMigrationName}/migration.sql`,
        );
        const db = createPreparedCredentialDatabase();
        try {
            db.exec(`
                INSERT INTO "Account" ("id") VALUES ('account-1');
            `);
            const insertLegacy = db.prepare(`
                INSERT INTO "ServiceAccountToken" (
                    "id", "accountId", "vendor", "profileId", "token", "metadata", "updatedAt"
                ) VALUES (?, 'account-1', ?, ?, X'01', json(?), CURRENT_TIMESTAMP)
            `);
            for (const legacyServiceId of Object.keys(
                FROZEN_ACTIVATION_CREDENTIAL_VECTORS,
            ) as FrozenCredentialId[]) {
                const credentialKind =
                    legacyServiceId === 'openai-codex'
                    || legacyServiceId === 'gemini'
                        ? 'oauth'
                        : 'token';
                insertLegacy.run(
                    `legacy-${legacyServiceId}`,
                    legacyServiceId,
                    `${legacyServiceId}-profile`,
                    JSON.stringify({
                        v: legacyServiceId === 'claude-subscription' ? 3 : 2,
                        kind: credentialKind,
                    }),
                );
            }
            insertLegacy.run(
                'legacy-claude-oauth',
                'claude-subscription',
                'claude-oauth-profile',
                JSON.stringify({ v: 2, kind: 'oauth' }),
            );
            insertLegacy.run(
                'legacy-claude-default',
                'claude-subscription',
                'claude-default-profile',
                null,
            );
            insertLegacy.run(
                'legacy-gemini-token',
                'gemini',
                'gemini-token-profile',
                JSON.stringify({ v: 2, kind: 'token' }),
            );
            db.exec(`
                INSERT INTO "ConnectedServiceAuthGroup" (
                    "id", "accountId", "vendor", "groupId", "policyJson",
                    "activeProfileId", "updatedAt"
                ) VALUES (
                    'group-db-1', 'account-1', 'openai-codex', 'group-1', '{}',
                    'openai-codex-profile', CURRENT_TIMESTAMP
                );
                INSERT INTO "ConnectedServiceAuthGroupMember" (
                    "id", "groupDbId", "accountId", "vendor", "groupId", "profileId", "updatedAt"
                ) VALUES (
                    'member-1', 'group-db-1', 'account-1', 'openai-codex', 'group-1',
                    'openai-codex-profile', CURRENT_TIMESTAMP
                );
                INSERT INTO "ProviderAccountUsageRecord" (
                    "id", "accountId", "providerId", "recordId", "accountSubjectId",
                    "subjectKind", "quotaScope", "quotaScopeIdKey", "recordKeyJson",
                    "payloadMode", "status", "updatedAt"
                ) VALUES (
                    'usage-record-db-1', 'account-1', 'openai-codex', 'usage-record-1',
                    'provider-account-1', 'account', 'account', '', '{}',
                    'plain', 'available', CURRENT_TIMESTAMP
                );
                INSERT INTO "ConnectedServiceUsageSource" (
                    "id", "accountId", "serviceId", "profileId", "sourceKey",
                    "providerAccountUsageRecordId", "bindingKind", "updatedAt"
                ) VALUES (
                    'usage-source-1', 'account-1', 'openai-codex',
                    'openai-codex-profile', 'source-1', 'usage-record-1',
                    'profile', CURRENT_TIMESTAMP
                );
            `);
            expect(() => db.exec(`
                INSERT INTO "ServiceAccountToken" (
                    "id", "accountId", "vendor", "profileId", "token", "updatedAt",
                    "service_plugin_id", "service_local_id", "qualified_service_digest",
                    "connected_account_id", "qualified_identity_digest", "authentication_mode_id"
                ) VALUES (
                    'novel-before-activation', 'account-1', NULL, NULL, X'02', CURRENT_TIMESTAMP,
                    'example.plugin', 'novel-service', '${'a'.repeat(64)}',
                    'novel-account', '${'b'.repeat(64)}', 'api-key'
                );
            `)).toThrow(/no column|has no column/i);

            await applyMigration(db, activation);

            expect(db.prepare(`
                SELECT "name"
                FROM pragma_index_list('ConnectedServiceAuthGroupMember')
                WHERE "unique" = 1
                  AND "name" IN (
                    'csagm_account_vendor_group_profile_key',
                    'ConnectedServiceAuthGroupMember_group_profile_key'
                  )
            `).all()).toEqual([{
                name: 'csagm_account_vendor_group_profile_key',
            }]);

            const legacy = db.prepare(`
                SELECT
                    "vendor",
                    "profileId",
                    "service_plugin_id" AS "servicePluginId",
                    "service_local_id" AS "serviceLocalId",
                    "qualified_service_digest" AS "qualifiedServiceDigest",
                    "connected_account_id" AS "connectedAccountId",
                    "qualified_identity_digest" AS "qualifiedIdentityDigest",
                    "authentication_mode_id" AS "authenticationModeId"
                FROM "ServiceAccountToken"
                ORDER BY "vendor", "profileId"
            `).all();
            const expectedBaseRows = Object.entries(
                FROZEN_ACTIVATION_CREDENTIAL_VECTORS,
            ).map(([legacyServiceId, vector]) => ({
                vendor: legacyServiceId,
                profileId: `${legacyServiceId}-profile`,
                servicePluginId: vector.service.pluginId,
                serviceLocalId: vector.service.localId,
                qualifiedServiceDigest: vector.serviceDigest,
                connectedAccountId: `${legacyServiceId}-profile`,
                qualifiedIdentityDigest: vector.identityDigest,
                authenticationModeId: expectedLegacyAuthenticationMode(
                    legacyServiceId as FrozenCredentialId,
                    legacyServiceId === 'openai-codex'
                    || legacyServiceId === 'gemini'
                        ? 'oauth'
                        : 'token',
                ),
            }));
            expect(legacy).toEqual([
                ...expectedBaseRows,
                {
                    vendor: 'claude-subscription',
                    profileId: 'claude-oauth-profile',
                    servicePluginId: 'happier.agent.claude',
                    serviceLocalId: 'claude-subscription',
                    qualifiedServiceDigest: serviceDigest(
                        'happier.agent.claude',
                        'claude-subscription',
                    ),
                    connectedAccountId: 'claude-oauth-profile',
                    qualifiedIdentityDigest: identityDigest(
                        'account',
                        'happier.agent.claude',
                        'claude-subscription',
                        'claude-oauth-profile',
                    ),
                    authenticationModeId: 'oauth',
                },
                {
                    vendor: 'claude-subscription',
                    profileId: 'claude-default-profile',
                    servicePluginId: 'happier.agent.claude',
                    serviceLocalId: 'claude-subscription',
                    qualifiedServiceDigest: serviceDigest(
                        'happier.agent.claude',
                        'claude-subscription',
                    ),
                    connectedAccountId: 'claude-default-profile',
                    qualifiedIdentityDigest: identityDigest(
                        'account',
                        'happier.agent.claude',
                        'claude-subscription',
                        'claude-default-profile',
                    ),
                    authenticationModeId: 'setup-token',
                },
                {
                    vendor: 'gemini',
                    profileId: 'gemini-token-profile',
                    servicePluginId: 'happier.agent.gemini',
                    serviceLocalId: 'gemini-account',
                    qualifiedServiceDigest: serviceDigest(
                        'happier.agent.gemini',
                        'gemini-account',
                    ),
                    connectedAccountId: 'gemini-token-profile',
                    qualifiedIdentityDigest: identityDigest(
                        'account',
                        'happier.agent.gemini',
                        'gemini-account',
                        'gemini-token-profile',
                    ),
                    authenticationModeId: 'api-key',
                },
            ].sort((left, right) =>
                left.vendor.localeCompare(right.vendor)
                || left.profileId.localeCompare(right.profileId)));

            expect(db.prepare(`
                SELECT
                    "id",
                    hex("token") AS "tokenHex",
                    json_extract("metadata", '$.kind') AS "metadataKind",
                    "authentication_mode_id" AS "authenticationModeId"
                FROM "ServiceAccountToken"
                WHERE "id" IN ('legacy-gemini', 'legacy-gemini-token')
                ORDER BY "id"
            `).all()).toEqual([
                {
                    id: 'legacy-gemini',
                    tokenHex: '01',
                    metadataKind: 'oauth',
                    authenticationModeId: 'legacy-oauth-unsupported',
                },
                {
                    id: 'legacy-gemini-token',
                    tokenHex: '01',
                    metadataKind: 'token',
                    authenticationModeId: 'api-key',
                },
            ]);

            expect(db.prepare(`
                SELECT
                    member."id",
                    member."credential_id" AS "credentialId",
                    member."qualified_service_digest" AS "qualifiedServiceDigest",
                    member."qualified_group_digest" AS "qualifiedGroupDigest",
                    member."qualified_identity_digest" AS "qualifiedIdentityDigest",
                    auth_group."active_connected_account_id" AS "activeConnectedAccountId"
                FROM "ConnectedServiceAuthGroupMember" AS member
                JOIN "ConnectedServiceAuthGroup" AS auth_group
                    ON auth_group."id" = member."groupDbId"
            `).all()).toEqual([{
                id: 'member-1',
                credentialId: 'legacy-openai-codex',
                qualifiedServiceDigest: serviceDigest(
                    'happier.agent.codex',
                    'openai-codex',
                ),
                qualifiedGroupDigest: identityDigest(
                    'group',
                    'happier.agent.codex',
                    'openai-codex',
                    'group-1',
                ),
                qualifiedIdentityDigest: identityDigest(
                    'account',
                    'happier.agent.codex',
                    'openai-codex',
                    'openai-codex-profile',
                ),
                activeConnectedAccountId: 'openai-codex-profile',
            }]);
            expect(db.prepare(`
                SELECT
                    "service_plugin_id" AS "servicePluginId",
                    "service_local_id" AS "serviceLocalId",
                    "qualified_service_digest" AS "qualifiedServiceDigest",
                    "connected_account_id" AS "connectedAccountId",
                    "qualified_identity_digest" AS "qualifiedIdentityDigest",
                    "credential_id" AS "credentialId"
                FROM "ConnectedServiceUsageSource"
            `).all()).toEqual([{
                servicePluginId: 'happier.agent.codex',
                serviceLocalId: 'openai-codex',
                qualifiedServiceDigest: serviceDigest(
                    'happier.agent.codex',
                    'openai-codex',
                ),
                connectedAccountId: 'openai-codex-profile',
                qualifiedIdentityDigest: identityDigest(
                    'account',
                    'happier.agent.codex',
                    'openai-codex',
                    'openai-codex-profile',
                ),
                credentialId: 'legacy-openai-codex',
            }]);
            expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

            const columns = db.prepare(`
                SELECT "name", "notnull"
                FROM pragma_table_info('ServiceAccountToken')
                WHERE "name" IN (
                    'vendor',
                    'profileId',
                    'service_plugin_id',
                    'service_local_id',
                    'qualified_service_digest',
                    'connected_account_id',
                    'qualified_identity_digest',
                    'authentication_mode_id'
                )
            `).all() as Array<{ name: string; notnull: number }>;
            expect(Object.fromEntries(columns.map((column) => [
                column.name,
                column.notnull,
            ]))).toEqual({
                vendor: 0,
                profileId: 0,
                service_plugin_id: 1,
                service_local_id: 1,
                qualified_service_digest: 1,
                connected_account_id: 1,
                qualified_identity_digest: 1,
                authentication_mode_id: 1,
            });

            expect(() => db.exec(`
                INSERT INTO "ServiceAccountToken" (
                    "id", "accountId", "vendor", "profileId", "token", "updatedAt",
                    "service_plugin_id", "service_local_id", "qualified_service_digest",
                    "connected_account_id", "qualified_identity_digest", "authentication_mode_id"
                ) VALUES (
                    'novel-after-activation', 'account-1', NULL, NULL, X'02', CURRENT_TIMESTAMP,
                    'example.plugin', 'novel-service', '${'a'.repeat(64)}',
                    'novel-account', '${'b'.repeat(64)}', 'api-key'
                );
            `)).not.toThrow();
        } finally {
            db.close();
        }
    });

    it('fails closed without changing rows when a legacy service is unmappable on SQLite', async () => {
        const activation = await read(
            `prisma/sqlite/migrations/${activationMigrationName}/migration.sql`,
        );
        const db = createPreparedCredentialDatabase();
        try {
            db.exec(`
                INSERT INTO "Account" ("id") VALUES ('account-1');
                INSERT INTO "ServiceAccountToken" (
                    "id", "accountId", "vendor", "profileId", "token", "updatedAt"
                ) VALUES (
                    'unknown-token', 'account-1', 'unknown-service', 'default', X'01', CURRENT_TIMESTAMP
                );
            `);

            await expect(applyMigration(db, activation)).rejects.toThrow();
            expect(db.prepare(`
                SELECT "vendor", "profileId"
                FROM "ServiceAccountToken"
                WHERE "id" = 'unknown-token'
            `).get()).toEqual({
                vendor: 'unknown-service',
                profileId: 'default',
            });
            expectActivationColumnsAbsent(db);
        } finally {
            db.close();
        }
    });

    it('rolls back every family when a legacy member disagrees with its group on SQLite', async () => {
        const activation = await read(
            `prisma/sqlite/migrations/${activationMigrationName}/migration.sql`,
        );
        const db = createPreparedCredentialDatabase();
        try {
            db.exec(`
                INSERT INTO "Account" ("id") VALUES ('account-1');
                INSERT INTO "ServiceAccountToken" (
                    "id", "accountId", "vendor", "profileId", "token", "updatedAt"
                ) VALUES (
                    'credential-1', 'account-1', 'openai-codex', 'default',
                    X'01', CURRENT_TIMESTAMP
                );
                INSERT INTO "ConnectedServiceAuthGroup" (
                    "id", "accountId", "vendor", "groupId", "policyJson", "updatedAt"
                ) VALUES (
                    'group-1', 'account-1', 'openai', 'main', '{}', CURRENT_TIMESTAMP
                );
                INSERT INTO "ConnectedServiceAuthGroupMember" (
                    "id", "groupDbId", "accountId", "vendor", "groupId",
                    "profileId", "updatedAt"
                ) VALUES (
                    'member-1', 'group-1', 'account-1', 'openai-codex', 'main',
                    'default', CURRENT_TIMESTAMP
                );
            `);

            await expect(applyMigration(db, activation)).rejects.toThrow();
            expect(db.prepare(`
                SELECT "vendor", "profileId"
                FROM "ServiceAccountToken"
                WHERE "id" = 'credential-1'
            `).get()).toEqual({
                vendor: 'openai-codex',
                profileId: 'default',
            });
            expect(db.prepare(`
                SELECT "vendor", "groupId"
                FROM "ConnectedServiceAuthGroup"
                WHERE "id" = 'group-1'
            `).get()).toEqual({
                vendor: 'openai',
                groupId: 'main',
            });
            expect(db.prepare(`
                SELECT "profileId"
                FROM "ConnectedServiceAuthGroupMember"
                WHERE "id" = 'member-1'
            `).get()).toEqual({ profileId: 'default' });
            expectActivationColumnsAbsent(db);
        } finally {
            db.close();
        }
    });

    it('rejects an explicit unknown legacy credential kind before activation writes on SQLite', async () => {
        const activation = await read(
            `prisma/sqlite/migrations/${activationMigrationName}/migration.sql`,
        );
        const db = createPreparedCredentialDatabase();
        try {
            db.exec(`
                INSERT INTO "Account" ("id") VALUES ('account-1');
                INSERT INTO "ServiceAccountToken" (
                    "id", "accountId", "vendor", "profileId", "token", "metadata", "updatedAt"
                ) VALUES (
                    'credential-1', 'account-1', 'claude-subscription', 'default',
                    X'01', json('{"v":3,"kind":"future-kind"}'), CURRENT_TIMESTAMP
                );
            `);

            await expect(applyMigration(db, activation)).rejects.toThrow();
            expect(db.prepare(`
                SELECT "vendor", json_extract("metadata", '$.kind') AS "kind"
                FROM "ServiceAccountToken"
                WHERE "id" = 'credential-1'
            `).get()).toEqual({
                vendor: 'claude-subscription',
                kind: 'future-kind',
            });
            expectActivationColumnsAbsent(db);
        } finally {
            db.close();
        }
    });

    it('rejects a dangling active account that is not a member of its legacy group on SQLite', async () => {
        const activation = await read(
            `prisma/sqlite/migrations/${activationMigrationName}/migration.sql`,
        );
        const db = createPreparedCredentialDatabase();
        try {
            db.exec(`
                INSERT INTO "Account" ("id") VALUES ('account-1');
                INSERT INTO "ServiceAccountToken" (
                    "id", "accountId", "vendor", "profileId", "token", "updatedAt"
                ) VALUES (
                    'credential-1', 'account-1', 'openai-codex', 'default',
                    X'01', CURRENT_TIMESTAMP
                );
                INSERT INTO "ConnectedServiceAuthGroup" (
                    "id", "accountId", "vendor", "groupId", "policyJson",
                    "activeProfileId", "updatedAt"
                ) VALUES (
                    'group-1', 'account-1', 'openai-codex', 'main', '{}',
                    'default', CURRENT_TIMESTAMP
                );
            `);

            await expect(applyMigration(db, activation)).rejects.toThrow();
            expect(db.prepare(`
                SELECT "activeProfileId"
                FROM "ConnectedServiceAuthGroup"
                WHERE "id" = 'group-1'
            `).get()).toEqual({ activeProfileId: 'default' });
            expectActivationColumnsAbsent(db);
        } finally {
            db.close();
        }
    });

    it.each([
        {
            family: 'account',
            disableForeignKeys: true,
            setup: `
                DROP INDEX "ServiceAccountToken_accountId_vendor_profileId_key";
                INSERT INTO "ServiceAccountToken" (
                    "id", "accountId", "vendor", "profileId", "token", "updatedAt"
                ) VALUES
                    ('credential-1', 'account-1', 'openai-codex', 'same', X'01', CURRENT_TIMESTAMP),
                    ('credential-2', 'account-1', 'openai-codex', 'same', X'02', CURRENT_TIMESTAMP);
            `,
        },
        {
            family: 'group',
            disableForeignKeys: false,
            setup: `
                DROP INDEX "ConnectedServiceAuthGroup_accountId_vendor_groupId_key";
                INSERT INTO "ConnectedServiceAuthGroup" (
                    "id", "accountId", "vendor", "groupId", "policyJson", "updatedAt"
                ) VALUES
                    ('group-1', 'account-1', 'openai-codex', 'same', '{}', CURRENT_TIMESTAMP),
                    ('group-2', 'account-1', 'openai-codex', 'same', '{}', CURRENT_TIMESTAMP);
            `,
        },
    ])(
        'rejects a same-account canonical $family identity collision before writes on SQLite',
        async ({ setup, disableForeignKeys }) => {
            const activation = await read(
                `prisma/sqlite/migrations/${activationMigrationName}/migration.sql`,
            );
            const db = createPreparedCredentialDatabase();
            try {
                if (disableForeignKeys) db.exec('PRAGMA foreign_keys=OFF');
                db.exec(`
                    INSERT INTO "Account" ("id") VALUES ('account-1');
                    ${setup}
                `);

                await expect(applyMigration(db, activation)).rejects.toThrow();
                expectActivationColumnsAbsent(db);
            } finally {
                db.close();
            }
        },
    );

    it('requires the canonical SQLite migration runner before any activation write', async () => {
        const activation = await read(
            `prisma/sqlite/migrations/${activationMigrationName}/migration.sql`,
        );
        const db = createPreparedCredentialDatabase();
        try {
            db.exec(`
                INSERT INTO "Account" ("id") VALUES ('account-1');
                INSERT INTO "ServiceAccountToken" (
                    "id", "accountId", "vendor", "profileId", "token", "updatedAt"
                ) VALUES (
                    'credential-1', 'account-1', 'openai-codex', 'default',
                    X'01', CURRENT_TIMESTAMP
                );
            `);

            expect(() => db.exec(activation)).toThrow(
                /happier_prepare_qualified_connected_accounts_v4/i,
            );
            expectActivationColumnsAbsent(db);
        } finally {
            db.close();
        }
    });
});
