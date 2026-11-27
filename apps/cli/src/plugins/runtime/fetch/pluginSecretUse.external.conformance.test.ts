import { fixture, ref, sentinel } from './pluginSecretUseHttp.testkit';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mcpPluginItemIdV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';
import { describe, expect, it, vi } from 'vitest';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { logger } from '@/ui/logger';
import { executeContributedAction } from '../invocation/actions/executeContributedAction';

const pluginId = 'example.external-secret-use';
const PUBLIC_MODULE = `export function activate(api) {
    api.actions.register('sync', async (input, context) => {
        const value = await context.services.secrets.readSavedSecret(input.ref, { resourceRevision: input.revision, signal: context.signal });
        const response = await context.services.http.request({
            url: input.url, method: 'POST', redirect: input.redirect || 'error',
            headers: { 'Content-Type': 'application/json' },
            body: new TextEncoder().encode(JSON.stringify({ variables: [{ name: 'TOKEN', value }], plain: 'visible' })),
        }, { signal: context.signal });
        return { body: new TextDecoder().decode(response.body), status: response.status };
    });
}`;

describe('installed external HTTP secret-use public contract', () => {
    it.each([
        { mode: 'plain' as const, hasKey: false },
        { mode: 'e2ee' as const, hasKey: true },
        { mode: 'e2ee' as const, hasKey: false },
    ])('uses the canonical host with $mode custody and hasKey=$hasKey', async ({ mode, hasKey }) => {
        const realFetch = globalThis.fetch;
        const { resources } = fixture(mode, { keyless: mode === 'e2ee' && !hasKey });
        // Only Home feature discovery is substituted. Provider requests must
        // cross the real HTTP transport into the fixture's loopback listener.
        vi.stubGlobal('fetch', vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            if (url.origin === 'https://external-secret-home.example'
                && ['/v1/features', '/v1/features/authenticated'].includes(url.pathname)) {
                return Response.json({ features: {}, capabilities: {} });
            }
            return realFetch(input, init);
        }));
        const setUseAllowed = (use: boolean) => {
            for (const resource of resources.resources) {
                if ('resourceId' in resource) resource.entry.capabilities.use = use;
            }
        };
        const delivered: string[] = [];
        const redirectTargetRequests: string[] = [];
        let redirectTargetOrigin = '';
        let echo = false;
        const server = createServer(async (request, response) => {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            delivered.push(Buffer.concat(chunks).toString('utf8'));
            if (request.url === '/cross-origin') {
                response.writeHead(307, { location: `${redirectTargetOrigin}/variables` });
                response.end();
                return;
            }
            if (request.url === '/same-origin') {
                response.writeHead(307, { location: '/settled' });
                response.end();
                return;
            }
            response.end(echo ? sentinel : 'plain provider output');
        });
        const redirectTarget = createServer(async (request, response) => {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            redirectTargetRequests.push(Buffer.concat(chunks).toString('utf8'));
            response.end('unexpected redirect destination');
        });
        let runtime: Awaited<ReturnType<typeof createAuthoredAdmittedPluginRuntimeFixture>> | undefined;
        try {
            await Promise.all([server, redirectTarget].map(peer => new Promise<void>((resolve, reject) => {
                peer.once('error', reject); peer.listen(0, '127.0.0.1', resolve);
            })));
            const address = server.address();
            const redirectAddress = redirectTarget.address();
            if (!address || typeof address === 'string' || !redirectAddress || typeof redirectAddress === 'string') throw new Error('Expected fixture TCP addresses');
            const origin = `http://127.0.0.1:${address.port}`;
            redirectTargetOrigin = `http://127.0.0.1:${redirectAddress.port}`;
            runtime = await createAuthoredAdmittedPluginRuntimeFixture({ plugins: [{ manifest: {
                schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'External secret use', description: 'Public HTTP custody fixture',
                engines: { happier: '^0.3.0' }, runtime: { apiVersion: 1 }, activation: { events: [{ kind: 'startup' }] }, entrypoints: { daemon: './daemon.mjs' },
                hostAccess: { required: [{ id: 'provider', capability: 'network', reason: 'Sync provider variables', scope: {
                    targets: [{ kind: 'fixedOrigin', origin }], methods: ['POST'], privateNetwork: true,
                } }], optional: [] }, contributes: { actions: [{ id: 'sync', title: 'Sync variables', scopes: ['global'], surfaces: ['cli'], dangerLevel: 'safe',
                    execution: { target: 'daemon' }, hostAccess: ['provider'] }] },
            }, files: { 'daemon.mjs': PUBLIC_MODULE } }],
                async resolveContributes(happyHomeDir) {
                    return createResolvedContributionRegistry(projectLoadedPluginContributes({ loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'external' }));
                },
            });
            const registry = runtime.registry;
            const invoke = (input = {}, signal = new AbortController().signal) => executeContributedAction({ runtimeRegistry: registry,
                actionId: `${pluginId}/sync`, input: { url: `${origin}/variables`, ref, revision: 3, ...input }, context: { surface: 'cli', signal } });
            await runWithServerHttpBaseUrl('https://external-secret-home.example', async () => {
                const first = await invoke();
                if (mode === 'e2ee' && !hasKey) {
                    expect(first).toMatchObject({ matched: true, result: { ok: false, errorCode: 'secret_use_client_required' } });
                    expect(delivered).toHaveLength(0);
                    return;
                }
                expect(first).toMatchObject({ matched: true, result: { ok: true, result: { status: 200, body: 'plain provider output' } } });
                expect(delivered).toEqual([JSON.stringify({ variables: [{ name: 'TOKEN', value: sentinel }], plain: 'visible' })]);
                expect(JSON.stringify(first)).not.toContain(sentinel);
                const stale = await invoke({ revision: 2 });
                // Exact revision and absence failures retain the custody code
                // through the installed plugin's public Action boundary.
                expect(stale).toMatchObject({ matched: true, result: { ok: false, errorCode: 'secret_missing' } });
                expect(delivered).toHaveLength(1);
                const otherRef = await invoke({ ref: 'happier:shared-secret:v1:other-resource' });
                expect(otherRef).toMatchObject({ matched: true, result: { ok: false, errorCode: 'secret_missing' } });
                expect(delivered).toHaveLength(1);
                setUseAllowed(false);
                const withdrawn = await invoke();
                expect(withdrawn).toMatchObject({ matched: true, result: { ok: false, errorCode: 'secret_missing' } });
                expect(delivered).toHaveLength(1);
                setUseAllowed(true);
                const cancel = new AbortController(); cancel.abort();
                const cancelled = await invoke({}, cancel.signal);
                expect(cancelled).toMatchObject({ matched: true, result: { ok: false } });
                expect(delivered).toHaveLength(1);
                const crossOrigin = await invoke({ url: `${origin}/cross-origin`, redirect: 'follow' });
                expect(crossOrigin).toMatchObject({ matched: true, result: { ok: false, errorCode: 'credential_request_redirect_refused' } });
                expect(delivered).toHaveLength(2);
                expect(redirectTargetRequests).toHaveLength(0);
                const sameOrigin = await invoke({ url: `${origin}/same-origin`, redirect: 'follow' });
                expect(sameOrigin).toMatchObject({ matched: true, result: { ok: true, result: { status: 200 } } });
                expect(delivered).toHaveLength(4);
                expect(delivered.every(body => body === delivered[0])).toBe(true);
                echo = true;
                const echoed = await invoke();
                expect(echoed).toMatchObject({ matched: true, result: { ok: true, result: { status: 200, body: '[REDACTED]' } } });
                expect(JSON.stringify(echoed)).not.toContain(sentinel);
                expect(delivered).toHaveLength(5);
                expect(redirectTargetRequests).toHaveLength(0);
            });
        } finally {
            try { await runtime?.dispose(); }
            finally { await Promise.all([server, redirectTarget].map(peer => new Promise<void>((resolve, reject) => peer.close(error => error ? reject(error) : resolve())))); }
        }
    });
});

