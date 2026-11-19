import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { BlockList, connect, createServer, isIPv4, type Socket } from 'node:net';
import { platform } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { NativeDockerEngineFacts } from '@happier-dev/cli-common/machineSetup';
import type { ProjectNativeDockerPort } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';
import { readOwnServerDockerEndpoint } from './dockerEndpoint';

type UnavailableReason = 'docker_desktop_unsupported' | 'host_platform_unsupported' | 'remote_docker_unsupported'
    | 'docker_endpoint_unobservable' | 'docker_network_inspect_failed' | 'docker_network_inspection_invalid'
    | 'docker_network_driver_unsupported' | 'listener_bind_failed' | 'relay_image_pull_failed' | 'relay_container_failed';

export class PrivateServiceContainerBridgeUnavailableError extends PluginError {
    constructor(readonly reason: UnavailableReason, readonly phase: 'platform' | 'network_inspect' | 'listener' | 'relay',
        options?: ErrorOptions) {
        super({ code: 'private_service_container_bridge_unavailable', message: reason, details: { reason, phase },
            failureCause: { phase: `deployment.reference.${phase}`, errorClass: 'Error', errorCode: reason, httpStatus: null } }, options);
    }
}

export type PrivateServiceContainerBridge = Readonly<{
    host: string;
    port: number;
    networkId: string;
    networkName: string;
    close(): Promise<void>;
}>;

// Docker Official HAProxy 3.2 Alpine, OCI index for the selected engine platform.
const relayImage = 'docker.io/library/haproxy@sha256:1c3568e520453cc8ba98c39501febcf450429c80e6cc27ecad779961d76e597c';
const relayPort = 8080;
const relayPrefix = 'happier-relay-';
const relayName = /^happier-relay-[a-f0-9]{32}$/u;
const directoryLabel = 'dev.happier.private-relay.directory';
// Linux bounds Unix socket paths. The inherited TMPDIR can exceed that bound.
const relaySocketRoot = '/tmp';
const socketFile = 'forward.sock';
const mountTarget = '/happier-relay';
const networkInspection = z.array(z.object({
    Id: z.string().min(1), Name: z.string().min(1), Driver: z.string(), Scope: z.string(),
    IPAM: z.object({ Config: z.array(z.object({ Subnet: z.string(), Gateway: z.string().optional() })) }),
})).length(1);

export function readPrivateServiceContainerRelayHost(address: Readonly<{ host: string; port: number }>): string | null {
    return address.port === relayPort && relayName.test(address.host) ? address.host : null;
}

/** The container owns the TCP listener and enforces the admitted subnet. The
 * host only serves its forward through the relay's private bind mount. */
