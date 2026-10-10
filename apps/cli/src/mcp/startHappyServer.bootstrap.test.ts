import { Session } from 'node:inspector/promises';
import { performance } from 'node:perf_hooks';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AccountSettingsSchema, type AccountSettings } from '@happier-dev/protocol';
import { createDeferred } from '@/testkit/async/deferred';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';

const daemonCatalogBoundary = vi.hoisted(() => ({ read: vi.fn() }));
// IPC is outside the Session process; bootstrap, Action policy, MCP registration
// and both sides of the local HTTP transport remain real. No Agent is launched.
vi.mock('@/daemon/controlClient', async importOriginal => ({
    ...await importOriginal<typeof import('@/daemon/controlClient')>(),
    readDaemonPluginCatalog: daemonCatalogBoundary.read,
}));

import { resolveRunnerMcpServers } from './runtime/resolveRunnerMcpServers';
import { registerHappierSessionAgentToolRpc } from './startHappyServer';

afterEach(() => { vi.unstubAllEnvs(); daemonCatalogBoundary.read.mockReset(); });

function bootstrap(accountSettings: AccountSettings | null = null, session = createMutableApiSessionClientFixture({
    sessionId: 'offline-child-bootstrap', metadataPermissionMode: 'default',
    overrides: { getServerBinding: () => ({ serverId: 'test-home', serverUrl: 'https://test-home.example.test' }) },
})) {
    vi.stubEnv('HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT', '1');
    vi.stubEnv('HAPPIER_ACTIONS_SETTINGS_V1', '');
    return resolveRunnerMcpServers({
        session,
        credentials: { token: 'offline-session-fixture', encryption: null },
        accountCredentials: null,
        accountSettings,
        ...(accountSettings ? { actionsSettingsProvider: createActionSettingsProvider({ accountSettings }) } : {}),
        machineId: 'offline-machine', directory: '/tmp/offline-child-bootstrap', env: {},
    });
}

it('reads the daemon catalog only on projection changes or a missed-signal reconnect', async () => {
    let epoch = 1;
    const session = createMutableApiSessionClientFixture({
        sessionId: 'offline-catalog-signal', metadataPermissionMode: 'default',
        overrides: {
            getServerBinding: () => ({ serverId: 'test-home', serverUrl: 'https://test-home.example.test' }),
            getEphemeralStreamConnectionEpoch: () => epoch,
        },
    });
    const projection = { runtimeId: 'offline-daemon', contributionRegistryProjectionRevision: 1 };
    const tool = { toolId: 'acme.example/echo', actionId: 'acme.example/echo', name: 'acme_echo',
        title: 'Echo', description: 'Echo', inputSchema: { type: 'object', properties: {} },
        surfaces: ['mcp', 'agent'] as const, expectedContributorOccurrenceId: 'occurrence-one' };
    let tools = [tool];
    daemonCatalogBoundary.read.mockImplementation(async () => ({ kind: 'available', plugins: [],
        tools: structuredClone(tools), projection: { ...projection } }));
    const runtime = await bootstrap(null, session);
    const client = new Client({ name: 'offline-catalog-signal', version: '1.0.0' });
    try {
        expect(daemonCatalogBoundary.read).toHaveBeenCalledTimes(1);
        await client.connect(new StreamableHTTPClientTransport(new URL(runtime.happierMcpServer.url)));
        expect((await client.listTools()).tools.some(entry => entry.name === 'acme_echo')).toBe(true);
        const before = daemonCatalogBoundary.read.mock.calls.length;
        await client.listTools();
        await client.callTool({ name: 'change_title', arguments: { title: 'Unchanged catalog' } });
        expect(daemonCatalogBoundary.read.mock.calls.length - before).toBe(0);
        tools = [];
        projection.contributionRegistryProjectionRevision += 1;
        await session.rpcHandlerManager.invokeLocal('session.pluginCatalog.invalidate.v1', projection);
        expect((await client.listTools()).tools.some(entry => entry.name === 'acme_echo')).toBe(false);
        expect(daemonCatalogBoundary.read.mock.calls.length - before).toBe(1);
        await session.rpcHandlerManager.invokeLocal('session.pluginCatalog.invalidate.v1', projection);
        await client.listTools();
        expect(daemonCatalogBoundary.read.mock.calls.length - before).toBe(1);
        // No hint delivered: the existing transport epoch is the recovery fact.
        tools = [{ ...tool, expectedContributorOccurrenceId: 'occurrence-two' }];
        projection.contributionRegistryProjectionRevision += 1;
        epoch += 1;
        const reconnected = await Promise.all([client.listTools(), client.listTools()]);
        expect(reconnected.every(list => list.tools.some(entry => entry.name === 'acme_echo'))).toBe(true);
        await client.listTools();
        expect(daemonCatalogBoundary.read.mock.calls.length - before).toBe(2);
        console.log('MCP_CATALOG_SIGNAL_READS', JSON.stringify({ bootstrap: 1, unchangedPost: 0, change: 1, reconnect: 1 }));
    } finally {
        await client.close(); runtime.happierMcpServer.stop();
    }
}, 180_000);

