import { randomUUID } from 'node:crypto';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import type { DeploymentDataSizeInputV1 } from '@happier-dev/protocol/deployments/deploymentReadsV1';
import type { DatabaseDescriptorV1 } from '@happier-dev/plugin-sdk/database';
import { readDeploymentDatabaseSizesV1 } from '@happier-dev/deployments';
import { projectDeploymentException } from '../deploymentFailure';
import { openOwnServerDatabaseConnectionForHost } from '../targets/ownServer/databaseConnection';

/** Deployment size is a finite native read, independent of optional workbench activation. */
export function createDeploymentDataSizeActionForHost(
    host: Parameters<typeof openOwnServerDatabaseConnectionForHost>[0]['host'],
) {
    return async (input: DeploymentDataSizeInputV1, context: ActionExecutorContext) => {
        try {
            if (input.serverId !== host.serverId || input.machineId !== host.machineId) {
                return { ok: false as const, errorCode: 'target_mismatch', error: 'target_mismatch' };
            }
            const environment = await host.readEnvironment({ environmentId: input.environmentId,
                targetLinkId: input.targetLinkId, context });
            const signal = context.signal ?? new AbortController().signal;
            const selected = { kind: 'deployment_service' as const,
                environment: { serverId: input.serverId, projectSourceId: environment.environment.projectSourceId,
                    environmentId: input.environmentId }, targetLinkId: input.targetLinkId,
                deploymentId: input.deploymentId, serviceId: input.service };
            let connection: Awaited<ReturnType<typeof openOwnServerDatabaseConnectionForHost>> | undefined;
            try {
                const sizes = await readDeploymentDatabaseSizesV1({ environment: environment.environment,
                    content: { ...environment.content, template: environment.content.template && {
                        ...environment.content.template, data: environment.content.template.data?.filter(row => row.service === input.service) } },
                    readTargets: async () => {
                        connection = await openOwnServerDatabaseConnectionForHost({ host, target: selected,
                            environment, expectedRevision: input.expectedRevision, installationId: input.installationId, context, signal,
                            operationId: context.actionRequestId ?? randomUUID() });
                        const descriptor: DatabaseDescriptorV1 = { target: { ...selected, database: connection.database },
                            engine: connection.engine, label: input.service, origin: { label: 'Active deployment' },
                            placement: { serverId: input.serverId, accountId: context.runtimeAccountId ?? '',
                                machineId: input.machineId, installationId: input.installationId }, capabilities: [] };
                        return { targets: [descriptor], completeness: { complete: true } };
                    },
                    run: request => connection!.execute(request, signal), previous: input.previous ? [input.previous] : [] });
                const size = sizes[0];
                return size ? { ok: true as const, size }
                    : { ok: false as const, errorCode: 'target_mismatch', error: 'target_mismatch' };
            } finally { await connection?.close(); }
        } catch (error) {
            return projectDeploymentException(error, { signal: context.signal, phase: 'deployment.data.size' });
        }
    };
}
