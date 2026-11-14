import type { ManagedServices } from '@happier-dev/plugin-sdk/managed-services';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import type { DeploymentTargetRoleAdmissionForHost, DeploymentTargetRoleAdmissionHost } from './admitDeploymentTargetRoleForHost';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type { ManagedWorkloadAdmissionForHost } from '@/plugins/runtime/invocation/services/managedWorkloads';

/** Consume the role owner's admitted Environment; source acquisition stays separate. */
export function createDeploymentTargetRoleWorkloadBindingForHost(input: Readonly<{
    admission: DeploymentTargetRoleAdmissionForHost;
    host: DeploymentTargetRoleAdmissionHost;
    context: ActionExecutorContext;
    ensureEnvironmentServices: import('@/plugins/runtime/invocation/services/environmentServiceRecovery').EnsureEnvironmentServices;
    readOwner(): ResolvedExecutablePluginRuntimeRegistry['projectManagedServices'] | undefined;
}>): ManagedServices['observeWorkload'] | undefined {
    const { admission, host, context } = input;
    const environment = admission.environment;
    const receipt = admission.receipt;
    const signal = context.signal;
    if (!environment || !signal) return undefined;
    const environmentId = environment.environment.id;
    const nativeOperation = 'workloadControl' in admission ? admission.workloadControl : undefined;
    const control: ManagedWorkloadAdmissionForHost['control'] = nativeOperation
        ? (handle, operation, options) => handle.controlNative
            ? handle.controlNative(operation, { ...options, operation: nativeOperation })
            : Promise.resolve({ kind: 'unsupported', reason: 'unsupported' })
        : undefined;
    return async (request, options) => {
        const owner = input.readOwner();
        if (!owner) return { kind: 'unavailable', reason: 'admission_unavailable' };
        return owner.bindWorkloads({
            target: { serverId: host.serverId, machineId: host.machineId },
            signal,
            // Environment read was decided by admitDeploymentTargetRoleForHost.
            disclosure: { requesterAccountId: host.credentialOwnerAccountId,
                canReadEnvironments: async () => new Set([environmentId]) },
            select: handle => handle.kind === 'environment' && handle.environmentId === environmentId
                && (!receipt || handle.deploymentId === receipt.deployment.id),
            ensureRecovered: () => input.ensureEnvironmentServices({ environmentId, serviceId: request.serviceId }),
            ...(control ? { control } : {}),
        })(request, options);
    };
}
