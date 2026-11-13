import { Session } from 'node:inspector/promises';
import { EventEmitter } from 'node:events';
import type { Socket } from 'socket.io-client';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod/mini';
import { AccountSettingsSchema, type AccountSettings } from '@happier-dev/protocol';
import { createDeferred } from '@/testkit/async/deferred';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { readSessionCapabilityNoticeV1 } from '@happier-dev/protocol/sessions/messages/sessionCapabilityNoticeV1';

const daemonCatalogBoundary = vi.hoisted(() => ({
    read: vi.fn(),
    execute: vi.fn<typeof import('@/daemon/controlClient').requestDaemonPluginActionExecution>(async () => ({ matched: false })),
}));
// Vitest may load Zod through either package condition. Both files contain
// the same error initializer; the control parse below proves observability.
const isZodErrorsScript = (url: string) => /\/zod\/v4\/core\/errors\.(?:c?js)(?:\?|$)/u.test(url);
// IPC is outside the Session process; bootstrap, Action policy, MCP registration
// and both sides of the local HTTP transport remain real. No Agent is launched.
vi.mock('@/daemon/controlClient', async importOriginal => ({
    ...await importOriginal<typeof import('@/daemon/controlClient')>(),
    readDaemonPluginCatalog: daemonCatalogBoundary.read,
    // Unmatched reads stay with the Session's real built-in Action owner.
    requestDaemonPluginActionExecution: daemonCatalogBoundary.execute,
}));

import { resolveRunnerMcpServers } from './runtime/resolveRunnerMcpServers';
import { registerHappierSessionAgentToolRpc } from './startHappyServer';
import { sessionMcpAgentTransport, sessionMcpAuthorizationHeaders, sessionMcpTestFetch, sessionMcpTestTransport } from '@/mcp/runtime/sessionMcpClient.testkit';

afterEach(() => {
    vi.unstubAllEnvs();
    daemonCatalogBoundary.read.mockReset();
    daemonCatalogBoundary.execute.mockReset().mockResolvedValue({ matched: false });
});

function bootstrap(accountSettings: AccountSettings | null = null, session: Parameters<typeof resolveRunnerMcpServers>[0]['session'] = Object.assign(createMutableApiSessionClientFixture({
    sessionId: 'offline-child-bootstrap', metadataPermissionMode: 'default',
    overrides: { getServerBinding: () => ({ serverId: 'test-home', serverUrl: 'https://test-home.example.test' }) },
}), {
    getWorkDepth: () => 0,
    getActiveTurnPermissionWitness: () => ({ turnId: 'offline-bootstrap-turn', workDepth: 0,
        causalPermissionAuthority: { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'default' as const } }),
})) {
    vi.stubEnv('HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT', '1');
    vi.stubEnv('HAPPIER_ACTIONS_SETTINGS_V1', '');
    return resolveRunnerMcpServers({
        session,
        credentials: { token: 'offline-session-fixture', encryption: null },
        accountCredentials: null,
        accountSettings,
        ...(accountSettings ? { actionsSettingsProvider: createActionSettingsProvider({ accountSettings }) } : {}),
        machineId: 'offline-machine', directory: '/tmp/offline-child-bootstrap', env: { NODE_ENV: 'test' },
    });
}

