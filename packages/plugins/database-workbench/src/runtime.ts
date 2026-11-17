import type { DatabaseActionIdV1, DatabaseDescriptorV1, DatabaseOperationClassV1, DatabaseOperationInputV1, DatabaseOperationResultV1 } from '@happier-dev/database-protocol';
import { readAutomationDatabaseSubjectV1 } from '@happier-dev/database-protocol';
import { PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { readUnexpectedActionErrorDiagnosticV1 } from '@happier-dev/plugin-sdk/errors';
import { databaseActionOperationClass, type DatabaseActionProducers } from './actions.js';
import type { DatabaseWorkbenchConnection } from './connection.js';
import { DATABASE_CONNECTION_RESOURCE_ID_V1 } from './resources.js';
import { projectDatabaseFindingObservation } from './insights/findings.js';
import { emitDatabaseFindingObservation } from './insights/events.js';

export type DatabaseOperationResolver = (request: Readonly<{
    input: DatabaseOperationInputV1;
    context: PluginInvocationContext;
    access: DatabaseOperationClassV1;
}>) => Promise<Readonly<{
    descriptor: DatabaseDescriptorV1;
    connection: Pick<DatabaseWorkbenchConnection, 'execute' | 'close'>;
}>>;

/** The one per-request access decision for the request's own requester (R4); no credential or connection. */
export type DatabaseOperationAdmission = (request: Readonly<{
    input: DatabaseOperationInputV1;
    context: PluginInvocationContext;
    access: DatabaseOperationClassV1;
}>) => Promise<unknown>;

export function createDatabaseRuntime(options: Readonly<{
    resolve: DatabaseOperationResolver;
    admit: DatabaseOperationAdmission;
    listTargets?: DatabaseActionProducers['listTargets'];
}>): DatabaseActionProducers & Required<Pick<DatabaseActionProducers, 'executeOperation'>> {
    return { listTargets: options.listTargets, async executeOperation(input, context) {
        // The registered Action identity and its declaration are admitted by the SDK.
        const access = databaseActionOperationClass(context.contribution.qualifiedId as DatabaseActionIdV1, input);
        let result: DatabaseOperationResultV1;
        if (access === 'read' && input.subscriptionId) {
            // The demand was opened for whoever subscribed; this request is admitted for its own requester first.
            await options.admit({ input, context, access });
            // A host-owned demand validates its captured target and keeps its existing connection.
            // The same plugin's producer returns this union; the SDK validates the Action result once.
            result = await context.services.resources.invokeDemand({
                subscriptionId: input.subscriptionId, resourceId: DATABASE_CONNECTION_RESOURCE_ID_V1, input,
            }, { signal: context.signal }) as DatabaseOperationResultV1;
        } else {
            const { descriptor, connection } = await options.resolve({ input, context, access });
            try {
                result = input.operation === 'describe'
                    ? { ok: true, operation: 'describe', descriptor }
                    : await connection.execute(input, context.signal);
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
        if (result.ok && result.operation === 'stats.read' && result.observation.status === 'available') {
            const observation = projectDatabaseFindingObservation(result.observation, input.target, context);
            const subject = readAutomationDatabaseSubjectV1(observation.sourceScope.serverId, input.target);
            if (subject.ok) await emitDatabaseFindingObservation({ observation, subject: subject.subject,
                observationReceivedAt: Date.now(), observedDelta: 1 }, context);
        }
        if (result.ok && ((input.operation === 'statement.run' && input.mode === 'write')
            || (input.operation === 'edits.apply' && result.operation === 'edits.apply' && result.status === 'committed'))) {
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
        return result;
    } };
}
