import { once } from 'node:events';
import { connect, createServer, type Socket } from 'node:net';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ProjectNativeDockerPort } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';
import { projectDeploymentFailure } from '@/deployments/deploymentFailure';
import { acquirePrivateServiceContainerBridge } from './privateServiceContainerBridge';

// test-policy-boundary: OS interface discovery is external; real TCP sockets exercise the bridge.
vi.mock('node:os', () => ({ platform: () => 'linux', networkInterfaces: () => ({
    'br-consumer': [{ address: '127.0.0.2', family: 'IPv4', internal: false }],
}) }));

const network = { Id: 'consumer-network', Driver: 'bridge', Scope: 'local',
    IPAM: { Config: [{ Subnet: '127.0.0.0/24', Gateway: '127.0.0.2' }] } };
const engine = { id: 'local-engine', kind: 'native' as const };
const sockets = new Set<Socket>();
const cleanup: Array<() => Promise<void>> = [];
let dockerReads: readonly string[][];
let docker: ProjectNativeDockerPort;

beforeEach(() => {
    const reads: string[][] = [];
    dockerReads = reads;
    // Docker CLI is the process boundary. No network selection or forwarding logic is mocked.
    docker = { engineId: engine.id, run: async args => {
        reads.push([...args]);
        return { exitCode: 0, stdout: JSON.stringify([network]) };
    } };
});
afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    for (const close of cleanup.splice(0).reverse()) await close();
});

