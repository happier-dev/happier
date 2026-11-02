import type { ActionExecutorContext, ActionExecuteFailure, DeploymentRestartInputV1, MachineServiceControlResultV1 } from '@happier-dev/protocol';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import { withMachineServiceControlTarget } from '@/daemon/local/services/launch/machineServiceTarget';
import { controlNativeServiceForHost } from '@/daemon/local/services/launch/nativeServiceControl';

const failure = (errorCode: string): ActionExecuteFailure => ({ ok: false, errorCode, error: errorCode });

/** Source authority is admitted once at mint; native custody stays on the existing handle. */
export function createDeploymentRestartActionForHost(host: Readonly<{
    serverId: string;
    machineId: string;
    assertCurrent(context: ActionExecutorContext): Promise<void>;
}>): (request: DeploymentRestartInputV1, context: ActionExecutorContext) => Promise<MachineServiceControlResultV1 | ActionExecuteFailure> {
    return async (request, context) => {
        try {
            await host.assertCurrent(context);
            if (request.serverId !== host.serverId || request.machineId !== host.machineId
                || readInstallationIdentityIfExistsSync()?.installationId !== request.installationId) return failure('target_mismatch');
            const acceptance = context.operationAcceptance;
            if (!acceptance || acceptance.actionId !== 'deployments.restart') return failure('service_operation_unavailable');
            return await withMachineServiceControlTarget({ serverId: host.serverId, machineId: host.machineId,
                request: { serverId: request.serverId, machineId: request.machineId, serviceId: request.service.serviceId,
                    expectedGeneration: request.expectedGeneration },
                approvalScope: { kind: 'environment', environmentId: request.environmentId },
                ...(context.signal ? { signal: context.signal } : {}), assertCurrent: async () => { context.signal?.throwIfAborted(); },
            }, async handle => {
                if (handle.kind !== 'environment' || handle.environmentId !== request.environmentId
                    || handle.deploymentId !== request.deploymentId) return failure('service_unavailable');
                return controlNativeServiceForHost({ handle, operation: 'restart', operationId: acceptance.operationId,
                    context, ...(context.signal ? { signal: context.signal } : {}) });
            });
        } catch (error) {
            const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'deployment_unavailable';
            return failure(context.signal?.aborted ? 'cancelled' : code);
        }
    };
}
