import type { DatabaseBuiltinEngineIdV1, DatabaseCapabilityV1 } from '@happier-dev/database-protocol';

// The current built-in adapters implement the same operation family. These facts
// describe execution support; engine roles and statement forms settle on execution.
const builtinExecutionCapabilities: readonly DatabaseCapabilityV1[] = [
    { operation: 'schemas.list', available: true },
    { operation: 'relations.list', available: true },
    { operation: 'relation.structure', available: true },
    { operation: 'rows.read', available: true },
    { operation: 'cell.read', available: true },
    { operation: 'statement.run', available: true },
    { operation: 'statement.explain', available: true },
    { operation: 'edits.apply', available: true },
    { operation: 'stats.read', available: false, code: 'database_operation_unavailable', reason: 'Statistics belong to the target statistics adapter' },
];

export const postgresqlCapabilities = builtinExecutionCapabilities;
export const mysqlCapabilities = builtinExecutionCapabilities;
export const sqliteCapabilities = builtinExecutionCapabilities;

/** List and describe can consume native support without importing a driver. */
export function builtinDatabaseCapabilities(engine: DatabaseBuiltinEngineIdV1): readonly DatabaseCapabilityV1[] {
    switch (engine) {
        case 'postgresql': return postgresqlCapabilities;
        case 'mysql': return mysqlCapabilities;
        case 'sqlite': return sqliteCapabilities;
    }
}
