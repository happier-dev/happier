import { describe, expect, it } from 'vitest';

import {
    normalizePluginAccountCollectionMigrationRuntimeProjection,
    normalizePluginDaemonDatabaseRuntimeProjection,
} from './authoringProjections.js';

describe('authoring callback projections', () => {
    it('retains Collection callbacks only for the exact declared migration identities and order', () => {
        const migrate = (record: Readonly<Record<string, unknown>>) => record;
        const migrations = [
            { id: 'add-status', fromSchemaVersion: 1, toSchemaVersion: 2, migrate },
            { id: 'add-title', fromSchemaVersion: 2, toSchemaVersion: 3, migrate },
        ];
        const declarations = [{ id: 'tasks', migrations: migrations.map(({ migrate: _migrate, ...metadata }) => metadata) }];
        const normalize = (value: unknown) => normalizePluginAccountCollectionMigrationRuntimeProjection<typeof migrate>(value, declarations);

        const normalized = normalize({ tasks: migrations });
        expect(normalized.tasks?.[0]?.migrate).toBe(migrate);
        expect(normalized.tasks?.[1]?.migrate).toBe(migrate);
        expect(Object.isFrozen(normalized.tasks?.[0])).toBe(true);
        expect(() => normalize({})).toThrow(TypeError);
        expect(() => normalize({ tasks: migrations, extra: [] })).toThrow(TypeError);
        expect(() => normalize({ tasks: [...migrations].reverse() })).toThrow(TypeError);
        expect(() => normalize({ tasks: [{ ...migrations[0], toSchemaVersion: 3 }, migrations[1]] })).toThrow(TypeError);
    });

    it('retains database callbacks only for exact declarations and rejects unknown callback fields', () => {
        const up = async (_transaction: Readonly<{ execute: () => void }>) => {};
        const run = async (_transaction: Readonly<{ query: () => void }>) => {};
        const database = {
            migrations: [{ id: 'create-tasks', version: 1, up }],
            incumbentQueryFixture: { id: 'tasks-query', run },
        };
        const declarations = [{
            id: 'tasks',
            migrations: [{ id: 'create-tasks', version: 1 }],
            incumbentQueryFixtureId: 'tasks-query',
        }];
        const normalize = (value: unknown) => normalizePluginDaemonDatabaseRuntimeProjection<typeof up, typeof run>(value, declarations);

        const normalized = normalize({ tasks: database });
        expect(normalized.tasks?.migrations[0]?.up).toBe(up);
        expect(normalized.tasks?.incumbentQueryFixture.run).toBe(run);
        expect(Object.isFrozen(normalized.tasks?.incumbentQueryFixture)).toBe(true);
        expect(() => normalize({})).toThrow(TypeError);
        expect(() => normalize({ tasks: database, extra: database })).toThrow(TypeError);
        expect(() => normalize({ tasks: { ...database, incumbentQueryFixture: { id: 'wrong-query', run } } })).toThrow(TypeError);
        expect(() => normalize({ tasks: { ...database, migrations: [{ id: 'create-tasks', version: 2, up }] } })).toThrow(TypeError);
        expect(() => normalize({ tasks: { ...database, migrationRunner: up } })).toThrow(TypeError);
        expect(() => normalize({ tasks: { ...database, migrations: [{ ...database.migrations[0], sql: 'select 1' }] } })).toThrow(TypeError);
    });
});
