import { randomUUID } from 'node:crypto';
import { copyFile, cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { encodeSessionTeamCredentialSlotKeyV1 } from '@happier-dev/protocol';
import { runPrismaMigrateCli } from '../prismaMigrateCli';
import { createDbMaintenanceClient } from '../../sources/storage/prisma';

const databaseUrl = process.env.HAPPIER_TEST_MYSQL_DATABASE_URL
    ?? (process.env.HAPPIER_DB_PROVIDER === 'mysql' ? process.env.DATABASE_URL : undefined);
const serverRoot = join(import.meta.dirname, '../..');
const firstLaneTenMigration = '20260906220000_add_team_credential_resources';

describe('Team credential MySQL migration', () => {
    (databaseUrl ? it : it.skip)('round-trips full canonical slot identities through the compound primary key', async () => {
        const databaseName = `team_credentials_${randomUUID().replaceAll('-', '')}`;
        const isolatedUrl = new URL(databaseUrl!);
        isolatedUrl.pathname = `/${databaseName}`;
        const admin = await createDbMaintenanceClient('mysql', databaseUrl);
        const db = await createDbMaintenanceClient('mysql', isolatedUrl.toString());
        const stage = await mkdtemp(join(tmpdir(), 'happier-team-credentials-mysql-'));
        let created = false;
        const deploy = () => runPrismaMigrateCli({
            serverRoot,
            schemaPath: join(stage, 'schema.prisma'), args: ['deploy'],
            env: { ...process.env, DATABASE_URL: isolatedUrl.toString() },
            quiet: true,
        });
        try {
            await admin.$executeRawUnsafe(`CREATE DATABASE \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
            created = true;
            await copyFile(join(serverRoot, 'prisma/mysql/schema.prisma'), join(stage, 'schema.prisma'));
            const sourceMigrationsRoot = join(serverRoot, 'prisma/mysql/migrations');
            const stageMigrationsRoot = join(stage, 'migrations');
            const migrationNames = (await readdir(sourceMigrationsRoot, { withFileTypes: true }))
                .filter((entry) => entry.isDirectory())
                .map((entry) => entry.name)
                .sort();
            await mkdir(stageMigrationsRoot, { recursive: true });
            await copyFile(
                join(sourceMigrationsRoot, 'migration_lock.toml'),
                join(stageMigrationsRoot, 'migration_lock.toml'),
            );
            const stageMigrations = async (names: readonly string[]) => {
                for (const name of names) {
                    await cp(
                        join(sourceMigrationsRoot, name),
                        join(stageMigrationsRoot, name),
                        { recursive: true },
                    );
                }
            };
            await stageMigrations(migrationNames.filter((name) => name < firstLaneTenMigration));
            await deploy();
            await db.$executeRawUnsafe("INSERT INTO `Account` (`id`,`publicKey`,`updatedAt`) VALUES ('account','account',CURRENT_TIMESTAMP(3))");
            await db.$executeRawUnsafe("INSERT INTO `Team` (`id`,`name`,`updatedAt`) VALUES ('team','Team',CURRENT_TIMESTAMP(3))");
            await db.$executeRawUnsafe("INSERT INTO `Session` (`id`,`tag`,`accountId`,`metadata`,`updatedAt`) VALUES ('session','session','account','{}',CURRENT_TIMESTAMP(3))");
            await db.$executeRawUnsafe("INSERT INTO `UsageEvent` (`id`,`accountId`,`sessionId`,`observedAt`,`agentId`,`source`,`scope`,`updatedAt`) VALUES ('pre-lane-10-usage','account','session',CURRENT_TIMESTAMP(3),'codex','session','turn',CURRENT_TIMESTAMP(3))");

            await stageMigrations(migrationNames.filter((name) => name >= firstLaneTenMigration));
            await deploy();
            const sourceBindingJson = JSON.stringify({ value: 'source'.repeat(256) });
            await db.$executeRawUnsafe("INSERT INTO `TeamCredentialResource` (`id`,`teamId`,`custodianAccountId`,`displayName`,`disclosureCeiling`,`sessionUsePolicy`,`sourceBindingJson`,`updatedAt`) VALUES ('resource','team','account','Shared','brokered_only','personal_allowed',?,CURRENT_TIMESTAMP(3))", sourceBindingJson);
            await db.$executeRawUnsafe("INSERT INTO `SessionTeamCredentialBinding` (`sessionId`,`slotKind`,`slotKey`,`resourceId`,`resourceRevision`,`updatedAt`) VALUES ('session','provider_model',?,'resource',0,CURRENT_TIMESTAMP(3))", Buffer.from('provider_model'));
            const ledger = await db.$queryRawUnsafe<Array<{ migration_name: string; checksum: string }>>(
                'SELECT migration_name,checksum FROM _prisma_migrations ORDER BY migration_name',
            );
            expect(ledger.map((row) => row.migration_name)).toEqual(migrationNames);
            expect(await db.$queryRawUnsafe(
                "SELECT id,executionRunId,teamCredentialResourceId,teamCredentialActorAccountId,requestCount FROM UsageEvent WHERE id='pre-lane-10-usage'",
            )).toEqual([{
                id: 'pre-lane-10-usage',
                executionRunId: null,
                teamCredentialResourceId: null,
                teamCredentialActorAccountId: null,
                requestCount: 0,
            }]);
            expect(await db.$queryRawUnsafe(
                "SELECT resourceId,resourceRevision FROM SessionTeamCredentialBinding WHERE slotKind='provider_model'",
            )).toEqual([{ resourceId: 'resource', resourceRevision: 0 }]);

            await deploy();
            expect(await db.$queryRawUnsafe('SELECT migration_name,checksum FROM _prisma_migrations ORDER BY migration_name')).toEqual(ledger);
            // The binding writer persists the prefixed canonical slot encoding,
            // whose schema-valid maximum exceeds the unprefixed purpose key.
            const purpose = { consumer: { pluginId: `${'a'.repeat(254)}.a`, localId: 'b'.repeat(256) }, purpose: '\u0001'.repeat(128) };
            const keys = [purpose, { ...purpose, purpose: `${'\u0001'.repeat(127)}\u0002` }].map((value) => Buffer.from(encodeSessionTeamCredentialSlotKeyV1({ kind: 'connected_service_purpose', purpose: value }), 'utf8'));
            expect(keys[0].byteLength).toBe(1318);
            const insert = (key: Uint8Array) => db.$executeRawUnsafe("INSERT INTO `SessionTeamCredentialBinding` (`sessionId`,`slotKind`,`slotKey`,`resourceId`,`resourceRevision`,`updatedAt`) VALUES ('session','connected_service_purpose',?,'resource',0,CURRENT_TIMESTAMP(3))", key);
            for (const key of keys) await insert(key);
            await expect(insert(keys[0])).rejects.toThrow();
            // Qualified by slot kind, exactly as the SQLite/PGlite sibling does
            // (`teamCredentialResourcesSchema.spec.ts`): the `provider_model`
            // binding inserted above is still present and deliberately retained,
            // so an unqualified read counts it as a third purpose key and fails
            // before the maximum-width, cascade and activity assertions below.
            const rows = await db.$queryRawUnsafe<Array<{ slotKey: Uint8Array }>>("SELECT `slotKey` FROM `SessionTeamCredentialBinding` WHERE `slotKind`='connected_service_purpose'");
            expect(rows.map((row) => Buffer.from(row.slotKey).toString('hex')).sort()).toEqual(keys.map((key) => key.toString('hex')).sort());
            expect(await db.$queryRawUnsafe('SELECT sourceBindingJson FROM TeamCredentialResource')).toEqual([{ sourceBindingJson }]);
            const maximumLengthResourceId = 'r'.repeat(256);
            const maximum = '9'.repeat(256);
            await db.$executeRawUnsafe(
                "INSERT INTO `TeamCredentialResource` (`id`,`teamId`,`custodianAccountId`,`displayName`,`disclosureCeiling`,`sessionUsePolicy`,`sourceBindingJson`,`updatedAt`) VALUES (?,'team','account','Shared','brokered_only','personal_allowed','{}',CURRENT_TIMESTAMP(3))",
                maximumLengthResourceId,
            );
            await db.$executeRawUnsafe(
                "INSERT INTO `TeamCredentialUsageLimit` (`id`,`resourceId`,`subjectKind`,`period`,`metric`,`maximum`,`updatedAt`) VALUES ('maximum-width-limit',?,'resource','calendar_month','requests',?,CURRENT_TIMESTAMP(3))",
                maximumLengthResourceId,
                maximum,
            );
            expect(await db.$queryRawUnsafe(
                "SELECT CHAR_LENGTH(`resourceId`) AS resourceIdLength,CHAR_LENGTH(`maximum`) AS maximumLength FROM `TeamCredentialUsageLimit` WHERE `id`='maximum-width-limit'",
            )).toEqual([{ resourceIdLength: 256n, maximumLength: 256n }]);
            await db.$executeRawUnsafe("INSERT INTO `TeamCredentialActivityEvent` (`id`,`teamId`,`resourceId`,`kind`,`actorAccountId`,`subjectDisplayName`) VALUES ('activity','team','resource','resource_created','account','Shared')");
            await db.$executeRawUnsafe("DELETE FROM `TeamCredentialResource` WHERE `id`='resource'");
            expect(await db.$queryRawUnsafe('SELECT resourceId FROM SessionTeamCredentialBinding')).toEqual([]);
            // Session ownership is RESTRICT; remove the fixture after its retention assertions.
            await db.$executeRawUnsafe("DELETE FROM `Session` WHERE `id`='session'");
            await db.$executeRawUnsafe("DELETE FROM `Account` WHERE `id`='account'");
            expect(await db.$queryRawUnsafe('SELECT resourceId,actorAccountId,subjectDisplayName FROM TeamCredentialActivityEvent'))
                .toEqual([{ resourceId: 'resource', actorAccountId: null, subjectDisplayName: 'Shared' }]);
            await db.$executeRawUnsafe("DELETE FROM `Team` WHERE `id`='team'");
            expect(await db.$queryRawUnsafe('SELECT id FROM TeamCredentialActivityEvent')).toEqual([]);
        } finally {
            await db.$disconnect();
            if (created) await admin.$executeRawUnsafe(`DROP DATABASE \`${databaseName}\``);
            await admin.$disconnect();
            await rm(stage, { recursive: true, force: true });
        }
    }, 120_000);
});