it('does not retain a catalog read superseded by a signal while bootstrap is pending', async () => {
    const session = createMutableApiSessionClientFixture({
        sessionId: 'offline-catalog-race', metadataPermissionMode: 'default',
        overrides: { getServerBinding: () => ({ serverId: 'test-home', serverUrl: 'https://test-home.example.test' }) },
    });
    const requested = createDeferred<void>();
    const old = createDeferred<{ kind: 'available'; plugins: []; tools: []; projection: { runtimeId: string; contributionRegistryProjectionRevision: number } }>();
    daemonCatalogBoundary.read.mockImplementationOnce(() => { requested.resolve(); return old.promise; });
    const projection = { runtimeId: 'offline-daemon', contributionRegistryProjectionRevision: 2 };
    daemonCatalogBoundary.read.mockResolvedValue({ kind: 'available', plugins: [], tools: [], projection });
    const pending = bootstrap(null, session);
    await requested.promise;
    await session.rpcHandlerManager.invokeLocal('session.pluginCatalog.invalidate.v1', projection);
    old.resolve({ kind: 'available', plugins: [], tools: [], projection: { ...projection, contributionRegistryProjectionRevision: 1 } });
    const runtime = await pending;
    try { expect(daemonCatalogBoundary.read).toHaveBeenCalledTimes(2); }
    finally { runtime.happierMcpServer.stop(); }
}, 180_000);

it('applies catalog signals to native tools and refuses an unavailable refresh without reusing stale tools', async () => {
    const session = createMutableApiSessionClientFixture({
        sessionId: 'offline-native-catalog', metadataPermissionMode: 'default',
        overrides: { getServerBinding: () => ({ serverId: 'test-home', serverUrl: 'https://test-home.example.test' }) },
    });
    let projection = { runtimeId: 'offline-daemon', contributionRegistryProjectionRevision: 1 };
    daemonCatalogBoundary.read.mockImplementation(async () => ({ kind: 'available', plugins: [], tools: [], projection }));
    registerHappierSessionAgentToolRpc(session);
    const call = () => session.rpcHandlerManager.invokeLocal('session.agentTool.call.v1', {
        toolName: 'change_title', args: { title: 'Native catalog signal' },
    });
    await call();
    const before = daemonCatalogBoundary.read.mock.calls.length;
    await call();
    expect(daemonCatalogBoundary.read.mock.calls.length - before).toBe(0);
    expect(await session.rpcHandlerManager.invokeLocal('session.pluginCatalog.invalidate.v1', { ...projection, tools: [] }))
        .toMatchObject({ ok: false, errorCode: 'invalid_action_input' });
    await call();
    expect(daemonCatalogBoundary.read.mock.calls.length - before).toBe(0);
    projection = { ...projection, contributionRegistryProjectionRevision: 2 };
    await session.rpcHandlerManager.invokeLocal('session.pluginCatalog.invalidate.v1', projection);
    daemonCatalogBoundary.read.mockResolvedValueOnce({ kind: 'unavailable', code: 'daemon_unavailable' });
    expect(await call()).toMatchObject({ ok: false, errorCode: 'daemon_plugin_catalog_unavailable' });
    await call();
    await call();
    expect(daemonCatalogBoundary.read.mock.calls.length - before).toBe(2);
}, 180_000);

