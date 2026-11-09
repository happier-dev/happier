import { createServer, type ServerResponse } from 'node:http';
import { setImmediate as nextIoTurn } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPluginInvocationServiceBinding } from '../invocation/services/factory';
import { createGlobalFetchRuntime } from './globalFetchRuntime';
import { createStablePluginHttpHost } from './service';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { executeContributedAction } from '../invocation/actions/executeContributedAction';

const servers: ReturnType<typeof createServer>[] = [];

async function fixture(declaredOrigin?: string) {
    let response!: ServerResponse;
    let connected!: () => void;
    let closed!: () => void;
    const arrived = new Promise<void>(resolve => { connected = resolve; });
    const disconnected = new Promise<void>(resolve => { closed = resolve; });
    let requests = 0;
    const server = createServer((_request, outgoing) => {
        requests += 1;
        response = outgoing;
        outgoing.on('close', closed);
        outgoing.writeHead(200, { 'content-type': 'application/stream+json' });
        outgoing.write(_request.url === '/binary' ? Buffer.from([0, 255, 195, 40]) : 'first\n');
        if (_request.url === '/finite') outgoing.end();
        connected();
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
    const origin = `http://127.0.0.1:${address.port}`;
    const cancellation = new AbortController();
    const revocation = new AbortController();
    let current = true;
    const binding = createPluginInvocationServiceBinding('stream-occurrence', 'stream-binding');
    const service = createStablePluginHttpHost({ adapter: createGlobalFetchRuntime() }).bind({
        plugin: { id: 'example.stream', version: '1.0.0' }, contribution: { id: 'logs', qualifiedId: 'example.stream/actions/logs' },
        occurrenceId: 'stream-occurrence', correlationId: 'stream-call', surface: 'cli', signal: cancellation.signal,
        isOccurrenceCurrent: () => current,
    }, { ...binding, networkRevocationSignal: revocation.signal });
    return { service, origin, arrived, disconnected, cancellation, revocation, response: () => response,
        requests: () => requests, retire: () => { current = false; } };
}

describe('admitted HTTP streaming through the native transport', () => {
    afterEach(async () => {
        await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
            server.closeAllConnections();
            server.close(() => resolve());
        })));
    });

    it.each(['finite', 'stream'] as const)('lets trusted plugin %s HTTP use its chosen origin without a per-plugin egress fence', async kind => {
        const f = await fixture('https://unrelated.example.test');
        const headers = { authorization: 'Bearer plugin-owned-test-value' };
        if (kind === 'finite') {
            const response = await f.service.request({ url: `${f.origin}/finite`, method: 'POST', headers, redirect: 'error' });
            expect(response.status).toBe(200);
            expect(new TextDecoder().decode(response.body)).toBe('first\n');
        } else {
            const response = await f.service.requestStream({ url: f.origin, headers, redirect: 'error' });
            expect(response.status).toBe(200);
            const iterator = response.chunks[Symbol.asyncIterator]();
            expect(new TextDecoder().decode((await iterator.next()).value)).toBe('first\n');
            await response.dispose();
        }
        await f.disconnected;
        expect(f.requests()).toBe(1);
    });

    it('publishes the first chunk before body completion and closes on consumer disposal', async () => {
        const f = await fixture();
        const stream = await f.service.requestStream({ url: f.origin, redirect: 'error' });
        await f.arrived;
        const iterator = stream.chunks[Symbol.asyncIterator]();
        expect(new TextDecoder().decode((await iterator.next()).value)).toBe('first\n');
        expect(f.response().writableEnded).toBe(false);
        await stream.dispose();
        await f.disconnected;
        expect((await iterator.next()).done).toBe(true);
        expect(f.requests()).toBe(1);
    });

    it.each(['cancel', 'revoke', 'retire'] as const)('closes open stream access on %s', async reason => {
        const f = await fixture();
        const stream = await f.service.requestStream({ url: f.origin, redirect: 'error' });
        const iterator = stream.chunks[Symbol.asyncIterator]();
        await iterator.next();
        if (reason === 'cancel') f.cancellation.abort();
        if (reason === 'revoke') f.revocation.abort();
        if (reason === 'retire') f.retire();
        if (reason === 'cancel') {
            await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' });
        } else {
            await expect(iterator.next()).rejects.toMatchObject({ code: 'plugin_final_generation_retired' });
            await expect(f.service.requestStream({ url: f.origin, redirect: 'error' }))
                .rejects.toMatchObject({ code: 'plugin_final_generation_retired' });
        }
        await f.disconnected;
        await stream.dispose();
        expect(f.requests()).toBe(1);
    });

    it('closes an open native body read on authority revocation while a read is pending', async () => {
        const f = await fixture();
        const stream = await f.service.requestStream({ url: f.origin, redirect: 'error' });
        const iterator = stream.chunks[Symbol.asyncIterator]();
        await iterator.next();
        const pending = iterator.next().then(value => ({ value }), error => ({ error }));
        await nextIoTurn();
        f.revocation.abort();
        await expect(pending).resolves.toMatchObject({ error: { code: 'plugin_final_generation_retired' } });
        await f.disconnected;
        await stream.dispose();
    });

    it('settles a pending native body read when the consumer explicitly disposes it', async () => {
        const f = await fixture();
        const stream = await f.service.requestStream({ url: f.origin, redirect: 'error' });
        const iterator = stream.chunks[Symbol.asyncIterator]();
        await iterator.next();
        const pending = iterator.next();
        await nextIoTurn();
        await stream.dispose();
        await expect(pending).resolves.toEqual({ done: true, value: undefined });
        await f.disconnected;
        expect(f.requests()).toBe(1);
    });

    it('retains the caller deadline after response headers and releases the stalled body', async () => {
        const f = await fixture();
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            const stream = await f.service.requestStream({ url: f.origin, redirect: 'error', timeoutMs: 1_000 });
            const iterator = stream.chunks[Symbol.asyncIterator]();
            await iterator.next();
            await vi.advanceTimersByTimeAsync(1_000);
            await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' });
            await f.disconnected;
            await stream.dispose();
        } finally { vi.useRealTimers(); }
    });

    it('lets an admitted external author consume and dispose a stream before EOF', async () => {
        const f = await fixture();
        const pluginId = 'example.external-stream';
        const runtime = await createAuthoredAdmittedPluginRuntimeFixture({ plugins: [{ manifest: {
            schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'External stream', description: 'Incremental HTTP source example',
            engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 }, activation: { events: [{ kind: 'startup' }] }, entrypoints: { daemon: './daemon.mjs' },
            hostAccess: { required: [{ id: 'logs', capability: 'network', reason: 'Read selected logs', scope: {
                targets: [{ kind: 'fixedOrigin', origin: f.origin }], methods: ['GET'], privateNetwork: true,
            } }], optional: [] }, contributes: { actions: [{ id: 'read', title: 'Read logs', scopes: ['global'], surfaces: ['cli'], dangerLevel: 'safe',
                execution: { target: 'daemon' }, hostAccess: ['logs'] }] },
        }, files: { 'daemon.mjs': `export function activate(api) {
            api.actions.register('read', async (input, context) => {
                const response = await context.services.http.requestStream({ url: input.url, redirect: 'error' }, { signal: context.signal });
                try {
                    for await (const chunk of response.chunks) return { status: response.status, row: new TextDecoder().decode(chunk), bytes: Array.from(chunk) };
                    return { status: response.status, row: null };
                } finally { await response.dispose(); }
            });
        }` } }],
            async resolveContributes(happyHomeDir) {
                return createResolvedContributionRegistry(projectLoadedPluginContributes({ loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'external' }));
            },
        });
        try {
            const result = await executeContributedAction({ runtimeRegistry: runtime.registry, actionId: `${pluginId}/read`,
                input: { url: f.origin }, context: { surface: 'cli', signal: new AbortController().signal } });
            expect(result).toMatchObject({ matched: true, result: { ok: true, result: { status: 200, row: 'first\n' } } });
            expect(f.response().writableEnded).toBe(false);
            await f.disconnected;
            expect(f.requests()).toBe(1);
            const binary = await executeContributedAction({ runtimeRegistry: runtime.registry, actionId: `${pluginId}/read`,
                input: { url: `${f.origin}/binary` }, context: { surface: 'cli', signal: new AbortController().signal } });
            expect(binary).toMatchObject({ matched: true, result: { ok: true, result: { bytes: [0, 255, 195, 40] } } });
            expect(f.requests()).toBe(2);
        } finally { await runtime.dispose(); }
    });
});
