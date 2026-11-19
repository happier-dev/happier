export * from '@happier-dev/databases/capabilities';
import { builtinDatabaseCapabilities } from '@happier-dev/databases/capabilities';
import {
    DatabaseBuiltinEngineIdV1Schema,
    DATABASE_OPERATION_NAMES_V1,
    type DatabaseEngineIdV1,
    type DatabaseCapabilityV1,
} from '@happier-dev/plugin-sdk/database';
import type { DatabaseEnginesServiceV1 } from '@happier-dev/plugin-sdk';

/** Saved manual records keep engine identity; availability comes from enabled declarations. */
export function databaseEngineCapabilities(engineId: DatabaseEngineIdV1, databaseEngines?: DatabaseEnginesServiceV1): readonly DatabaseCapabilityV1[] {
    const contributed = databaseEngines?.list().filter(engine => engine.engineId === engineId) ?? [];
    if (contributed.length === 1) return contributed[0]!.capabilities;
    const builtin = DatabaseBuiltinEngineIdV1Schema.safeParse(engineId);
    if (builtin.success && contributed.length === 0) return builtinDatabaseCapabilities(builtin.data);
    return DATABASE_OPERATION_NAMES_V1.map(operation => ({ operation, available: false,
        code: 'plugin_service_unavailable', reason: 'Database engine is not enabled or has an ambiguous declaration.' }));
}
