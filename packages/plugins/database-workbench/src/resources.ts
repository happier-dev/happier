import { PluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginDynamicResourceInvocationOptionsV1, PluginDynamicResourceRuntime } from '@happier-dev/plugin-sdk/resources';
import type { SecretsService } from '@happier-dev/plugin-sdk/secrets';
import {
    DatabaseDescribeInputV1Schema,
    DatabaseOperationInputV1Schema,
    DatabaseOwnWriteV1Schema,
    type DatabaseDemandSnapshotV1,
    type DatabaseDescribeInputV1,
    type DatabaseDescriptorV1,
    type DatabaseRelationV1,
} from '@happier-dev/database-protocol';
import type { DatabaseWorkbenchConnection } from './connection.js';

export { DATABASE_CONNECTION_RESOURCE_ID_V1 } from '@happier-dev/database-protocol';

export type DatabaseDemandResolver = (input: Readonly<{
    input: DatabaseDescribeInputV1;
    requesterAccount: Readonly<{ accountId: string }>;
    secrets: Pick<SecretsService, 'readSavedSecret'>;
    signal: AbortSignal;
}> & Pick<PluginDynamicResourceInvocationOptionsV1, 'chosenMachine' | 'daemonStorage' | 'agentCaller' | 'authority' | 'deploymentDatabases' | 'databaseEngines' | 'worktreeEnvironment'>)
    => Promise<Readonly<{ descriptor: DatabaseDescriptorV1; connection: Pick<DatabaseWorkbenchConnection, 'execute' | 'close'> }>>;

function unavailable(): never {
    throw new PluginError({ code: 'plugin_resource_producer_placement_unavailable' });
}

/** The Resource host owns this producer's Account, exact surface and lifetime. */
export function createDatabaseConnectionResourceRuntime(options: Readonly<{
    resolve: DatabaseDemandResolver;
}>): PluginDynamicResourceRuntime {
    return {
        read: unavailable,
        observe: unavailable,
        async createProducer(context) {
            if (context.context.kind !== 'surface' || !context.requesterAccount || !context.secrets) {
                throw new PluginError({ code: 'plugin_resource_demand_unavailable' });
            }
            const input = DatabaseDescribeInputV1Schema.parse(context.context.launchInput);
            const targetKey = JSON.stringify(input.target);
            const { descriptor, connection } = await options.resolve({
                input, requesterAccount: context.requesterAccount, secrets: context.secrets, signal: context.signal,
                ...(context.chosenMachine ? { chosenMachine: context.chosenMachine } : {}),
                ...(context.daemonStorage ? { daemonStorage: context.daemonStorage } : {}),
                ...(context.deploymentDatabases ? { deploymentDatabases: context.deploymentDatabases } : {}),
                ...(context.databaseEngines ? { databaseEngines: context.databaseEngines } : {}),
                ...(context.worktreeEnvironment ? { worktreeEnvironment: context.worktreeEnvironment } : {}),
                ...(context.agentCaller === undefined ? {} : { agentCaller: context.agentCaller }),
                ...(context.authority ? { authority: context.authority } : {}),
            });
            let ownWriteRevision = 0;
            const relationRevisions = new Map<string, { relation: DatabaseRelationV1; revision: number }>();
            let invalidate: (() => void) | undefined;
            return {
                read() {
                    const snapshot: DatabaseDemandSnapshotV1 = { descriptor, ownWriteRevision,
                        relationRevisions: [...relationRevisions.values()] };
                    return JSON.stringify(snapshot);
                },
                observe(callback: () => void) {
                    invalidate = callback;
                    return { dispose() { if (invalidate === callback) invalidate = undefined; } };
                },
                async invoke(operand: JsonValue, invocation: Readonly<{ signal: AbortSignal }>) {
                    const operation = DatabaseOperationInputV1Schema.parse(operand);
                    if (JSON.stringify(operation.target) !== targetKey) {
                        throw new PluginError({ code: 'database_demand_target_mismatch' });
                    }
                    return operation.operation === 'describe'
                        ? { ok: true as const, operation: 'describe' as const, descriptor }
                        : await connection.execute(operation, invocation.signal);
                },
                notify(operand: JsonValue) {
                    const change = DatabaseOwnWriteV1Schema.parse(operand);
                    if (JSON.stringify(change.target) !== targetKey) return;
                    if (change.relation) {
                        const relationKey = JSON.stringify(change.relation);
                        const current = relationRevisions.get(relationKey);
                        relationRevisions.set(relationKey, { relation: change.relation, revision: (current?.revision ?? 0) + 1 });
                    } else ownWriteRevision++;
                    invalidate?.();
                },
                async dispose() {
                    invalidate = undefined;
                    relationRevisions.clear();
                    await connection.close();
                },
            };
        },
    };
}
