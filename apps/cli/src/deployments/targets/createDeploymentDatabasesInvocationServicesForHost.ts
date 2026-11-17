import type { CreatePluginInvocationServices } from '@/plugins/runtime/invocation/services/types';
import { createDeploymentDatabasesServiceForHost, type DeploymentDatabasesHostInput } from './createDeploymentDatabasesServiceForHost';

/** Action and Resource invocations share the same captured deployment attachment. */
export function createDeploymentDatabasesInvocationServicesForHost(
    input: Omit<DeploymentDatabasesHostInput, 'seed'>,
): CreatePluginInvocationServices {
    return (seed, ...args) => input.createServices({ ...seed,
        ...(seed.approvalContext ? { deploymentDatabases: createDeploymentDatabasesServiceForHost({ ...input, seed }) } : {}),
    }, ...args);
}
