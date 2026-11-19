import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { withActionFailureCauseDiagnostic } from '@happier-dev/protocol/actions/executor/actionFailureDiagnostic';
import type { ProjectNativeDockerPort, ProjectNativeRuntimeFacts } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';
import { readOwnServerDockerEndpoint } from './dockerEndpoint';

/** The selected Docker transport owns locality; observed native facts own ports. */
export async function readOwnServerDatabaseEndpointForHost(input: Readonly<{
    docker: ProjectNativeDockerPort; ports: NonNullable<ProjectNativeRuntimeFacts['configuration']>['ports'];
    containerPort: number; signal: AbortSignal;
}>): Promise<Readonly<{ host: string; port: number }>> {
    const refuse = (): never => { throw new PluginError({ code: 'database_transport_unavailable' }); };
    input.signal.throwIfAborted();
    // The CLI resolves the selected context and its retained host controls.
    const endpoint = await readOwnServerDockerEndpoint(input.docker, input.signal);
    if ('parseError' in endpoint) throw withActionFailureCauseDiagnostic(new PluginError({ code: 'database_transport_unavailable' }),
        endpoint.parseError, 'deployment.database.endpoint_parse');
    const dockerHost = endpoint.host;
    if (dockerHost === null
        || (!dockerHost.startsWith('unix://') && !dockerHost.startsWith('npipe://'))) return refuse();
    const candidates = input.ports.filter(port => Number(port.target) === input.containerPort
        && port.protocol === 'tcp' && (port.bindAddress === '127.0.0.1' || port.bindAddress === '::1')
        && Number.isInteger(Number(port.published)) && Number(port.published) > 0 && Number(port.published) <= 65535);
    if (candidates.length !== 1) return refuse();
    return { host: candidates[0]!.bindAddress!, port: Number(candidates[0]!.published) };
}
