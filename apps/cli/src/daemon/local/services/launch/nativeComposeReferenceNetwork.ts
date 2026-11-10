import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { ProjectNativeDockerPort } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const unavailable = (reason: string): never => { throw new PluginError({ code: 'private_service_container_bridge_unavailable',
    message: reason, details: { reason }, failureCause: { phase: 'deployment.reference.network',
        errorClass: 'Error', errorCode: reason, httpStatus: null } }); };

type ReferenceNetworkInput = Readonly<{ model: Readonly<Record<string, unknown>>; services: readonly string[];
    referenceAddresses: readonly string[] }>;
type ReferenceNetwork = Readonly<{ key: string; name: string; definition: Readonly<Record<string, unknown>> }>;

/** Native Compose has already normalized network names and service membership. */
export function readNativeComposeReferenceNetwork(input: ReferenceNetworkInput): ReferenceNetwork | null {
    if (!record(input.model.services)) return unavailable('consumer_network_unavailable');
    // Native Compose has already performed interpolation and environment binding.
    // Match its resolved values rather than maintaining an expression parser.
    const consumesReference = (value: unknown): boolean => typeof value === 'string'
        ? input.referenceAddresses.some(address => value.includes(address))
        : Array.isArray(value) ? value.some(consumesReference)
        : record(value) && Object.values(value).some(consumesReference);
    let common: string[] | undefined;
    for (const name of input.services) {
        const service = input.model.services[name];
        if (!record(service)) return unavailable('consumer_network_unavailable');
        if (!consumesReference(service)) continue;
        // A host-network process can use the original host loopback listener.
        if (service.network_mode === 'host') continue;
        if (service.network_mode !== undefined) return unavailable('consumer_network_mode_unsupported');
        const keys = record(service.networks) ? Object.keys(service.networks) : ['default'];
        common = common === undefined ? keys : common.filter(key => keys.includes(key));
    }
    if (common === undefined) return null;
    const key = common[0];
    if (!key) return unavailable('consumer_network_not_shared');
    const definition = record(input.model.networks) ? input.model.networks[key] : undefined;
    if (!record(definition) || typeof definition.name !== 'string' || !definition.name) return unavailable('consumer_network_unavailable');
    if (definition.driver !== undefined && definition.driver !== 'bridge') return unavailable('docker_network_driver_unsupported');
    return { key, name: definition.name, definition };
}

/** Let Compose create/reconcile its own network and config hash. A service with
 * zero replicas uses an already-acquired image; no helper image or container is
 * introduced, and existing app services remain unselected and unscaled.
 * Contract basis: Docker Compose v2.39.4 create.go ensureNetworks precedes
 * convergence; cmd/compose/create.go supports --scale and keeps orphans by default.
 */
export async function prepareNativeComposeReferenceNetwork(input: ReferenceNetworkInput & Readonly<{
    docker: ProjectNativeDockerPort;
    projectName: string;
    sourceRoot: string;
    directory: string;
    imageReference: string;
    signal?: AbortSignal;
}>): Promise<string | null> {
    const network = readNativeComposeReferenceNetwork(input);
    if (!network) return null;
    input.signal?.throwIfAborted();
    const services = record(input.model.services) ? input.model.services : {};
    let service = 'happier-reference-network';
    while (Object.hasOwn(services, service)) service += '-setup';
    const projection = { services: { [service]: { image: input.imageReference, networks: [network.key] } },
        networks: { [network.key]: network.definition } };
    const file = join(input.directory, 'reference-network.compose.json');
    await writeFile(file, JSON.stringify(projection), { mode: 0o600 });
    const prepared = await input.docker.run(['compose', '--project-name', input.projectName,
        '--project-directory', input.sourceRoot, '--file', file, 'create', '--no-build', '--pull', 'never',
        '--scale', `${service}=0`, service], input.signal);
    input.signal?.throwIfAborted();
    if (prepared.exitCode !== 0) return unavailable('consumer_network_prepare_failed');
    return network.name;
}