it('keeps per-request reads until the existing relay acknowledges the signal handler', async () => {
    let ready = false;
    const session = createMutableApiSessionClientFixture({
        sessionId: 'offline-signal-registration', metadataPermissionMode: 'default',
        overrides: {
            getServerBinding: () => ({ serverId: 'test-home', serverUrl: 'https://test-home.example.test' }),
            isDaemonPluginCatalogSignalReady: () => ready,
        },
    });
    daemonCatalogBoundary.read.mockResolvedValue({ kind: 'available', plugins: [], tools: [],
        projection: { runtimeId: 'offline-daemon', contributionRegistryProjectionRevision: 1 } });
    registerHappierSessionAgentToolRpc(session);
    const call = () => session.rpcHandlerManager.invokeLocal('session.agentTool.call.v1', {
        toolName: 'change_title', args: { title: 'Registration readiness' },
    });
    await call(); await call();
    expect(daemonCatalogBoundary.read).toHaveBeenCalledTimes(2);
    ready = true;
    await call(); await call();
    expect(daemonCatalogBoundary.read).toHaveBeenCalledTimes(3);
}, 180_000);

it('keeps absent optional Action policy as cheap as explicit defaults through Session MCP bootstrap', async () => {
    daemonCatalogBoundary.read.mockResolvedValue({ kind: 'available', plugins: [], tools: [] });
    const inspector = new Session();
    inspector.connect();
    let runtime: Awaited<ReturnType<typeof bootstrap>> | undefined;
    let explicitRuntime: Awaited<ReturnType<typeof bootstrap>> | undefined;
    const explicitDefaults = AccountSettingsSchema.parse({ actionsSettingsV1: { v: 1, actions: {} } });
    const client = new Client({ name: 'offline-bootstrap-test', version: '1.0.0' });
    try {
        await inspector.post('Profiler.enable');
        await inspector.post('Profiler.startPreciseCoverage', { callCount: true, detailed: false });
        const started = performance.now();
        const cpuBefore = process.cpuUsage();
        runtime = await bootstrap();
        const bootstrapMs = performance.now() - started;
        const coverage = await inspector.post('Profiler.takePreciseCoverage');
        const errorFunctions = coverage.result
            .filter(script => script.url.endsWith('/zod/v4/core/errors.js'))
            .flatMap(script => script.functions);
        const errorConstructionCount = errorFunctions
            .filter(fn => fn.functionName === 'initializer')
            .reduce((sum, fn) => sum + (fn.ranges[0]?.count ?? 0), 0);
        await client.connect(new StreamableHTTPClientTransport(new URL(runtime.happierMcpServer.url)));
        const first = await client.listTools();
        const second = await client.listTools();
        const cpu = process.cpuUsage(cpuBefore);
        console.log('CHILD_MCP_BOOTSTRAP', JSON.stringify({ bootstrapMs, discoveryMs: performance.now() - started - bootstrapMs,
            cpuMs: (cpu.user + cpu.system) / 1000, errorConstructionCount, tools: first.tools.length }));
        expect(first.tools.some(tool => tool.name === 'change_title')).toBe(true);
        expect(second.tools.map(tool => tool.name)).toEqual(first.tools.map(tool => tool.name));
        // Compare the same real preparation with explicit defaults: other
        // optional schema checks are not the regression under investigation.
        await inspector.post('Profiler.takePreciseCoverage');
        explicitRuntime = await bootstrap(explicitDefaults);
        const explicitCoverage = await inspector.post('Profiler.takePreciseCoverage');
        const explicitErrorCount = explicitCoverage.result
            .filter(script => script.url.endsWith('/zod/v4/core/errors.js'))
            .flatMap(script => script.functions).filter(fn => fn.functionName === 'initializer')
            .reduce((sum, fn) => sum + (fn.ranges[0]?.count ?? 0), 0);
        console.log('CHILD_MCP_EXPLICIT_DEFAULTS', JSON.stringify({ explicitErrorCount }));
        z.string().safeParse(null);
        const control = await inspector.post('Profiler.takePreciseCoverage');
        expect(control.result.filter(script => script.url.endsWith('/zod/v4/core/errors.js'))
            .flatMap(script => script.functions).filter(fn => fn.functionName === 'initializer')
            .reduce((sum, fn) => sum + (fn.ranges[0]?.count ?? 0), 0)).toBeGreaterThan(0);
        expect(errorConstructionCount).toBe(explicitErrorCount);
    } finally {
        await client.close();
        runtime?.happierMcpServer.stop();
        explicitRuntime?.happierMcpServer.stop();
        await inspector.post('Profiler.stopPreciseCoverage');
        inspector.disconnect();
    }
}, 180_000);

