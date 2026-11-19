import { stat } from 'node:fs/promises';
import { once } from 'node:events';
import { connect, createServer, type Socket } from 'node:net';
import { afterEach, beforeEach, expect, it as test } from 'vitest';
import { projectDeploymentFailure } from '@/deployments/deploymentFailure';
import { acquirePrivateServiceContainerBridge } from './privateServiceContainerBridge';
import { createRelayDockerFixture } from './privateServiceContainerBridge.testkit';

const it = test.skipIf(process.platform !== 'linux');
const engine = { id: 'local', kind: 'native' as const };
const networkId = 'consumer-network';
const route = { key: 'fixture' };
const sockets = new Set<Socket>();
const cleanup: Array<() => Promise<void>> = [];
let fixture: ReturnType<typeof createRelayDockerFixture>;
beforeEach(() => { fixture = createRelayDockerFixture(networkId); });
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

it('forwards simultaneous binary clients and EOF through a private Unix socket', async () => {
    const bridge = await acquirePrivateServiceContainerBridge({ docker: fixture.docker, engine, networkId, route, forward: await destination() });
    cleanup.push(bridge.close);
    const socketPath = fixture.socketPath(bridge.host);
    expect((await stat(socketPath)).isSocket()).toBe(true);
    expect((await stat(fixture.directory(bridge.host))).mode & 0o777).toBe(0o700);
    expect(bridge.networkId).toBe(networkId);
    await Promise.all([Buffer.from([0, 255, 128, 1]), Buffer.alloc(256 * 1024, 17)].map(async bytes => {
        const client = connect({ path: socketPath, allowHalfOpen: true });
        sockets.add(client);
        const chunks: Buffer[] = [];
        client.on('data', chunk => chunks.push(chunk));
        const ended = once(client, 'end');
        client.end(bytes);
        await ended;
        expect(Buffer.concat(chunks)).toEqual(Buffer.from(bytes).reverse());
        client.destroy();
    }));
    await bridge.close();
    await bridge.close();
    await expect(stat(socketPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(fixture.hasRelay(bridge.host)).toBe(false);
});

it('closes an active socket and removes the relay when owner custody is cancelled', async () => {
    const abort = new AbortController();
    const bridge = await acquirePrivateServiceContainerBridge({ docker: fixture.docker, engine, networkId, route,
        forward: await destination(), signal: abort.signal });
    cleanup.push(bridge.close);
    const admitted = connect(fixture.socketPath(bridge.host));
    sockets.add(admitted);
    admitted.on('error', () => undefined);
    await once(admitted, 'connect');
    const closed = new Promise<void>(resolve => admitted.once('close', () => resolve()));
    abort.abort();
    await closed;
    await bridge.close();
    expect(fixture.hasRelay(bridge.host)).toBe(false);
});

it('drains the complete response before closing a client that applies backpressure', async () => {
    const bridge = await acquirePrivateServiceContainerBridge({ docker: fixture.docker, engine, networkId, route, forward: await destination() });
    cleanup.push(bridge.close);
    const bytes = Buffer.alloc(8 * 1024 * 1024, 173);
    const client = connect({ path: fixture.socketPath(bridge.host), allowHalfOpen: true });
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

it('reaps the owned orphan and preserves the recorded DNS endpoint on recovery', async () => {
    const forward = await destination();
    const first = await acquirePrivateServiceContainerBridge({ docker: fixture.docker, engine, networkId, route, forward });
    cleanup.push(first.close);
    const oldDirectory = fixture.directory(first.host);
    fixture.failRemoval = true;
    await expect(first.close()).rejects.toMatchObject({ reason: 'relay_container_failed' });
    fixture.failRemoval = false;
    cleanup.pop();
    const restored = await acquirePrivateServiceContainerBridge({ docker: fixture.docker, engine, networkId, forward,
        route: { restoredHost: first.host } });
    cleanup.push(restored.close);
    expect({ host: restored.host, port: restored.port }).toEqual({ host: first.host, port: first.port });
    expect(fixture.directory(restored.host)).not.toBe(oldDirectory);
    await expect(stat(oldDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('preserves the Desktop reason and phase through deployment failure projection', async () => {
    const error = await acquirePrivateServiceContainerBridge({ docker: fixture.docker, engine: { ...engine, kind: 'dockerDesktop' },
        networkId, route, forward: { host: '127.0.0.1', port: 12345 } }).catch(error => error);
    expect(projectDeploymentFailure('private_service_container_bridge_unavailable', error)).toMatchObject({
        failureCause: { errorCode: 'docker_desktop_unsupported', phase: 'deployment.reference.platform' },
    });
});

it('refuses a remote engine before acquiring any relay', async () => {
    fixture.endpoint = 'ssh://remote.example.test';
    await expect(acquirePrivateServiceContainerBridge({ docker: fixture.docker, engine, networkId, route,
        forward: { host: '127.0.0.1', port: 12345 } })).rejects.toMatchObject({
        code: 'private_service_container_bridge_unavailable', reason: 'remote_docker_unsupported', phase: 'platform',
    });
});

it('reports an unavailable pinned relay image', async () => {
    fixture.failPull = true;
    await expect(acquirePrivateServiceContainerBridge({ docker: fixture.docker, engine, networkId, route,
        forward: { host: '127.0.0.1', port: 12345 } })).rejects.toMatchObject({
        code: 'private_service_container_bridge_unavailable', reason: 'relay_image_pull_failed', phase: 'relay',
    });
});

it('preserves an unsuccessful Docker inspection as its own failure phase', async () => {
    fixture.failInspect = true;
    await expect(acquirePrivateServiceContainerBridge({ docker: fixture.docker, engine, networkId, route,
        forward: { host: '127.0.0.1', port: 12345 } })).rejects.toMatchObject({
        code: 'private_service_container_bridge_unavailable', reason: 'docker_network_inspect_failed', phase: 'network_inspect',
    });
});

it.each([
    ['overlay', '172.22.0.0/16', 'docker_network_driver_unsupported'],
    ['bridge', 'fd00::/64', 'docker_network_inspection_invalid'],
    ['bridge', 'invalid', 'docker_network_inspection_invalid'],
] as const)('preserves the unavailable cause for unsupported or invalid network facts', async (driver, subnet, reason) => {
    fixture.driver = driver;
    fixture.subnet = subnet;
    await expect(acquirePrivateServiceContainerBridge({ docker: fixture.docker, engine, networkId, route,
        forward: { host: '127.0.0.1', port: 12345 } })).rejects.toMatchObject({
        code: 'private_service_container_bridge_unavailable', reason, phase: 'network_inspect',
    });
});