async function destination() {
    const server = createServer({ allowHalfOpen: true }, socket => {
        sockets.add(socket);
        const bytes: Buffer[] = [];
        socket.on('data', chunk => bytes.push(chunk));
        socket.on('end', () => socket.end(Buffer.concat(bytes).reverse()));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No destination');
    return { host: '127.0.0.1' as const, port: address.port };
}

it('forwards simultaneous binary clients with half-close through only the inspected network gateway', async () => {
    // Reserve the same port on another host interface. A wildcard bridge bind
    // cannot coexist with this listener; an unrelated process may also happen
    // to listen there, so a connection-refused assertion is not deterministic.
    const outsideServer = createServer(socket => socket.destroy());
    outsideServer.listen(0, '127.0.0.1');
    await once(outsideServer, 'listening');
    cleanup.push(() => new Promise<void>(resolve => outsideServer.close(() => resolve())));
    const outsideAddress = outsideServer.address();
    if (!outsideAddress || typeof outsideAddress === 'string') throw new Error('No outside listener');
    const bridge = await acquirePrivateServiceContainerBridge({ docker, engine, networkId: network.Id,
        forward: await destination(), preferredListenPort: outsideAddress.port });
    cleanup.push(bridge.close);
    expect(bridge.host).toBe(network.IPAM.Config[0]!.Gateway);
    expect(bridge.networkId).toBe(network.Id);
    await Promise.all([Buffer.from([0, 255, 128, 1]), Buffer.alloc(256 * 1024, 17)].map(async bytes => {
        const client = connect({ host: bridge.host, port: bridge.port, localAddress: '127.0.0.3', allowHalfOpen: true });
        sockets.add(client);
        const chunks: Buffer[] = [];
        client.on('data', chunk => chunks.push(chunk));
        const ended = once(client, 'end');
        client.end(bytes);
        await ended;
        expect(Buffer.concat(chunks)).toEqual(Buffer.from(bytes).reverse());
        client.destroy();
    }));
    expect(bridge.port).toBe(outsideAddress.port);
    expect(dockerReads).toEqual([['network', 'inspect', network.Id]]);
    await bridge.close();
    await bridge.close();
});

it('refuses clients outside the consumer subnet and closes active clients on owner cancellation', async () => {
    const abort = new AbortController();
    const bridge = await acquirePrivateServiceContainerBridge({ docker, engine, networkId: network.Id,
        forward: await destination(), signal: abort.signal });
    cleanup.push(bridge.close);
    const outside = connect({ host: bridge.host, port: bridge.port, localAddress: '127.0.1.3' });
    sockets.add(outside);
    outside.on('error', () => undefined);
    await new Promise<void>(resolve => outside.once('close', () => resolve()));
    const admitted = connect({ host: bridge.host, port: bridge.port, localAddress: '127.0.0.3' });
    sockets.add(admitted);
    admitted.on('error', () => undefined);
    await once(admitted, 'connect');
    const closed = new Promise<void>(resolve => admitted.once('close', () => resolve()));
    abort.abort();
    await closed;
    await bridge.close();
});

it('drains the complete response before closing a client that applies backpressure', async () => {
    const bridge = await acquirePrivateServiceContainerBridge({ docker, engine, networkId: network.Id, forward: await destination() });
    cleanup.push(bridge.close);
    const bytes = Buffer.alloc(8 * 1024 * 1024, 173);
    const client = connect({ host: bridge.host, port: bridge.port, localAddress: '127.0.0.3', allowHalfOpen: true });
    sockets.add(client);
    const chunks: Buffer[] = [];
    const received = new Promise<void>((resolve, reject) => {
        client.on('error', reject);
        client.on('data', chunk => {
            chunks.push(chunk);
            client.pause();
            setImmediate(() => client.resume());
        });
        client.once('end', resolve);
        client.once('close', () => { if (!client.readableEnded) reject(new Error('Response closed before EOF')); });
    });
    client.end(bytes);
    await received;
    expect(Buffer.compare(Buffer.concat(chunks), Buffer.from(bytes).reverse())).toBe(0);
});

it('rebinds the recorded container endpoint during recovery and reports an occupied port without changing the address', async () => {
    const forward = await destination();
    const first = await acquirePrivateServiceContainerBridge({ docker, engine, networkId: network.Id, forward });
    cleanup.push(first.close);
    await first.close();
    const restored = await acquirePrivateServiceContainerBridge({ docker, engine, networkId: network.Id, forward,
        preferredListenPort: first.port });
    cleanup.push(restored.close);
    expect({ host: restored.host, port: restored.port }).toEqual({ host: first.host, port: first.port });
    await expect(acquirePrivateServiceContainerBridge({ docker, engine, networkId: network.Id, forward,
        preferredListenPort: first.port })).rejects.toMatchObject({
        code: 'private_service_container_bridge_unavailable', reason: 'listener_bind_failed', phase: 'listener',
        cause: expect.objectContaining({ code: 'EADDRINUSE' }),
    });
});

it('returns the specific unsupported Desktop cause before opening a network listener', async () => {
    await expect(acquirePrivateServiceContainerBridge({ docker, engine: { ...engine, kind: 'dockerDesktop' },
        networkId: network.Id, forward: { host: '127.0.0.1', port: 12345 } }))
        .rejects.toMatchObject({ code: 'private_service_container_bridge_unavailable', reason: 'docker_desktop_unsupported' });
    expect(dockerReads).toEqual([]);
});

it('preserves the bridge reason and phase through the deployment failure projection', async () => {
    const error = await acquirePrivateServiceContainerBridge({ docker, engine: { ...engine, kind: 'dockerDesktop' },
        networkId: network.Id, forward: { host: '127.0.0.1', port: 12345 } }).catch(error => error);
    expect(projectDeploymentFailure('private_service_container_bridge_unavailable', error)).toMatchObject({
        failureCause: { errorCode: 'docker_desktop_unsupported', phase: 'deployment.reference.platform' },
    });
});

it('reports a gateway outside the host namespace explicitly, without binding a host-wide fallback', async () => {
    const remoteDocker: ProjectNativeDockerPort = { engineId: engine.id, run: async () => ({ exitCode: 0,
        stdout: JSON.stringify([{ ...network, IPAM: { Config: [{ Subnet: '192.0.2.0/24', Gateway: '192.0.2.1' }] } }]) }) };
    await expect(acquirePrivateServiceContainerBridge({ docker: remoteDocker, engine, networkId: network.Id,
        forward: { host: '127.0.0.1', port: 12345 } })).rejects.toMatchObject({
        code: 'private_service_container_bridge_unavailable', reason: 'gateway_outside_host_namespace',
    });
});

it('preserves an unsuccessful Docker inspection as its own failure phase', async () => {
    const denied: ProjectNativeDockerPort = { engineId: engine.id, run: async () => ({ exitCode: 1, stdout: '', stderr: 'permission denied' }) };
    await expect(acquirePrivateServiceContainerBridge({ docker: denied, engine, networkId: network.Id,
        forward: { host: '127.0.0.1', port: 12345 } })).rejects.toMatchObject({
        code: 'private_service_container_bridge_unavailable', reason: 'docker_network_inspect_failed', phase: 'network_inspect',
    });
});

it.each([
    [{ ...network, Driver: 'overlay' }, 'docker_network_driver_unsupported'],
    [{ ...network, IPAM: { Config: [{ Subnet: 'fd00::/64', Gateway: 'fd00::1' }] } }, 'network_address_family_unsupported'],
    [{ ...network, IPAM: { Config: [{ Subnet: 'invalid', Gateway: '127.0.0.2' }] } }, 'docker_network_inspection_invalid'],
] as const)('preserves the unavailable cause for unsupported or invalid network facts', async (facts, reason) => {
    const unsupported: ProjectNativeDockerPort = { engineId: engine.id,
        run: async () => ({ exitCode: 0, stdout: JSON.stringify([facts]) }) };
    await expect(acquirePrivateServiceContainerBridge({ docker: unsupported, engine, networkId: network.Id,
        forward: { host: '127.0.0.1', port: 12345 } })).rejects.toMatchObject({
        code: 'private_service_container_bridge_unavailable', reason, phase: 'network_inspect',
    });
});