it('discovers and dispatches refreshed long plugin names through the actual Agent stdio bridge', async () => {
    const originalName = 'acme_' + 'long_'.repeat(10) + 'echo';
    const tool = {
        toolId: 'acme.example/echo', actionId: 'acme.example/actions/echo', name: originalName,
        title: 'Plugin echo', description: 'Echo', inputSchema: { type: 'object', properties: {} },
        surfaces: ['mcp', 'agent'] as const, expectedContributorOccurrenceId: 'occurrence-one',
    };
    let tools = [tool];
    daemonCatalogBoundary.read.mockImplementation(async () => ({ kind: 'available', plugins: [], tools: structuredClone(tools) }));
    daemonCatalogBoundary.execute.mockImplementation(async request => request.actionId === 'acme.example/echo'
        ? { matched: true, result: { ok: true, result: { completed: true } } }
        : { matched: false });
    const runtime = await bootstrap();
    const client = new Client({ name: 'session-agent-bridge', version: '1.0.0' });
    try {
        const naming = await runtime.resolveMcpToolNaming!({ serverName: 'happier', toolNameMaxLength: 40 });
        expect(naming).not.toBeNull();
        const server = naming!.launchConfig;
        const transport = new StdioClientTransport({
            command: server.command,
            args: server.args ? [...server.args] : undefined,
            env: { ...getDefaultEnvironment(), ...server.env },
            stderr: 'pipe',
        });
        let stderr = '';
        transport.stderr?.on('data', chunk => { stderr += String(chunk); });
        await client.connect(transport);
        const advertised = await client.listTools();
        expect(advertised.tools.map(entry => entry.name), stderr).toEqual(expect.arrayContaining([
            'action_execute', 'action_spec_get',
        ]));
        expect(advertised.tools.every(entry => entry.name.length <= 40), stderr).toBe(true);
        const projectedName = naming!.tools.find(entry => entry.originalName === originalName)!.projectedName;
        expect(advertised.tools.map(entry => entry.name)).toContain(projectedName);
        expect(projectedName).not.toBe(originalName);
        const result = await client.callTool({ name: projectedName, arguments: {} });
        expect(result, stderr).toMatchObject({ isError: false, content: [{ type: 'text', text: JSON.stringify({ completed: true }) }] });
        expect(daemonCatalogBoundary.execute.mock.calls.some(([request]) => request.actionId === 'acme.example/echo'
            && request.expectedContributorOccurrenceId === 'occurrence-one')).toBe(true);

        // A new daemon occurrence uses the same transport alias and a fresh
        // host admission fence; no cached naming table owns tool visibility.
        tools = [{ ...tool, expectedContributorOccurrenceId: 'occurrence-two' }];
        await client.callTool({ name: projectedName, arguments: {} });
        expect(daemonCatalogBoundary.execute.mock.calls.at(-1)?.[0]).toMatchObject({
            actionId: 'acme.example/echo', expectedContributorOccurrenceId: 'occurrence-two',
        });
        tools = [];
        expect((await client.listTools()).tools.map(entry => entry.name)).not.toContain(projectedName);
        const callsBeforeRemoved = daemonCatalogBoundary.execute.mock.calls.length;
        await expect(client.callTool({ name: projectedName, arguments: {} })).rejects.toThrow();
        expect(daemonCatalogBoundary.execute.mock.calls.length).toBe(callsBeforeRemoved);
    } finally {
        await client.close();
        runtime.happierMcpServer.stop();
    }
});

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
    const tool = { toolId: 'acme.example/echo', actionId: 'acme.example/actions/echo', name: 'acme_echo',
        title: 'Echo', description: 'Echo', inputSchema: { type: 'object', properties: {} },
        surfaces: ['mcp', 'agent'] as const, expectedContributorOccurrenceId: 'occurrence-one' };
    let tools = [tool];
    daemonCatalogBoundary.read.mockImplementation(async () => ({ kind: 'available', plugins: [],
        tools: structuredClone(tools), projection: { ...projection } }));
    const runtime = await bootstrap(null, session);
    const client = new Client({ name: 'offline-catalog-signal', version: '1.0.0' });
    try {
        expect(daemonCatalogBoundary.read).toHaveBeenCalledTimes(1);
        await client.connect(sessionMcpTestTransport(runtime.happierMcpServer));
        const observed = await client.listTools();
        expect(observed.tools.some(entry => entry.name === 'acme_echo')).toBe(true);
        const naming = await runtime.resolveMcpToolNaming!({ serverName: 'happier', toolNameMaxLength: 40 });
        expect(new Set(naming!.tools.map(entry => entry.originalName))).toEqual(new Set(observed.tools.map(entry => entry.name)));
        expect(new Set(await runtime.happierMcpServer.readToolNames())).toEqual(new Set(observed.tools.map(entry => entry.name)));
        const before = daemonCatalogBoundary.read.mock.calls.length;
        await client.listTools();
        await client.callTool({ name: 'change_title', arguments: { title: 'Unchanged catalog' } });
        expect(daemonCatalogBoundary.read.mock.calls.length - before).toBe(0);
        tools = [];
        projection.contributionRegistryProjectionRevision += 1;
        await session.rpcHandlerManager.invokeLocal('session.pluginCatalog.invalidate.v1', projection);
        expect((await client.listTools()).tools.some(entry => entry.name === 'acme_echo')).toBe(false);
        const removed = await runtime.resolveMcpToolNaming!({ serverName: 'happier', toolNameMaxLength: 40 });
        expect(removed!.tools.some(entry => entry.originalName === 'acme_echo')).toBe(false);
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
        const restored = await runtime.resolveMcpToolNaming!({ serverName: 'happier', toolNameMaxLength: 40 });
        expect(restored!.tools.some(entry => entry.originalName === 'acme_echo')).toBe(true);
        await client.listTools();
        expect(daemonCatalogBoundary.read.mock.calls.length - before).toBe(2);
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
    let readReady = () => false;
    let epoch = 1;
    const session = createMutableApiSessionClientFixture({
        sessionId: 'offline-signal-registration', metadataPermissionMode: 'default',
        overrides: {
            getServerBinding: () => ({ serverId: 'test-home', serverUrl: 'https://test-home.example.test' }),
            isDaemonPluginCatalogSignalReady: () => readReady(),
            getEphemeralStreamConnectionEpoch: () => epoch,
        },
    });
    const method = 'session.pluginCatalog.invalidate.v1';
    readReady = () => session.rpcHandlerManager.isHandlerRegistrationAcknowledged(method);
    // Only Socket.IO delivery is substituted at this system boundary; the
    // registration acknowledgement, local RPC and signal owners stay real.
    const transportEvents = new EventEmitter();
    const socketBoundary = {
        auth: { clientType: 'session-scoped' },
        on: (event: string, listener: (payload: unknown) => void) => { transportEvents.on(event, listener); },
        emit: () => {},
    };
    const socket = socketBoundary as unknown as Socket;
    session.rpcHandlerManager.onSocketConnect(socket);
    const projection = { runtimeId: 'offline-daemon', contributionRegistryProjectionRevision: 1 };
    daemonCatalogBoundary.read.mockImplementation(async () => ({ kind: 'available', plugins: [], tools: [], projection: { ...projection } }));
    registerHappierSessionAgentToolRpc(session);
    const call = () => session.rpcHandlerManager.invokeLocal('session.agentTool.call.v1', {
        toolName: 'change_title', args: { title: 'Registration readiness' },
    });
    try {
        await call(); await call();
        expect(daemonCatalogBoundary.read).toHaveBeenCalledTimes(2);
        transportEvents.emit(SOCKET_RPC_EVENTS.REGISTERED, { method: `${session.sessionId}:${method}` });
        await call(); await call();
        expect(daemonCatalogBoundary.read).toHaveBeenCalledTimes(3);
        expect(daemonCatalogBoundary.read).toHaveBeenLastCalledWith({ selection: 'tools' });
        projection.contributionRegistryProjectionRevision += 1;
        await session.rpcHandlerManager.invokeLocal(method, projection);
        await call(); await call();
        expect(daemonCatalogBoundary.read).toHaveBeenCalledTimes(4);
        session.rpcHandlerManager.onSocketDisconnect();
        epoch += 1;
        await call(); await call();
        expect(daemonCatalogBoundary.read).toHaveBeenCalledTimes(6);
        session.rpcHandlerManager.onSocketConnect(socket);
        transportEvents.emit(SOCKET_RPC_EVENTS.REGISTERED, { method: `${session.sessionId}:${method}` });
        await call(); await call();
        expect(daemonCatalogBoundary.read).toHaveBeenCalledTimes(7);
    } finally {
        session.rpcHandlerManager.onSocketDisconnect();
        transportEvents.removeAllListeners();
    }
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
        runtime = await bootstrap();
        const coverage = await inspector.post('Profiler.takePreciseCoverage');
        const errorFunctions = coverage.result
            .filter(script => isZodErrorsScript(script.url))
            .flatMap(script => script.functions);
        const errorConstructionCount = errorFunctions
            .filter(fn => fn.functionName === 'initializer')
            .reduce((sum, fn) => sum + (fn.ranges[0]?.count ?? 0), 0);
        await client.connect(sessionMcpTestTransport(runtime.happierMcpServer));
        const first = await client.listTools();
        const second = await client.listTools();
        expect(first.tools.some(tool => tool.name === 'change_title')).toBe(true);
        expect(second.tools.map(tool => tool.name)).toEqual(first.tools.map(tool => tool.name));
        // Compare the same real preparation with explicit defaults: other
        // optional schema checks are not the regression under investigation.
        await inspector.post('Profiler.takePreciseCoverage');
        explicitRuntime = await bootstrap(explicitDefaults);
        const explicitCoverage = await inspector.post('Profiler.takePreciseCoverage');
        const explicitErrorCount = explicitCoverage.result
            .filter(script => isZodErrorsScript(script.url))
            .flatMap(script => script.functions).filter(fn => fn.functionName === 'initializer')
            .reduce((sum, fn) => sum + (fn.ranges[0]?.count ?? 0), 0);
        z.string().safeParse(null);
        const control = await inspector.post('Profiler.takePreciseCoverage');
        expect(control.result.filter(script => isZodErrorsScript(script.url))
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

it('retains pending catalog preparation and admits built-in startup after optional extras become unavailable', async () => {
    const catalog = createDeferred<Readonly<{ kind: 'unavailable'; code: string }>>();
    const requested = createDeferred<void>();
    const events: unknown[] = [];
    const session = createMutableApiSessionClientFixture({ sessionId: 'optional-plugin-catalog', overrides: {
        getServerBinding: () => ({ serverId: 'test-home', serverUrl: 'https://test-home.example.test' }),
        enqueueSessionEventCommitted: async event => { events.push(event); return { persisted: true, delivered: true }; },
    } });
    daemonCatalogBoundary.read.mockImplementation(() => { requested.resolve(); return catalog.promise; });
    const pending = bootstrap(null, session);
    void pending.catch(() => undefined);
    await requested.promise;
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    catalog.resolve({ kind: 'unavailable', code: 'daemon_unavailable' });
    daemonCatalogBoundary.read.mockResolvedValue({ kind: 'unavailable', code: 'daemon_unavailable' });
    const runtime = await pending;
    const client = new Client({ name: 'optional-plugin-catalog', version: '1' });
    const notificationStream = new AbortController();
    try {
        expect(runtime.mcpServers.happier).toBeDefined();
        expect(runtime.happierMcpServer).toMatchObject({ toolNames: expect.arrayContaining(['action_execute', 'action_spec_get']) });
        expect(readSessionCapabilityNoticeV1(events[0])).toEqual({ v: 1, items: [{
            kind: 'mcp_server', name: 'MCP plugin tools', code: 'daemon_plugin_catalog_unavailable',
        }] });
        const mcpFetch = sessionMcpTestFetch(runtime.happierMcpServer);
        const auth = sessionMcpAuthorizationHeaders(runtime.happierMcpServer);
        const stream = await mcpFetch(runtime.happierMcpServer.url, { headers: { Accept: 'text/event-stream', ...auth }, signal: notificationStream.signal });
        expect(stream.status).toBe(200);
        notificationStream.abort();
        const unavailable = await mcpFetch(runtime.happierMcpServer.url, { method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...auth },
            body: JSON.stringify({ jsonrpc: '2.0', id: 'optional-catalog', method: 'tools/list' }),
        });
        expect(unavailable.status).toBe(503);
        expect(await unavailable.json()).toMatchObject({ ok: false, errorCode: 'daemon_plugin_catalog_unavailable' });
        registerHappierSessionAgentToolRpc(session);
        expect(await session.rpcHandlerManager.invokeLocal('session.agentTool.call.v1', {
            toolName: 'action_spec_get', args: { id: 'browser.view.open' },
        })).toMatchObject({ ok: false, errorCode: 'daemon_plugin_catalog_unavailable' });
        daemonCatalogBoundary.read.mockResolvedValue({ kind: 'available', plugins: [], tools: [] });
        await client.connect(sessionMcpTestTransport(runtime.happierMcpServer));
        expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['action_execute', 'action_spec_get']));
    } finally {
        notificationStream.abort(); await client.close(); runtime.happierMcpServer.stop();
    }
}, 180_000);