it('retains slow required catalog preparation and rejects its failure as a typed startup error', async () => {
    const catalog = createDeferred<Readonly<{ kind: 'unavailable'; code: string }>>();
    const requested = createDeferred<void>();
    daemonCatalogBoundary.read.mockImplementation(() => { requested.resolve(); return catalog.promise; });
    const pending = bootstrap();
    void pending.catch(() => undefined);
    await requested.promise;
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    catalog.resolve({ kind: 'unavailable', code: 'daemon_unavailable' });
    await expect(pending).rejects.toMatchObject({ code: 'daemon_plugin_catalog_unavailable' });
}, 180_000);

it('reuses the admitted Action inventory across stateless MCP requests', async () => {
    daemonCatalogBoundary.read.mockResolvedValue({ kind: 'available', plugins: [], tools: [] });
    const inspector = new Session();
    inspector.connect();
    const client = new Client({ name: 'offline-request-cost', version: '1.0.0' });
    let runtime: Awaited<ReturnType<typeof bootstrap>> | undefined;
    const rows: Array<Record<string, number | string>> = [];
    // Observe real HTTP; the only substituted network boundary is daemon IPC.
    const http = vi.spyOn(globalThis, 'fetch');
    try {
        await inspector.post('Profiler.enable');
        await inspector.post('Profiler.startPreciseCoverage', { callCount: true, detailed: false });
        async function measure(label: string, operation: () => Promise<unknown>) {
            await inspector.post('Profiler.takePreciseCoverage');
            const reads = daemonCatalogBoundary.read.mock.calls.length;
            const httpCalls = http.mock.calls.length;
            const started = performance.now();
            const cpuBefore = process.cpuUsage();
            const result = await operation();
            const requestWallMs = performance.now() - started;
            const cpu = process.cpuUsage(cpuBefore);
            const coverage = await inspector.post('Profiler.takePreciseCoverage');
            const count = (name: string) => coverage.result.flatMap(script => script.functions)
                .filter(fn => fn.functionName === name)
                .reduce((total, fn) => total + (fn.ranges[0]?.count ?? 0), 0);
            const row = { label, requestWallMs, wallMs: performance.now() - started, cpuMs: (cpu.user + cpu.system) / 1000,
                constructions: count('createHappierMcpServer'), inventory: count('listBuiltInHappierTools'),
                maps: count('createActionToolNameToIdMap'), lookups: count('getActionSpec'),
                schemas: count('toMcpToolInputSchema'),
                httpCalls: http.mock.calls.length - httpCalls,
                daemonReads: daemonCatalogBoundary.read.mock.calls.length - reads };
            rows.push(row);
            return { result, row };
        }
        const prepared = await measure('bootstrap', async () => { runtime = await bootstrap(); });
        if (!runtime) throw new Error('bootstrap_missing');
        const url = runtime.happierMcpServer.url;
        await measure('initialize+notification+GET', async () => await client.connect(new StreamableHTTPClientTransport(new URL(url))));
        await measure('tools/list', async () => await client.listTools());
        const second = await measure('tools/list repeated', async () => await client.listTools());
        const call = await measure('tools/call change_title', async () => await client.callTool({ name: 'change_title', arguments: { title: 'Offline measurement' } }));
        console.log('MCP_REQUEST_COST', JSON.stringify(rows));
        expect(second.row.inventory).toBe(0);
        expect(second.row.maps).toBe(0);
        expect(second.row.schemas).toBe(0);
        expect(call.result, JSON.stringify(call.result)).toMatchObject({ isError: false });
        expect(http.mock.calls.every(([request]) => new URL(request instanceof Request ? request.url : String(request)).hostname === '127.0.0.1')).toBe(true);
        expect(second.row.lookups).toBeLessThan(prepared.row.lookups);
    } finally {
        await client.close();
        runtime?.happierMcpServer.stop();
        await inspector.post('Profiler.stopPreciseCoverage');
        inspector.disconnect();
        http.mockRestore();
    }
}, 180_000);
