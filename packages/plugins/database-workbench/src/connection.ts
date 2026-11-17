import { fileURLToPath } from 'node:url';
import { DatabaseBuiltinEngineIdV1Schema, type DatabaseEngineIdV1, type DatabaseCapabilityV1, type DatabaseManualTargetV1, type DatabaseOperationClassV1, type DatabaseOperationInputV1, type DatabaseOperationResultV1 } from '@happier-dev/database-protocol';
import { PluginError, type DatabaseEnginesServiceV1 } from '@happier-dev/plugin-sdk';
import type { SecretsService } from '@happier-dev/plugin-sdk/secrets';
import { builtinDatabaseConnectionEngine, databaseConnectionScheme, parseDatabaseConnectionUrl, sqliteDatabaseFileUrl } from '@happier-dev/databases';
import { builtinDatabaseCapabilities } from './capabilities.js';
import { openPostgresqlConnection } from './postgresql.js';
import { openMysqlConnection } from './mysql.js';
import { openSqliteConnection } from './sqlite.js';

export interface DatabaseWorkbenchConnection {
    readonly engine: DatabaseEngineIdV1;
    execute(input: DatabaseOperationInputV1, signal?: AbortSignal): Promise<DatabaseOperationResultV1>;
    close(): Promise<void>;
}

function selectDatabaseConnection(connectionString: string, databaseEngines?: DatabaseEnginesServiceV1) {
    const scheme = databaseConnectionScheme(connectionString);
    const candidates = databaseEngines?.list().filter(engine => engine.scheme === scheme) ?? [];
    if (candidates.length > 1) throw new PluginError({ code: 'plugin_service_unavailable' });
    const contributed = candidates[0];
    if (contributed) return { engine: contributed.engineId, capabilities: contributed.capabilities, contributed: true } as const;
    if (!builtinDatabaseConnectionEngine(connectionString)) return undefined;
    const { engine } = parseDatabaseConnectionUrl(connectionString);
    return { engine, capabilities: builtinDatabaseCapabilities(engine), contributed: false } as const;
}

type DatabaseConnectionDescriptor = Readonly<{
    engine: DatabaseEngineIdV1; capabilities: readonly DatabaseCapabilityV1[];
}>;

/** Cold discovery ignores URLs whose schemes have no enabled database engine. */
export function findDatabaseConnectionDescriptor(connectionString: string, databaseEngines?: DatabaseEnginesServiceV1): DatabaseConnectionDescriptor | undefined {
    const selected = selectDatabaseConnection(connectionString, databaseEngines);
    if (!selected) return undefined;
    const { engine, capabilities } = selected;
    return { engine, capabilities };
}

/** No driver load or connection open is needed to select a contributed scheme. */
export function describeDatabaseConnection(connectionString: string, databaseEngines?: DatabaseEnginesServiceV1): DatabaseConnectionDescriptor {
    const descriptor = findDatabaseConnectionDescriptor(connectionString, databaseEngines);
    if (!descriptor) throw new PluginError({ code: 'plugin_service_unavailable' });
    return descriptor;
}

/** Credential acquisition and access admission remain with the invoking target owner. */
export async function openDatabaseConnection(input: Readonly<{
    connectionString: string; access: DatabaseOperationClassV1; signal?: AbortSignal; databaseEngines?: DatabaseEnginesServiceV1;
}>): Promise<DatabaseWorkbenchConnection> {
    input.signal?.throwIfAborted();
    const descriptor = selectDatabaseConnection(input.connectionString, input.databaseEngines);
    if (!descriptor) throw new PluginError({ code: 'plugin_service_unavailable' });
    if (descriptor.contributed && input.databaseEngines) return input.databaseEngines.open(descriptor.engine, {
        connectionString: input.connectionString, access: input.access, signal: input.signal,
    });
    const engine = DatabaseBuiltinEngineIdV1Schema.parse(descriptor.engine);
    switch (engine) {
        case 'postgresql': return { engine, ...await openPostgresqlConnection(input.connectionString, input.signal) };
        case 'mysql': return { engine, ...await openMysqlConnection(input.connectionString, input.signal) };
        case 'sqlite': return { engine, ...await openSqliteConnection(fileURLToPath(sqliteDatabaseFileUrl(input.connectionString)), { readOnly: input.access === 'read' }) };
    }
}

/** Admission and Saved Secret acquisition belong to the caller; this handle contains no public address. */
export async function openManualDatabaseConnection(input: Readonly<{
    target: DatabaseManualTargetV1;
    secretValue: Awaited<ReturnType<SecretsService['readSavedSecret']>>;
    access: DatabaseOperationClassV1;
    signal?: AbortSignal;
    databaseEngines?: DatabaseEnginesServiceV1;
}>): Promise<DatabaseWorkbenchConnection> {
    return openDatabaseConnection({ connectionString: input.secretValue, access: input.access, signal: input.signal, databaseEngines: input.databaseEngines });
}
