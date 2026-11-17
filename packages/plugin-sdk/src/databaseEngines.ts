import type { PluginDatabaseEngineContributionV1 as CanonicalDeclaration } from '@happier-dev/protocol/plugins/contributions/databaseEngines';
import type { DatabaseCapabilityV1, DatabaseEngineIdV1, DatabaseOperationClassV1, DatabaseOperationInputV1, DatabaseOperationResultV1 } from '@happier-dev/database-protocol';

export type { DatabaseTargetV1, DatabaseStatsObservationV1, DatabaseStatsCounterComparisonV1 } from '@happier-dev/database-protocol';

export type PluginDatabaseEngineContributionV1 = Readonly<Omit<CanonicalDeclaration, 'capabilities'> & { capabilities: readonly DatabaseCapabilityV1[] }>;
export type PluginDatabaseEngineOpenInputV1 = Readonly<{ connectionString: string; access: DatabaseOperationClassV1; signal?: AbortSignal }>;

/** Native connection values stay in-process and within the existing invocation lifetime. */
export interface PluginDatabaseEngineRuntimeV1<TConnection = unknown> {
    open(input: PluginDatabaseEngineOpenInputV1): Promise<TConnection>;
    execute(connection: TConnection, input: DatabaseOperationInputV1, signal?: AbortSignal): Promise<DatabaseOperationResultV1>;
    close(connection: TConnection): Promise<void>;
}
export type PluginDatabaseEngineDefinitionV1 = Readonly<{
    declaration: Omit<PluginDatabaseEngineContributionV1, 'id'>;
    runtime: PluginDatabaseEngineRuntimeV1;
}>;
export interface DatabaseEngineConnectionV1 {
    readonly engine: DatabaseEngineIdV1;
    execute(input: DatabaseOperationInputV1, signal?: AbortSignal): Promise<DatabaseOperationResultV1>;
    close(): Promise<void>;
}
export interface DatabaseEnginesServiceV1 {
    /** Enabled declarations; this cold read never imports engine runtimes. */
    list(): readonly PluginDatabaseEngineContributionV1[];
    open(engineId: DatabaseEngineIdV1, input: PluginDatabaseEngineOpenInputV1): Promise<DatabaseEngineConnectionV1>;
}