it('preserves host cancellation when optional plugin catalog preparation becomes unavailable', async () => {
    const lifetime = new AbortController();
    const requested = createDeferred<void>();
    const catalog = createDeferred<Readonly<{ kind: 'unavailable'; code: string }>>();
    daemonCatalogBoundary.read.mockImplementation(() => { requested.resolve(); return catalog.promise; });
    const session = Object.assign(createMutableApiSessionClientFixture({ sessionId: 'cancelled-plugin-bootstrap' }), {
        getRuntimeLifetimeSignal: () => lifetime.signal,
    });
    const pending = bootstrap(null, session);
    void pending.catch(() => undefined);
    await requested.promise;
    const reason = new Error('host_runtime_retired');
    lifetime.abort(reason);
    catalog.resolve({ kind: 'unavailable', code: 'daemon_unavailable' });
    await expect(pending).rejects.toBe(reason);
});

it('reuses the admitted Action inventory across stateless MCP requests', async () => {
    daemonCatalogBoundary.read.mockResolvedValue({ kind: 'available', plugins: [], tools: [] });
    const inspector = new Session();
    inspector.connect();
    const client = new Client({ name: 'offline-request-cost', version: '1.0.0' });
    let runtime: Awaited<ReturnType<typeof bootstrap>> | undefined;
    // Observe real HTTP; the only substituted network boundary is daemon IPC.
    const http = vi.spyOn(globalThis, 'fetch');
    try {
        await inspector.post('Profiler.enable');
        await inspector.post('Profiler.startPreciseCoverage', { callCount: true, detailed: false });
        async function measure(label: string, operation: () => Promise<unknown>) {
            await inspector.post('Profiler.takePreciseCoverage');
            const reads = daemonCatalogBoundary.read.mock.calls.length;
            const httpCalls = http.mock.calls.length;
            const result = await operation();
            const coverage = await inspector.post('Profiler.takePreciseCoverage');
            const count = (name: string) => coverage.result.flatMap(script => script.functions)
                .filter(fn => fn.functionName === name)
                .reduce((total, fn) => total + (fn.ranges[0]?.count ?? 0), 0);
            const row = { label,
                constructions: count('createHappierMcpServer'), inventory: count('listBuiltInHappierTools'),
                maps: count('createActionToolNameToIdMap'), lookups: count('getActionSpec'),
                schemas: count('toMcpToolInputSchema'),
                httpCalls: http.mock.calls.length - httpCalls,
                daemonReads: daemonCatalogBoundary.read.mock.calls.length - reads };
            return { result, row };
        }
        const prepared = await measure('bootstrap', async () => { runtime = await bootstrap(); });
        if (!runtime) throw new Error('bootstrap_missing');
        const mcpServer = runtime.happierMcpServer;
        await measure('initialize+notification+GET', async () => await client.connect(sessionMcpTestTransport(mcpServer)));
        await measure('tools/list', async () => await client.listTools());
        const second = await measure('tools/list repeated', async () => await client.listTools());
        // Account writes require the real daemon Session capability. This
        // offline cache measurement uses the host's local catalog read instead.
        const call = await measure('tools/call action_spec_get', async () => await client.callTool({ name: 'action_spec_get', arguments: { id: 'browser.view.open' } }));
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
