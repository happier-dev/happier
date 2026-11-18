import { z } from 'zod';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { ProjectNativeDockerPort } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';
import type { OwnServerDeploymentRuntimeAcquisition } from './ownServerDeploymentTarget';
import type { PrivateServiceExportAdmissionForHost } from './privateServiceReference';

const networks = z.array(z.object({ Id: z.string().min(1), Name: z.string(), Driver: z.string(), Scope: z.string() }));

function unavailable(reason: string, phase: 'source' | 'network_inspect', cause?: unknown): never {
    throw new PluginError({ code: 'reference_unavailable', message: reason, details: { reason, phase },
        failureCause: { phase: `deployment.reference.local.${phase}`, errorClass: 'Error', errorCode: reason, httpStatus: null } },
    cause === undefined ? undefined : { cause });
}

/** Consume the admitted source's native capture; Docker owns its private DNS
 * name and network identity. No host publication or gateway is involved. */
export async function resolvePrivateServiceLocalContainerAddress(input: Readonly<{
    admission: Extract<PrivateServiceExportAdmissionForHost, { kind: 'local' }>;
    owner: Pick<OwnServerDeploymentRuntimeAcquisition['projectManagedServices'], 'resolveEnvironmentService'>;
    homeServerIdentityId: string;
    docker: ProjectNativeDockerPort;
    signal?: AbortSignal;
}>): Promise<Readonly<{ host: string; port: number; networkId: string }>> {
    input.signal?.throwIfAborted();
    const handle = input.owner.resolveEnvironmentService(input.homeServerIdentityId, input.admission.serviceExport.service);
    const containers = handle?.readNativeContainers?.();
    if (!handle?.readNativeDocker || !containers?.length) return unavailable('service_native_capture_unavailable', 'source');
    const sourceDocker = await handle.readNativeDocker({ signal: input.signal });
    input.signal?.throwIfAborted();
    if (sourceDocker.engineId !== input.docker.engineId) return unavailable('docker_engine_mismatch', 'source');
    const names = [...new Set(containers.flatMap(container => container.containerName ? container.networkNames ?? [] : []))];
    if (!names.length) return unavailable('service_container_network_unavailable', 'source');
    let inspected: Awaited<ReturnType<ProjectNativeDockerPort['run']>>;
    try { inspected = await input.docker.run(['network', 'inspect', ...names], input.signal); }
    catch (cause) {
        input.signal?.throwIfAborted();
        return unavailable('docker_network_inspect_failed', 'network_inspect', cause);
    }
    input.signal?.throwIfAborted();
    if (inspected.exitCode !== 0) return unavailable('docker_network_inspect_failed', 'network_inspect',
        Object.assign(new Error('Docker network inspection failed'), { exitCode: inspected.exitCode }));
    let observed: z.infer<typeof networks>;
    try { observed = networks.parse(JSON.parse(inspected.stdout)); }
    catch (cause) { return unavailable('docker_network_inspection_invalid', 'network_inspect', cause); }
    // Admission already selected one TCP publication. Native captures
    // may retain multiple replicas; use a captured member without imposing a cap.
    for (const container of containers) {
        // Docker's built-in bridge has no embedded DNS for container names.
        const network = observed.find(item => item.Driver === 'bridge' && item.Scope === 'local' && item.Name !== 'bridge'
            && container.networkNames?.includes(item.Name));
        if (container.containerName && network) return { host: container.containerName, port: input.admission.containerPort, networkId: network.Id };
    }
    return unavailable('service_bridge_network_unavailable', 'network_inspect');
}