it('redacts saved secret material at the authenticated hosted MCP output and log boundaries', async () => {
    const value = 'mcp-fixture-"quoted"\\path\nsecond-line';
    const realFetch = globalThis.fetch;
    const { resources } = fixture('plain', { value });
    vi.stubGlobal('fetch', vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        return url.origin === 'https://external-secret-home.example'
            ? Response.json({ features: {}, capabilities: {} })
            : realFetch(input, init);
    }));
    const logs = vi.spyOn(logger, 'appendPluginInvocationLogRecord').mockImplementation(() => {});
    const localId = 'variables';
    const runtime = await createAuthoredAdmittedPluginRuntimeFixture({
        plugins: [{
            manifest: {
                schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'External secret use', description: 'Hosted MCP custody fixture',
                engines: { happier: '^0.3.0' }, runtime: { apiVersion: 1 }, activation: { events: [{ kind: 'startup' }] },
                entrypoints: { daemon: './daemon.mjs' },
                contributes: { mcp: { servers: [{ id: localId, title: 'Variables', kind: 'dynamic', sessionScope: 'session' }] } },
            },
            files: { 'daemon.mjs': `export function activate(api) {
                api.mcp.registerServer('variables', {
                    async dispose() {},
                    async listTools() {
                        return { items: [{ name: 'echo', inputSchema: { type: 'object' } }] };
                    },
                    async callTool({ input }, context) {
                        const value = await context.services.secrets.readSavedSecret(input.ref, { resourceRevision: 3, signal: context.signal });
                        const escaped = JSON.stringify(value).slice(1, -1);
                        context.services.logger.info('plain log control', { value, escaped });
                        if (input.failure) throw new Error('plain error control ' + value + ' ' + escaped);
                        return { plain: 'plain output control', value, escaped };
                    },
                });
            }` },
        }],
        async resolveContributes(happyHomeDir) {
            return createResolvedContributionRegistry(projectLoadedPluginContributes({
                loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'external',
            }));
        },
    });
    const client = new Client({ name: 'hosted-secret-use-conformance', version: '1.0.0' });
    const assertRedacted = (result: unknown) => {
        const encoded = JSON.stringify(result);
        const escaped = JSON.stringify(value).slice(1, -1);
        const twiceEscaped = JSON.stringify(escaped).slice(1, -1);
        // Compare booleans so a regression cannot write the material into the test log.
        expect([value, escaped, twiceEscaped].some(form => encoded.includes(form))).toBe(false);
    };
    try {
        await runWithServerHttpBaseUrl('https://external-secret-home.example', async () => {
            const [projected] = await runtime.registry.materializePluginMcpServers!({
                scope: { kind: 'session', sessionId: 'secret-use-session' },
                directory: runtime.happyHomeDir, signal: new AbortController().signal,
                servers: [{ id: mcpPluginItemIdV1({ pluginId, localId }), name: 'Variables',
                    transport: { kind: 'http', url: 'http://127.0.0.1' }, scope: { sessionId: 'secret-use-session', directory: runtime.happyHomeDir } }],
            });
            if (projected?.transport.kind !== 'http') throw new Error('Missing hosted MCP endpoint');
            await client.connect(new StreamableHTTPClientTransport(new URL(projected.transport.url), {
                requestInit: { headers: { ...projected.transport.headers } },
            }));
            const call = (failure = false) => client.callTool({ name: 'echo', arguments: { ref, failure } });
            const success = await call();
            assertRedacted(success);
            expect(success).toEqual({ content: [{ type: 'text', text: JSON.stringify({
                plain: 'plain output control', value: '[REDACTED]', escaped: '[REDACTED]',
            }) }] });
            const failure = await call(true);
            assertRedacted(failure);
            expect(failure.isError).toBe(true);
            for (const resource of resources.resources) {
                if ('resourceId' in resource) resource.entry.capabilities.use = false;
            }
            const beforeDenial = logs.mock.calls.length;
            const denied = await call();
            assertRedacted(denied);
            expect(denied.isError).toBe(true);
            expect(logs.mock.calls).toHaveLength(beforeDenial);
            assertRedacted(logs.mock.calls);
            expect(logs.mock.calls.filter(([record]) => record.message === 'plain log control')).toHaveLength(2);
        });
    } finally {
        try { await client.close(); }
        finally { await runtime.dispose(); logs.mockRestore(); }
    }
});
