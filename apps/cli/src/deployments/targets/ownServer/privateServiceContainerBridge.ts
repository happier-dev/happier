import { once } from 'node:events';
import { BlockList, connect, createServer, isIPv4, type Socket } from 'node:net';
import { networkInterfaces, platform } from 'node:os';
import { z } from 'zod';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { NativeDockerEngineFacts } from '@happier-dev/cli-common/machineSetup';
import type { ProjectNativeDockerPort } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';

type UnavailableReason = 'docker_desktop_unsupported' | 'host_platform_unsupported' | 'docker_network_inspect_failed'
    | 'docker_network_inspection_invalid' | 'docker_network_driver_unsupported' | 'gateway_outside_host_namespace'
    | 'network_address_family_unsupported' | 'listener_bind_failed';

export class PrivateServiceContainerBridgeUnavailableError extends PluginError {
    constructor(readonly reason: UnavailableReason, readonly phase: 'platform' | 'network_inspect' | 'listener',
        options?: ErrorOptions) {
        super({ code: 'private_service_container_bridge_unavailable', message: reason, details: { reason, phase },
            failureCause: { phase: `deployment.reference.${phase}`, errorClass: 'Error', errorCode: reason, httpStatus: null } }, options);
    }
}

export type PrivateServiceContainerBridge = Readonly<{
    host: string;
    port: number;
    networkId: string;
    close(): Promise<void>;
}>;

const networkInspection = z.array(z.object({
    Id: z.string(), Driver: z.string(), Scope: z.string(),
    IPAM: z.object({ Config: z.array(z.object({ Subnet: z.string(), Gateway: z.string().optional() })) }),
})).length(1);

/** Borrow the admitted generation's Docker transport. The deployment retains
 * this bridge alongside its Iroh forward until the consuming service stops.
 * A bridge gateway is host-local on native Linux Docker; Desktop/rootless or
 * remote engines need a separate adapter and never receive a wildcard fallback.
 */
export async function acquirePrivateServiceContainerBridge(input: Readonly<{
    docker: ProjectNativeDockerPort;
    engine: NativeDockerEngineFacts;
    networkId: string;
    forward: Readonly<{ host: '127.0.0.1'; port: number }>;
    preferredListenPort?: number;
    signal?: AbortSignal;
}>): Promise<PrivateServiceContainerBridge> {
    input.signal?.throwIfAborted();
    if (input.engine.kind === 'dockerDesktop') throw new PrivateServiceContainerBridgeUnavailableError('docker_desktop_unsupported', 'platform');
    if (platform() !== 'linux') throw new PrivateServiceContainerBridgeUnavailableError('host_platform_unsupported', 'platform');
    let inspected: Awaited<ReturnType<ProjectNativeDockerPort['run']>>;
    try { inspected = await input.docker.run(['network', 'inspect', input.networkId], input.signal); }
    catch (cause) {
        input.signal?.throwIfAborted();
        throw new PrivateServiceContainerBridgeUnavailableError('docker_network_inspect_failed', 'network_inspect', { cause });
    }
    input.signal?.throwIfAborted();
    if (inspected.exitCode !== 0) throw new PrivateServiceContainerBridgeUnavailableError('docker_network_inspect_failed', 'network_inspect',
        { cause: Object.assign(new Error('Docker network inspection failed'), { exitCode: inspected.exitCode }) });
    let parsed: z.infer<typeof networkInspection>;
    try { parsed = networkInspection.parse(JSON.parse(inspected.stdout)); }
    catch (cause) { throw new PrivateServiceContainerBridgeUnavailableError('docker_network_inspection_invalid', 'network_inspect', { cause }); }
    const network = parsed[0]!;
    if (network.Driver !== 'bridge' || network.Scope !== 'local') {
        throw new PrivateServiceContainerBridgeUnavailableError('docker_network_driver_unsupported', 'network_inspect');
    }
    const ipv4Gateways = network.IPAM.Config.filter(config => config.Gateway && isIPv4(config.Gateway));
    if (!ipv4Gateways.length) throw new PrivateServiceContainerBridgeUnavailableError('network_address_family_unsupported', 'network_inspect');
    const hostAddresses = new Set(Object.values(networkInterfaces()).flatMap(entries => entries?.map(entry => entry.address) ?? []));
    const selected = ipv4Gateways.find(config => config.Gateway && hostAddresses.has(config.Gateway));
    if (!selected?.Gateway) throw new PrivateServiceContainerBridgeUnavailableError('gateway_outside_host_namespace', 'network_inspect');
    const admittedSources = new BlockList();
    try {
        const [address, prefix, extra] = selected.Subnet.split('/');
        if (!address || !isIPv4(address) || prefix === undefined || !/^\d+$/u.test(prefix) || extra !== undefined) throw new Error('Invalid IPv4 subnet');
        admittedSources.addSubnet(address, Number(prefix), 'ipv4');
    } catch (cause) { throw new PrivateServiceContainerBridgeUnavailableError('docker_network_inspection_invalid', 'network_inspect', { cause }); }

    const server = createServer({ allowHalfOpen: true, pauseOnConnect: true });
    const sockets = new Set<Socket>();
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => {
        closing ??= (async () => {
            input.signal?.removeEventListener('abort', onAbort);
            for (const socket of sockets) socket.destroy();
            await new Promise<void>((resolve, reject) => server.close(error => {
                if (error && 'code' in error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
                else resolve();
            }));
        })();
        return closing;
    };
    const onAbort = () => { void close().catch(() => undefined); };
    server.on('connection', client => {
        // Binding the gateway alone does not exclude another host interface's
        // clients. Docker's actual network subnet defines this bridge's scope.
        if (closing || !client.remoteAddress || !admittedSources.check(client.remoteAddress, 'ipv4')) { client.destroy(); return; }
        const target = connect({ host: input.forward.host, port: input.forward.port, allowHalfOpen: true });
        sockets.add(client); sockets.add(target);
        const release = () => { client.destroy(); target.destroy(); };
        client.once('error', release); target.once('error', release);
        client.once('close', () => { sockets.delete(client); target.destroy(); });
        target.once('close', () => { sockets.delete(target); client.destroy(); });
        target.once('connect', () => {
            // Native streams own backpressure and independent EOF propagation.
            client.pipe(target); target.pipe(client); client.resume();
        });
    });
    server.on('error', onAbort);
    input.signal?.addEventListener('abort', onAbort, { once: true });
    try {
        input.signal?.throwIfAborted();
        const listening = once(server, 'listening', { signal: input.signal });
        server.listen({ host: selected.Gateway, port: input.preferredListenPort ?? 0, exclusive: true });
        await listening;
        input.signal?.throwIfAborted();
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('No bridge listener');
        return { host: selected.Gateway, port: address.port, networkId: network.Id, close };
    } catch (cause) {
        await close();
        input.signal?.throwIfAborted();
        throw new PrivateServiceContainerBridgeUnavailableError('listener_bind_failed', 'listener', { cause });
    }
}
