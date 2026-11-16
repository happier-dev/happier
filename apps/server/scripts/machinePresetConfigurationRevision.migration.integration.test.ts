import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

function readMigration(provider: 'pg' | 'sqlite'): string {
    const name = '20261116170000_managed_preset_configuration_revision';
    const fixtureRoot = process.env.HAPPIER_TEST_MANAGED_COUNTER_MIGRATION_ROOT;
    return readFileSync(fixtureRoot ? join(fixtureRoot, provider, name, 'migration.sql')
        : new URL(`../prisma/${provider === 'sqlite' ? 'sqlite/' : ''}migrations/${name}/migration.sql`, import.meta.url), 'utf8');
}

describe('Managed preset configuration revision upgrade', () => {
    it('seeds only provably matching retained Machine snapshots and preserves opaque content', () => {
        const sqlite = new DatabaseSync(':memory:');
        try {
            sqlite.exec(`
                CREATE TABLE "ManagedMachinePreset" ("id" TEXT PRIMARY KEY, "homeId" TEXT, "revision" INTEGER, "launch" TEXT);
                CREATE TABLE "ManagedMachine" ("id" TEXT PRIMARY KEY, "homeId" TEXT, "presetId" TEXT, "presetRevision" INTEGER, "launch" TEXT);
                INSERT INTO "ManagedMachinePreset" VALUES ('preset', 'home', 7, 'opaque-preset');
                INSERT INTO "ManagedMachine" VALUES
                    ('known', 'home', 'preset', 7, 'opaque-known'),
                    ('unknown', 'home', 'preset', 6, 'opaque-unknown'),
                    ('other-home', 'other', 'preset', 7, 'opaque-other-home'),
                    ('missing', 'home', 'removed', 7, 'opaque-missing'),
                    ('one-off', 'home', NULL, NULL, 'opaque-one-off');
            `);
            sqlite.exec(readMigration('sqlite'));
            expect(sqlite.prepare('SELECT "configurationRevision", "launch" FROM "ManagedMachinePreset"').get())
                .toMatchObject({ configurationRevision: 0, launch: 'opaque-preset' });
            expect(sqlite.prepare('SELECT "id", "presetConfigurationRevision", "launch" FROM "ManagedMachine" ORDER BY "id"').all())
                .toEqual([
                    { id: 'known', presetConfigurationRevision: 0, launch: 'opaque-known' },
                    { id: 'missing', presetConfigurationRevision: null, launch: 'opaque-missing' },
                    { id: 'one-off', presetConfigurationRevision: null, launch: 'opaque-one-off' },
                    { id: 'other-home', presetConfigurationRevision: null, launch: 'opaque-other-home' },
                    { id: 'unknown', presetConfigurationRevision: null, launch: 'opaque-unknown' },
                ]);
        } finally { sqlite.close(); }
    });

    it('preserves the same known/unknown distinction on Postgres', async () => {
        const postgres = new PGlite();
        try {
            await postgres.exec(`
                CREATE TABLE "ManagedMachinePreset" ("id" TEXT PRIMARY KEY, "homeId" TEXT, "revision" INTEGER, "launch" TEXT);
                CREATE TABLE "ManagedMachine" ("id" TEXT PRIMARY KEY, "homeId" TEXT, "presetId" TEXT, "presetRevision" INTEGER, "launch" TEXT);
                INSERT INTO "ManagedMachinePreset" VALUES ('preset', 'home', 7, 'opaque-preset');
                INSERT INTO "ManagedMachine" VALUES
                    ('known', 'home', 'preset', 7, 'opaque-known'),
                    ('unknown', 'home', 'preset', 6, 'opaque-unknown'),
                    ('other-home', 'other', 'preset', 7, 'opaque-other-home');
            `);
            await postgres.exec(readMigration('pg'));
            expect((await postgres.query('SELECT "configurationRevision", "launch" FROM "ManagedMachinePreset"')).rows)
                .toEqual([{ configurationRevision: 0, launch: 'opaque-preset' }]);
            expect((await postgres.query('SELECT "id", "presetConfigurationRevision", "launch" FROM "ManagedMachine" ORDER BY "id"')).rows)
                .toEqual([
                    { id: 'known', presetConfigurationRevision: 0, launch: 'opaque-known' },
                    { id: 'other-home', presetConfigurationRevision: null, launch: 'opaque-other-home' },
                    { id: 'unknown', presetConfigurationRevision: null, launch: 'opaque-unknown' },
                ]);
        } finally { await postgres.close(); }
    });
});
