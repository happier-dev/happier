import type { DatabaseActionIdV1 } from '@happier-dev/database-protocol';
import type {
    DatabaseDescriptorV1,
    DatabaseOperationClassV1,
    DatabaseOperationInputV1,
    DatabaseOperationResultV1,
} from '@happier-dev/plugin-sdk/database';
import { projectAutomationDatabaseFindingSubjectV1 } from '@happier-dev/plugin-sdk/events';
import { PluginError, type JsonValue, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { readUnexpectedActionErrorDiagnosticV1 } from '@happier-dev/plugin-sdk/errors';
import { databaseActionOperationClass } from '@happier-dev/plugin-sdk/actions';
import type { DatabaseActionProducers } from './actions.js';
import type { DatabaseWorkbenchConnection } from './connection.js';
import { DATABASE_CONNECTION_RESOURCE_ID_V1, type DatabaseOperationExecution } from './resources.js';
import { projectDatabaseFindingObservation } from './insights/findings.js';
import { emitDatabaseFindingObservation } from './insights/events.js';
import { projectCommittedDatabaseWrite } from './writeAudit.js';

export type DatabaseOperationResolver = (request: Readonly<{
    input: DatabaseOperationInputV1;
    context: PluginInvocationContext;
    access: DatabaseOperationClassV1;
}>) => Promise<Readonly<{
    descriptor: DatabaseDescriptorV1;
    connection: Pick<DatabaseWorkbenchConnection, 'execute' | 'close' | 'normalizeStatementShape'>;
}>>;

/** The one per-request access decision for the request's own requester (R4); no credential or connection. */
export type DatabaseOperationAdmission = (request: Readonly<{
    input: DatabaseOperationInputV1;
    context: PluginInvocationContext;
    access: DatabaseOperationClassV1;
}>) => Promise<unknown>;

export type ExecuteResolvedDatabaseOperation = (
    input: DatabaseOperationInputV1, context: PluginInvocationContext,
) => Promise<DatabaseOperationExecution>;

export function createDatabaseRuntime(options: Readonly<{
    resolve: DatabaseOperationResolver;
    admit: DatabaseOperationAdmission;
    listTargets?: DatabaseActionProducers['listTargets'];
}>): DatabaseActionProducers & Required<Pick<DatabaseActionProducers, 'executeOperation'>> & {
    executeResolvedOperation: ExecuteResolvedDatabaseOperation;
} {
    const executeResolvedOperation: ExecuteResolvedDatabaseOperation = async (input, context) => {
        // The registered Action identity and its declaration are admitted by the SDK.
        const access = databaseActionOperationClass(context.contribution.qualifiedId as DatabaseActionIdV1, input);
        let result: DatabaseOperationResultV1;
        let sourceScope: DatabaseOperationExecution['sourceScope'];
        let writeAudit: Readonly<Record<string, JsonValue>> | undefined;
        const indexAdvice = input.operation === 'stats.read' && input.request.group === 'indexAdvice';
        if (access === 'read' && input.subscriptionId && !indexAdvice) {
            // The demand was opened for whoever subscribed; this request is admitted for its own requester first.
            await options.admit({ input, context, access });
            // A host-owned demand validates its captured target and keeps its existing connection.
            // The same plugin's producer returns the result and placement of the held connection.
            ({ result, sourceScope } = await context.services.resources.invokeDemand({
                subscriptionId: input.subscriptionId, resourceId: DATABASE_CONNECTION_RESOURCE_ID_V1, input,
            }, { signal: context.signal }) as DatabaseOperationExecution);
        } else {
            const { descriptor, connection } = await options.resolve({ input, context, access });
            const { serverId, machineId } = descriptor.placement;
            sourceScope = { serverId, machineId };
            try {
                result = input.operation === 'describe'
                    ? { ok: true, operation: 'describe', descriptor }
                    : await connection.execute(input, context.signal);
                if (access === 'write') writeAudit = projectCommittedDatabaseWrite(input, result, connection);
            } finally {
                try { await connection.close(); }
                catch (error) {
                    // Cleanup cannot replace a committed result or the original execution failure.
                    context.services.logger.warn('Database connection cleanup failed', {
                        code: readUnexpectedActionErrorDiagnosticV1(error).errorCode ?? 'action_failed',
                    });
                }
            }
        }
        if (result.ok && result.operation === 'stats.read' && result.observation.status === 'available'
            && result.observation.group !== 'indexAdvice') {
            try {
                const observation = projectDatabaseFindingObservation(result.observation, sourceScope, context);
                const subject = projectAutomationDatabaseFindingSubjectV1(observation.sourceScope.serverId, input.target);
                await emitDatabaseFindingObservation({ observation, subject,
                    observationReceivedAt: Date.now(), observedDelta: 1 }, context);
            } catch (error) {
                // The read has settled; finding emission cannot replace the result.
                context.services.logger.warn('Database finding observation was not emitted', {
                    code: error instanceof PluginError ? error.code : 'action_failed',
                });
            }
        }
        if (writeAudit) {
            context.services.logger.info('Database write committed', {
                ...writeAudit, target: input.target,
                ...(context.requesterAccount ? { requesterAccountId: context.requesterAccount.accountId } : {}),
                ...(context.agentCaller && context.session ? { sessionId: context.session.id } : {}),
            });
            try {
                await context.services.resources.notifyDemands({ resourceId: DATABASE_CONNECTION_RESOURCE_ID_V1,
                    input: { target: input.target, ...(input.operation === 'edits.apply' ? { relation: input.relation } : {}) } });
            } catch (error) {
                // The engine has settled: delivery loss must never turn a committed write into a failed write.
                context.services.logger.warn('Database change notification was not delivered', {
                    code: error instanceof PluginError ? error.code : 'action_failed',
                });
            }
        }
        return { result, sourceScope };
    };
    return {
        listTargets: options.listTargets,
        executeResolvedOperation,
        async executeOperation(input, context) {
            const { result } = await executeResolvedOperation(input, context);
            return result;
        },
    };
}