export async function acquirePrivateServiceContainerBridge(input: Readonly<{
    docker: ProjectNativeDockerPort;
    engine: NativeDockerEngineFacts;
    networkId: string;
    forward: Readonly<{ host: string; port: number }>;
    route: Readonly<{ key: string }> | Readonly<{ restoredHost: string }>;
    signal?: AbortSignal;
}>): Promise<PrivateServiceContainerBridge> {
    input.signal?.throwIfAborted();
    if (input.engine.kind === 'dockerDesktop') throw new PrivateServiceContainerBridgeUnavailableError('docker_desktop_unsupported', 'platform');
    if (platform() !== 'linux') throw new PrivateServiceContainerBridgeUnavailableError('host_platform_unsupported', 'platform');
    let endpoint: string | null;
    try {
        const observed = await readOwnServerDockerEndpoint(input.docker, input.signal);
        if ('parseError' in observed) throw observed.parseError;
        endpoint = observed.host;
    } catch (cause) {
        input.signal?.throwIfAborted();
        throw new PrivateServiceContainerBridgeUnavailableError('docker_endpoint_unobservable', 'platform', { cause });
    }
    input.signal?.throwIfAborted();
    if (!endpoint) throw new PrivateServiceContainerBridgeUnavailableError('docker_endpoint_unobservable', 'platform');
    if (!endpoint.startsWith('unix://')) throw new PrivateServiceContainerBridgeUnavailableError('remote_docker_unsupported', 'platform');

    const run = async (args: readonly string[], reason: UnavailableReason, phase: 'network_inspect' | 'relay', signal = input.signal) => {
        try {
            signal?.throwIfAborted();
            const result = await input.docker.run(args, signal);
            if (result.exitCode !== 0 || result.stdoutTruncated) throw Object.assign(new Error('Docker operation failed'), { exitCode: result.exitCode });
            return result.stdout.trim();
        } catch (cause) {
            signal?.throwIfAborted();
            throw new PrivateServiceContainerBridgeUnavailableError(reason, phase, { cause });
        }
    };
    const inspected = await run(['network', 'inspect', input.networkId], 'docker_network_inspect_failed', 'network_inspect');
    let network: z.infer<typeof networkInspection>[number];
    try { network = networkInspection.parse(JSON.parse(inspected))[0]!; }
    catch (cause) { throw new PrivateServiceContainerBridgeUnavailableError('docker_network_inspection_invalid', 'network_inspect', { cause }); }
    if (network.Driver !== 'bridge' || network.Scope !== 'local') {
        throw new PrivateServiceContainerBridgeUnavailableError('docker_network_driver_unsupported', 'network_inspect');
    }
    // Preserve IPv4 reach and derive the ACL from native IPAM. Parse before
    // projecting these values into the relay's configuration language.
    const ipv4 = network.IPAM.Config.find(({ Subnet }) => !Subnet.includes(':'));
    const subnet = ipv4?.Subnet ?? '';
    const gateway = ipv4?.Gateway ?? '';
    try {
        const [address, prefix, extra] = subnet.split('/');
        if (!address || !isIPv4(address) || prefix === undefined || !/^\d+$/u.test(prefix) || extra !== undefined || !isIPv4(gateway)) {
            throw new Error('Invalid IPv4 subnet or gateway');
        }
        const range = new BlockList();
        range.addSubnet(address, Number(prefix), 'ipv4');
        if (!range.check(gateway, 'ipv4')) throw new Error('Gateway outside the IPv4 subnet');
    } catch (cause) { throw new PrivateServiceContainerBridgeUnavailableError('docker_network_inspection_invalid', 'network_inspect', { cause }); }

    const uid = process.getuid!();
    const gid = process.getgid!();
    const host = 'restoredHost' in input.route ? input.route.restoredHost : relayPrefix +
        createHash('sha256').update(JSON.stringify([uid, input.engine.id, network.Id, input.route.key])).digest('hex').slice(0, 32);
    if (!relayName.test(host)) throw new PrivateServiceContainerBridgeUnavailableError('relay_container_failed', 'relay');

    // List by both name and ownership label. Docker refuses a conflicting name
    // held by a foreign container. Cleanup always targets the observed immutable ID.
    const orphan = await run(['container', 'ls', '--all', '--no-trunc', '--filter', `name=^/${host}$`,
        '--filter', `label=${directoryLabel}`, '--format', `{{.ID}} {{.Label "${directoryLabel}"}}`], 'relay_container_failed', 'relay');
    if (orphan) {
        const [id, ...paths] = orphan.split(' ');
        const oldDirectory = paths.join(' ');
        if (!id || !/^[a-f0-9]{64}$/u.test(id)) throw new PrivateServiceContainerBridgeUnavailableError('relay_container_failed', 'relay');
        await run(['container', 'rm', '--force', id], 'relay_container_failed', 'relay');
        const oldName = basename(oldDirectory);
        if (dirname(oldDirectory) === relaySocketRoot && oldName.startsWith(`${host}-`) && /^[a-zA-Z0-9]{6}$/u.test(oldName.slice(host.length + 1))) {
            await rm(oldDirectory, { recursive: true, force: true });
        }
    }
    const present = await input.docker.run(['image', 'inspect', '--format', '{{.Id}}', relayImage], input.signal).catch(() => null);
    if (present?.exitCode !== 0) await run(['image', 'pull', relayImage], 'relay_image_pull_failed', 'relay');
    input.signal?.throwIfAborted();

    let directory: string | undefined;
    let containerId: string | undefined;
    const server = createServer({ allowHalfOpen: true, pauseOnConnect: true });
    const sockets = new Set<Socket>();
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => closing ??= (async () => {
        input.signal?.removeEventListener('abort', onAbort);
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve, reject) => server.close(error => {
            if (error && 'code' in error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
            else resolve();
        }));
        // The caller's signal has often already ended when custody retires.
        // A failed removal leaves an owned orphan for the next acquisition.
        if (containerId) {
            if (input.docker.removeOwnedContainer) {
                try {
                    const removed = await input.docker.removeOwnedContainer(containerId);
                    if (removed.exitCode !== 0) throw new Error('Docker container removal failed');
                } catch (cause) { throw new PrivateServiceContainerBridgeUnavailableError('relay_container_failed', 'relay', { cause }); }
            } else {
                await run(['container', 'rm', '--force', containerId], 'relay_container_failed', 'relay', new AbortController().signal);
            }
        }
        if (directory) await rm(directory, { recursive: true, force: true });
    })();
    const onAbort = () => { void close().catch(() => undefined); };
    server.on('connection', client => {
        if (closing) { client.destroy(); return; }
        const target = connect({ host: input.forward.host, port: input.forward.port, allowHalfOpen: true });
        sockets.add(client); sockets.add(target);
        const release = () => { client.destroy(); target.destroy(); };
        client.once('error', release); target.once('error', release);
        // After a graceful EOF, pipe has ended the peer's writable side.
        // Let it flush pending bytes before closing the other socket.
        client.once('close', () => {
            sockets.delete(client);
            if (!client.readableEnded) target.destroy();
        });
        target.once('close', () => {
            sockets.delete(target);
            if (!target.readableEnded) client.destroy();
        });
        target.once('connect', () => {
            // Native streams own backpressure and independent EOF propagation.
            client.pipe(target); target.pipe(client); client.resume();
        });
    });
    let phase: 'listener' | 'relay' = 'listener';
    try {
        directory = await mkdtemp(join(relaySocketRoot, `${host}-`));
        const config = [
            'defaults', '    mode tcp', '    retries 0',
            'listen forward', `    bind 0.0.0.0:${relayPort}`,
            `    acl consumer_subnet src ${subnet}`,
            // Docker can masquerade traffic from another bridge as this gateway.
            `    acl bridge_gateway src ${gateway}`,
            '    tcp-request connection reject unless consumer_subnet !bridge_gateway',
            `    server forward unix@${mountTarget}/${socketFile}`, '',
        ].join('\n');
        await writeFile(join(directory, 'haproxy.cfg'), config, { mode: 0o600 });
        const listening = once(server, 'listening', { signal: input.signal });
        server.listen(join(directory, socketFile));
        await listening;
        phase = 'relay';
        const source = `src=${directory}`;
        const mount = /[,"]/u.test(source) ? `"${source.replaceAll('"', '""')}"` : source;
        containerId = await run(['container', 'create', '--pull', 'never', '--name', host,
            '--label', `${directoryLabel}=${directory}`, '--restart', 'unless-stopped',
            '--user', `${uid}:${gid}`, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
            '--network', network.Id, '--network-alias', host, '--mount', `type=bind,${mount},dst=${mountTarget},readonly`,
            relayImage, 'haproxy', '-f', `${mountTarget}/haproxy.cfg`], 'relay_container_failed', 'relay');
        if (!/^[a-f0-9]{64}$/u.test(containerId)) {
            containerId = undefined;
            throw new PrivateServiceContainerBridgeUnavailableError('relay_container_failed', 'relay');
        }
        await run(['container', 'start', containerId], 'relay_container_failed', 'relay');
        input.signal?.throwIfAborted();
        server.on('error', onAbort);
        input.signal?.addEventListener('abort', onAbort, { once: true });
        return { host, port: relayPort, networkId: network.Id, networkName: network.Name, close };
    } catch (cause) {
        await close().catch(() => undefined);
        input.signal?.throwIfAborted();
        if (cause instanceof PrivateServiceContainerBridgeUnavailableError) throw cause;
        throw new PrivateServiceContainerBridgeUnavailableError(phase === 'listener' ? 'listener_bind_failed' : 'relay_container_failed', phase, { cause });
    }
}
