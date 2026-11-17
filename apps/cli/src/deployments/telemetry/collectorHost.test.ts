import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1 } from '@happier-dev/protocol/plugins/installations/manifests';
import type { ChangeEntry } from '@happier-dev/protocol/changes';
import { UpdateContainerSchema } from '@happier-dev/protocol/updates';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { acquireRequesterAccountEncryptionCurrentness } from '@/api/client/accountEncryptionCurrentnessObservation';
import { createDeploymentTelemetryHost } from './collectorHost';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe('production collector host', () => {
    it('uses only the explicit deployed-App port and refuses malformed declarations when the role reads it', () => {
        function createWithPort(port?: string) {
            return createDeploymentTelemetryHost({ serverBaseUrl: 'http://fixture', token: 'token', machineId: 'collector',
                environment: port === undefined ? {} : { HAPPIER_DEPLOYED_TELEMETRY_PORT: port },
                subscribeMachineChanges: () => () => {}, onRefreshError: () => {} });
        }
        expect(createWithPort().bind(new AbortController().signal).deployedAppPort).toBeUndefined();
        expect(createWithPort('4318').bind(new AbortController().signal).deployedAppPort).toBe(4318);
        for (const value of ['0', '-1', '65536', '4318oops', '']) {
            const host = createWithPort(value);
            expect(() => host.bind(new AbortController().signal).deployedAppPort).toThrow('HAPPIER_DEPLOYED_TELEMETRY_PORT');
        }
    });
    it('reconciles durable assignments over the open Account channel without refreshing unrelated changes', async () => {
        const channel = await createRequesterCurrentnessSocketHarness();
        cleanups.push(channel.close);
        const changes: ChangeEntry[] = [];
        let assignments = [{ environmentId: 'environment-a', tokenHash: 'a'.repeat(64) }];
        let assignmentReads = 0;
        let feedReads = 0;
        const server = createServer((request, response) => {
            response.setHeader('Content-Type', 'application/json');
            const url = new URL(request.url ?? '/', 'http://fixture');
            if (url.pathname === '/v2/changes') {
                feedReads++;
                const after = Number(url.searchParams.get('after') ?? 0);
                response.end(JSON.stringify({ changes: changes.filter(change => change.cursor > after), nextCursor: changes.length }));
            } else if (url.pathname.endsWith('/telemetry-assignments')) {
                assignmentReads++;
                response.end(JSON.stringify({ ok: true, assignments }));
            } else {
                response.statusCode = 404;
                response.end('{}');
            }
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        cleanups.push(async () => {
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        });
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('missing address');
        const accountId = 'account-collector-open-channel';
        const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
        const serverBaseUrl = `http://127.0.0.1:${address.port}`;
        const host = createDeploymentTelemetryHost({ serverBaseUrl, token, machineId: 'collector-a',
            createPublisherHeader: () => 'installation-proof',
            subscribeMachineChanges(listener) {
                const observation = acquireRequesterAccountEncryptionCurrentness({ accountId, serverBaseUrl, token });
                const release = observation.subscribeRunFollowAvailability(change => {
                    if (change.kind === 'machine') listener(change.machineId);
                    else if (change.kind === 'reconnected') listener(null);
                });
                return () => { release(); void observation.dispose(); };
            },
            onRefreshError(error) { throw error; } });
        const lifetime = new AbortController();
        cleanups.push(async () => { lifetime.abort(); });
        const service = host.bind(lifetime.signal);
        let latest = await service.readAssignments();
        service.subscribeAssignmentsChanged(async () => { latest = await service.readAssignments(); });
        await vi.waitFor(() => expect(channel.clients[0]?.connected).toBe(true));
        const connectionId = channel.clients[0]!.id;
        async function publish(kind: ChangeEntry['kind'], entityId: string) {
            const cursor = changes.length + 1;
            changes.push({ kind, entityId, cursor, changedAt: cursor });
            const update = UpdateContainerSchema.parse({ id: `assignment-${cursor}`, seq: cursor, createdAt: cursor,
                body: { t: 'account-change', changeKinds: [kind], entityIds: [entityId] } });
            await Promise.all([...channel.server.sockets.sockets.values()].map(socket => new Promise<void>(resolve => {
                socket.emit('update', update);
                socket.emit('fx56-delivered', resolve);
            })));
        }
        assignments = [{ environmentId: 'environment-a', tokenHash: 'b'.repeat(64) }];
        await publish('machine', 'collector-a');
        await vi.waitFor(() => expect(latest).toEqual(assignments));
        await publish('machine', 'collector-other');
        await publish('account', 'unrelated-account-write');
        assignments = [{ environmentId: 'environment-a', tokenHash: 'c'.repeat(64) }];
        await publish('machine', 'collector-a');
        await vi.waitFor(() => expect(latest).toEqual(assignments));
        expect(assignmentReads).toBe(3);
        expect(channel.clients).toHaveLength(1);
        expect(channel.clients[0]!.id).toBe(connectionId);
        lifetime.abort();
        await vi.waitFor(() => expect(channel.clients[0]!.connected).toBe(false));
        expect(feedReads).toBeGreaterThan(0);
    });
    it('reads only on demand with captured identity and publishes the same live endpoint', async () => {
        const requests: { path: string; authorization?: string; proof?: string; body: string }[] = [];
        const server = createServer(async (request, response) => {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            requests.push({ path: `${request.method} ${request.url}`, authorization: request.headers.authorization,
                proof: request.headers[PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1] as string | undefined,
                body: Buffer.concat(chunks).toString() });
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify({ ok: true, assignments: [{ environmentId: 'environment-a', tokenHash: 'a'.repeat(64) }] }));
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        cleanups.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('missing address');
        let notify: ((machineId: string | null) => void) | undefined;
        let subscribers = 0;
        const host = createDeploymentTelemetryHost({ serverBaseUrl: `http://127.0.0.1:${address.port}`, token: 'account-token', machineId: 'collector-a',
            createPublisherHeader: request => request.path.endsWith('/collector-a/telemetry-assignments') ? 'installation-proof' : null,
            subscribeMachineChanges(listener) { subscribers++; notify = listener; return () => { subscribers--; }; },
            onRefreshError(error) { throw error; } });
        expect(host.readEndpoint()).toBeNull();
        expect(subscribers).toBe(0);
        expect(requests).toHaveLength(0);
        const lifetime = new AbortController();
        const service = host.bind(lifetime.signal);
        expect(await service.readAssignments()).toEqual([{ environmentId: 'environment-a', tokenHash: 'a'.repeat(64) }]);
        expect(requests).toEqual([{ path: 'POST /v1/deployments/machines/collector-a/telemetry-assignments', authorization: 'Bearer account-token', proof: 'installation-proof', body: '{}' }]);
        let endpoint: string | null = 'http://127.0.0.1:4318';
        service.exposeEndpoint(() => endpoint);
        expect(host.readEndpoint()).toBe(endpoint);
        endpoint = null;
        expect(host.readEndpoint()).toBeNull();
        let refreshes = 0;
        service.subscribeAssignmentsChanged(async () => { refreshes++; });
        notify?.('other-machine');
        notify?.('collector-a');
        notify?.(null); // reconnect reconciles after feed catch-up
        expect(refreshes).toBe(2);
        lifetime.abort();
        expect(subscribers).toBe(0);
        expect(host.readEndpoint()).toBeNull();
        expect(requests).toHaveLength(1);
    });
});
