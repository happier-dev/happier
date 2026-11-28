import type { CreatePluginInvocationServices } from '@/plugins/runtime/invocation/services/types';
import type { DeploymentDatabasesServiceV1 } from '@happier-dev/plugin-sdk';
import type { DeploymentDatabasesHostInput } from './createDeploymentDatabasesServiceForHost';

function deferDeploymentDatabasesService(input: DeploymentDatabasesHostInput): DeploymentDatabasesServiceV1 {
    let service: Required<DeploymentDatabasesServiceV1> | undefined;
    const load = async () => {
        const { createDeploymentDatabasesServiceForHost } = await import('./createDeploymentDatabasesServiceForHost');
        return service ??= createDeploymentDatabasesServiceForHost(input);
    };
    return Object.freeze<Required<DeploymentDatabasesServiceV1>>({
        attachReadAccess: async request => (await load()).attachReadAccess(request),
        createReadAccess: async request => (await load()).createReadAccess(request),
        admitTelemetryRead: async request => (await load()).admitTelemetryRead(request),
        admitTelemetryClear: async request => (await load()).admitTelemetryClear(request),
        listTargets: async request => (await load()).listTargets(request),
        resolve: async (request, access) => (await load()).resolve(request, access),
        admit: async (request, access) => (await load()).admit(request, access),
    });
}

/** Action and Resource invocations share the same captured deployment attachment. */
export function createDeploymentDatabasesInvocationServicesForHost(
    input: Omit<DeploymentDatabasesHostInput, 'seed'>,
): CreatePluginInvocationServices {
    return (seed, ...args) => input.createServices({ ...seed,
        ...(seed.approvalContext ? { deploymentDatabases: deferDeploymentDatabasesService({ ...input, seed }) } : {}),
    }, ...args);
}
