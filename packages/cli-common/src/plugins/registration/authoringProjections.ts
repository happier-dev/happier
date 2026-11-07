type RuntimeCallback = (...args: never[]) => unknown;

type NormalizedPluginDaemonDatabaseDefinition<TUp extends RuntimeCallback, TRun extends RuntimeCallback> =
    ReturnType<typeof normalizeDaemonDatabaseDefinition<TUp, TRun>>;

function readDaemonDatabaseDefinitionRecord(
    value: unknown,
    description: string,
): Readonly<Record<string, unknown>> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${description} must be an object keyed by local database id`);
    }
    return value as Readonly<Record<string, unknown>>;
}

function assertDaemonDatabaseDefinitionKeys(
    value: Readonly<Record<string, unknown>>,
    localId: string,
): void {
    const unknownKeys = Object.keys(value).filter((key) => (
        key !== 'migrations' && key !== 'incumbentQueryFixture'
    ));
    if (unknownKeys.length > 0) {
        throw new TypeError(
            `Daemon database '${localId}' has unknown callback field(s): ${unknownKeys.join(', ')}`,
        );
    }
}

export function normalizeDaemonDatabaseDefinition<TUp extends RuntimeCallback = RuntimeCallback, TRun extends RuntimeCallback = RuntimeCallback>(
    value: unknown,
    localId: string,
) {
    const definition = readDaemonDatabaseDefinitionRecord(value, `Daemon database '${localId}'`);
    assertDaemonDatabaseDefinitionKeys(definition, localId);
    const rawMigrations = definition.migrations ?? [];
    if (!Array.isArray(rawMigrations)) {
        throw new TypeError(`Daemon database '${localId}' migrations must be an array`);
    }
    const migrations = rawMigrations.map((rawMigration, index) => {
        const migration = readDaemonDatabaseDefinitionRecord(
            rawMigration,
            `Daemon database '${localId}' migration ${index}`,
        );
        const unknownKeys = Object.keys(migration).filter((key) => (
            key !== 'version' && key !== 'id' && key !== 'up'
        ));
        if (unknownKeys.length > 0) {
            throw new TypeError(
                `Daemon database '${localId}' migration ${index} has unknown field(s): ${unknownKeys.join(', ')}`,
            );
        }
        if (typeof migration.id !== 'string') {
            throw new TypeError(`Daemon database '${localId}' migration ${index} must have a string id`);
        }
        if (typeof migration.version !== 'number'
            || !Number.isSafeInteger(migration.version)
            || migration.version < 1) {
            throw new TypeError(
                `Daemon database '${localId}' migration ${index} must have a positive integer version`,
            );
        }
        if (typeof migration.up !== 'function') {
            throw new TypeError(`Daemon database '${localId}' migration ${index} must provide an up callback`);
        }
        return Object.freeze({
            id: migration.id,
            version: migration.version,
            up: migration.up as TUp,
        });
    });
    const fixture = readDaemonDatabaseDefinitionRecord(
        definition.incumbentQueryFixture,
        `Daemon database '${localId}' incumbent query fixture`,
    );
    const unknownFixtureKeys = Object.keys(fixture).filter((key) => key !== 'id' && key !== 'run');
    if (unknownFixtureKeys.length > 0) {
        throw new TypeError(
            `Daemon database '${localId}' incumbent query fixture has unknown field(s): ${unknownFixtureKeys.join(', ')}`,
        );
    }
    if (typeof fixture.id !== 'string') {
        throw new TypeError(`Daemon database '${localId}' incumbent query fixture must have a string id`);
    }
    if (typeof fixture.run !== 'function') {
        throw new TypeError(`Daemon database '${localId}' incumbent query fixture must provide a run callback`);
    }
    return Object.freeze({
        migrations: Object.freeze(migrations),
        incumbentQueryFixture: Object.freeze({
            id: fixture.id,
            run: fixture.run as TRun,
        }),
    });
}

export function readDaemonDatabaseDefinitions(
    value: unknown,
): Readonly<Record<string, unknown>> {
    if (value === undefined) return Object.freeze({});
    return readDaemonDatabaseDefinitionRecord(value, 'Daemon databases');
}

export function readAccountCollectionDefinitions(
    value: unknown,
): Readonly<Record<string, unknown>> {
    if (value === undefined) return Object.freeze({});
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('Account Collections must be an object keyed by local collection id');
    }
    return value as Readonly<Record<string, unknown>>;
}

function normalizePluginAccountCollectionMigrationProjection<TMigrate extends RuntimeCallback>(
    value: unknown,
    localId: string,
) {
    if (!Array.isArray(value)) {
        throw new TypeError(`Account Collection '${localId}' migration projection must be an array`);
    }
    return Object.freeze(value.map((rawMigration, index) => {
        if (!rawMigration || typeof rawMigration !== 'object' || Array.isArray(rawMigration)) {
            throw new TypeError(`Account Collection '${localId}' migration ${index} must be an object`);
        }
        const migration = rawMigration as Readonly<Record<string, unknown>>;
        if (typeof migration.migrate !== 'function') {
            throw new TypeError(`Account Collection '${localId}' migration ${index} must provide a migrate callback`);
        }
        // These captured identities are checked against the parsed declaration
        // before the containing runtime projection is returned.
        return Object.freeze({
            id: migration.id as string,
            fromSchemaVersion: migration.fromSchemaVersion as number,
            toSchemaVersion: migration.toSchemaVersion as number,
            migrate: migration.migrate as TMigrate,
        });
    }));
}

/**
 * Candidate-local projection for Collection callbacks. Parsed manifest
 * identities remain the authority; every callback must match them in order
 * before a preparation host receives the projection.
 */
export function normalizePluginAccountCollectionMigrationRuntimeProjection<TMigrate extends RuntimeCallback = RuntimeCallback>(
    value: unknown,
    declarations: readonly Readonly<{ id: string; migrations?: unknown }>[],
): Readonly<Record<string, ReturnType<typeof normalizePluginAccountCollectionMigrationProjection<TMigrate>>>> {
    const projection = readAccountCollectionDefinitions(value);
    const declarationIds = declarations.map((declaration) => declaration.id);
    const unknownIds = Object.keys(projection).filter((localId) => !declarationIds.includes(localId));
    const missingIds = declarationIds.filter((localId) => !Object.prototype.hasOwnProperty.call(projection, localId));
    if (unknownIds.length > 0 || missingIds.length > 0) {
        throw new TypeError([
            'Account Collection migration callbacks must match the manifest declarations exactly',
            ...(unknownIds.length > 0 ? [`unknown collection ids: ${unknownIds.join(', ')}`] : []),
            ...(missingIds.length > 0 ? [`missing collection ids: ${missingIds.join(', ')}`] : []),
        ].join('; '));
    }
    const normalized = declarations.map((declaration) => {
        const declaredMigrations = declaration.migrations ?? [];
        if (!Array.isArray(declaredMigrations)) {
            throw new TypeError(
                `Account Collection '${declaration.id}' manifest declaration is missing static migrations`,
            );
        }
        const migrations = normalizePluginAccountCollectionMigrationProjection<TMigrate>(
            projection[declaration.id],
            declaration.id,
        );
        if (migrations.length !== declaredMigrations.length) {
            throw new TypeError(
                `Account Collection '${declaration.id}' migrations do not match the manifest declaration`,
            );
        }
        declaredMigrations.forEach((rawDeclaredMigration: unknown, index: number) => {
            if (!rawDeclaredMigration || typeof rawDeclaredMigration !== 'object' || Array.isArray(rawDeclaredMigration)) {
                throw new TypeError(
                    `Account Collection '${declaration.id}' manifest declaration has an invalid migration ${index}`,
                );
            }
            const declaredMigration = rawDeclaredMigration as Readonly<Record<string, unknown>>;
            const runtimeMigration = migrations[index];
            if (!runtimeMigration
                || runtimeMigration.id !== declaredMigration.id
                || runtimeMigration.fromSchemaVersion !== declaredMigration.fromSchemaVersion
                || runtimeMigration.toSchemaVersion !== declaredMigration.toSchemaVersion) {
                throw new TypeError(
                    `Account Collection '${declaration.id}' migration ${index} does not match the manifest declaration`,
                );
            }
        });
        return [declaration.id, migrations] as const;
    });
    return Object.freeze(Object.fromEntries(normalized));
}

/**
 * Normalizes candidate callbacks only after proving one-to-one correspondence
 * with the already parsed static manifest. The returned map retains callback
 * identity but exposes no registration API or host lifecycle authority.
 */
export function normalizePluginDaemonDatabaseRuntimeProjection<TUp extends RuntimeCallback = RuntimeCallback, TRun extends RuntimeCallback = RuntimeCallback>(
    value: unknown,
    declarations: readonly Readonly<{
        id: string;
        migrations: readonly Readonly<{ id: string; version: number }>[];
        incumbentQueryFixtureId: string;
    }>[],
): Readonly<Record<string, NormalizedPluginDaemonDatabaseDefinition<TUp, TRun>>> {
    const definitions = readDaemonDatabaseDefinitions(value);
    const declarationIds = declarations.map((declaration) => declaration.id);
    const unknownIds = Object.keys(definitions).filter((localId) => !declarationIds.includes(localId));
    const missingIds = declarationIds.filter((localId) => !Object.prototype.hasOwnProperty.call(definitions, localId));
    if (unknownIds.length > 0 || missingIds.length > 0) {
        throw new TypeError([
            'Daemon database callbacks must match the manifest declarations exactly',
            ...(unknownIds.length > 0 ? [`unknown database ids: ${unknownIds.join(', ')}`] : []),
            ...(missingIds.length > 0 ? [`missing database ids: ${missingIds.join(', ')}`] : []),
        ].join('; '));
    }
    const normalized = declarations.map((declaration) => {
        const definition = normalizeDaemonDatabaseDefinition<TUp, TRun>(definitions[declaration.id], declaration.id);
        if (definition.incumbentQueryFixture.id !== declaration.incumbentQueryFixtureId) {
            throw new TypeError(
                `Daemon database '${declaration.id}' incumbent query fixture does not match the manifest declaration`,
            );
        }
        if (definition.migrations.length !== declaration.migrations.length) {
            throw new TypeError(
                `Daemon database '${declaration.id}' migrations do not match the manifest declaration`,
            );
        }
        declaration.migrations.forEach((declaredMigration, index) => {
            const runtimeMigration = definition.migrations[index];
            if (!runtimeMigration
                || runtimeMigration.id !== declaredMigration.id
                || runtimeMigration.version !== declaredMigration.version) {
                throw new TypeError(
                    `Daemon database '${declaration.id}' migration ${index} does not match the manifest declaration`,
                );
            }
        });
        return [declaration.id, definition] as const;
    });
    return Object.freeze(Object.fromEntries(normalized));
}
