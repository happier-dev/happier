import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { splitMigrationStatements } from '../../sources/migrations/missingMigrationReconciliation';
import { createDbMaintenanceClient } from '../../sources/storage/prisma';

const databaseUrl = process.env.HAPPIER_TEST_MYSQL_DATABASE_URL;

describe('Account username intent MySQL upgrade', () => {
    (databaseUrl ? it : it.skip)('protects retained names and keeps holds after Account deletion', async () => {
        const databaseName = `username_intent_${randomUUID().replaceAll('-', '')}`;
        const isolatedUrl = new URL(databaseUrl!);
        isolatedUrl.pathname = `/${databaseName}`;
        const admin = await createDbMaintenanceClient('mysql', databaseUrl);
        const database = await createDbMaintenanceClient('mysql', isolatedUrl.toString());
        let created = false;
        try {
            await admin.$executeRawUnsafe(`CREATE DATABASE \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
            created = true;
            await database.$executeRawUnsafe('CREATE TABLE `Account` (`id` VARCHAR(191) PRIMARY KEY, `username` VARCHAR(191) UNIQUE) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
            await database.$executeRawUnsafe("INSERT INTO `Account` VALUES ('empty',NULL),('underscore','Old_Name'),('hyphen','old-name'),('reserved','admin')");
            const retained = await database.$queryRawUnsafe('SELECT `id`,`username` FROM `Account` ORDER BY `id`');
            const migration = await readFile(join(import.meta.dirname,
                '../../prisma/mysql/migrations/20261021120000_account_username_intent_and_release/migration.sql'), 'utf8');
            for (const statement of splitMigrationStatements(migration)) await database.$executeRawUnsafe(statement);
            expect(await database.$queryRawUnsafe('SELECT `id`,`username` FROM `Account` ORDER BY `id`')).toEqual(retained);
            expect(await database.$queryRawUnsafe('SELECT `id`,`usernameAutoFillEnabled` FROM `Account` ORDER BY `id`')).toEqual([
                { id: 'empty', usernameAutoFillEnabled: 1 }, { id: 'hyphen', usernameAutoFillEnabled: 0 },
                { id: 'reserved', usernameAutoFillEnabled: 0 }, { id: 'underscore', usernameAutoFillEnabled: 0 },
            ]);
            await database.$executeRawUnsafe("INSERT INTO `Account` (`id`) VALUES ('new')");
            expect(await database.$queryRawUnsafe("SELECT `usernameAutoFillEnabled` FROM `Account` WHERE `id`='new'"))
                .toEqual([{ usernameAutoFillEnabled: 1 }]);
            await database.$executeRawUnsafe("INSERT INTO `ReleasedUsername` (`username`,`expiresAt`) VALUES ('Old_Name','2026-11-20 12:00:00.123')");
            await database.$executeRawUnsafe("DELETE FROM `Account` WHERE `id`='underscore'");
            expect(await database.$queryRawUnsafe('SELECT `username` FROM `ReleasedUsername`')).toEqual([{ username: 'Old_Name' }]);
            await expect(database.$executeRawUnsafe("INSERT INTO `ReleasedUsername` (`username`,`expiresAt`) VALUES ('Old_Name','2026-12-20 12:00:00.123')"))
                .rejects.toThrow();
        } finally {
            await database.$disconnect();
            if (created) await admin.$executeRawUnsafe(`DROP DATABASE \`${databaseName}\``);
            await admin.$disconnect();
        }
    });
});
