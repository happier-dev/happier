import { afterEach, describe, expect, it } from 'vitest';
import { act, renderHook, standardCleanup } from '@/dev/testkit';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createMcpServerActionExecuteV1, MCP_SERVER_ACTION_INPUT_SCHEMAS_V1, MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';
import { commitMcpServerCatalogMutationV1, loadMcpServerCatalogV1 } from '@happier-dev/protocol/mcp/servers/serverCatalogV1';
import { McpServerCatalogV1Schema, type McpServerCatalogV1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { DetectedMcpServerV1Schema } from '@happier-dev/protocol/mcp/servers/daemonRpcV1';
import { createRegistryHostV1, BUILT_IN_REGISTRY_SOURCES_V1, checkRegistryUpstreamV1,
    REGISTRY_ACTION_OUTPUT_SCHEMAS_V1, type RegistryHttpV1 } from '@happier-dev/protocol/registries';
import { MCP_REGISTRY_V01_READ_FIXTURE } from '../../../../../../packages/protocol/src/registries/formats/fixtures/mcpRegistryV01Fixture';
import { useMcpFoundAdoption } from './found/useMcpFoundAdoption';
import { useMcpServerUpdate } from './detail/useMcpServerUpdate';

afterEach(standardCleanup);

// Only persistence and upstream HTTP are replaced. The hook, public Action admission,
// family adapter, registry reader/checker, mapper and catalog CAS all run for real.
function harness(initial: McpServerCatalogV1 = { v: 1, servers: [], bindings: [] }) {
    let catalog = McpServerCatalogV1Schema.parse(initial);
    let revision = 0;
    let writes = 0;
    let ids = 0;
    let disabled = false;
    let current = true;
    let sourceRemoved = false;
    let upstreamMode: 'ready' | 'failed' | 'removed' = 'ready';
    let latestVersion = '2.0.0';
    let newRequired = false;
    let wired = true;
    const calls: Array<{ id: string; input: unknown }> = [];
    const sources = () => sourceRemoved ? [] : BUILT_IN_REGISTRY_SOURCES_V1;
    const record = (version: string) => ({ ...MCP_REGISTRY_V01_READ_FIXTURE, server: {
        ...MCP_REGISTRY_V01_READ_FIXTURE.server, version, remotes: [{ type: 'streamable-http', url: 'https://updated.example.test/mcp', headers: [
            { name: 'Authorization', isRequired: true, isSecret: true },
            ...(newRequired ? [{ name: 'X-Tenant', isRequired: true }] : []),
        ] }],
    } });
    const http: RegistryHttpV1 = {
        getJson: async url => {
            if (upstreamMode === 'failed') return { ok: false, status: { state: 'unreachable' } };
            const parsed = new URL(url);
            const version = decodeURIComponent(parsed.pathname.split('/').at(-1)!);
            return { ok: true, fetchedAt: 10, value: parsed.pathname.includes('/versions/') ? record(version === 'latest' ? latestVersion : version)
                : { servers: upstreamMode === 'removed' ? [] : [record(latestVersion)], metadata: { count: upstreamMode === 'removed' ? 0 : 1 } } };
        },
        getText: async () => { throw new Error('Unexpected text read'); },
        getBytes: async () => { throw new Error('Unexpected bytes read'); },
    };
    const registry = createRegistryHostV1({ host: 'web', http, readSources: async () => sources(),
        updates: async () => {
            const items = catalog.servers.flatMap(server => server.origin?.kind === 'registry' ? [{ key: server.id, provenance: server.origin.provenance }] : []);
            const result = await checkRegistryUpstreamV1({ http }, { sources: sources(), items });
            return REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.updates.check'].parse({ checkedAt: 20,
                results: [...result].map(([key, upstream]) => ({ kind: 'mcpServer', key, upstream })) });
        },
    });
    const family = createMcpServerActionExecuteV1({
        ruleWriteContext: () => ({ nowMs: 10, newId: () => `found-${++ids}` }),
        readCatalog: () => loadMcpServerCatalogV1({ mode: 'plain', material: null, readRow: async () => ({ status: 'present', revision, content: { t: 'plain', v: catalog } }) }),
        registryActionExecute: request => registry.execute(request.actionId, request.input),
        mutate: (change, expectedRevision) => commitMcpServerCatalogMutationV1({ catalog, revision, change, scope: null, writeCatalog: async candidate => {
            if (candidate.expectedRevision !== revision || expectedRevision !== revision) return { status: 'conflict', revision };
            catalog = candidate.catalog; writes += 1;
            return { status: 'updated', revision: ++revision, cursor: revision };
        } }),
        machine: async () => { throw new Error('Continuation must not launch discovered code'); },
    });
    // Unused host effect ports fail loudly; admission and the consumed family stay real.
    const unexpectedBoundary = async (): Promise<never> => { throw new Error('Unexpected host effect'); };
    const executor = createActionExecutor({
        executionRunStart: unexpectedBoundary, executionRunList: unexpectedBoundary, executionRunGet: unexpectedBoundary,
        detachedExecutionRunSend: unexpectedBoundary, executionRunStop: unexpectedBoundary, executionRunAction: unexpectedBoundary,
        executionRunWait: unexpectedBoundary, sessionOpen: unexpectedBoundary, sessionFork: unexpectedBoundary,
        sessionRollback: unexpectedBoundary, sessionSpawnNew: unexpectedBoundary, pathsListRecent: unexpectedBoundary,
        machinesList: unexpectedBoundary, serversList: unexpectedBoundary, reviewEnginesList: unexpectedBoundary,
        agentsBackendsList: unexpectedBoundary, agentsModelsList: unexpectedBoundary, sessionSendMessage: unexpectedBoundary,
        sessionPermissionRespond: unexpectedBoundary, sessionUserActionAnswer: unexpectedBoundary, sessionModeSet: unexpectedBoundary,
        sessionModesList: unexpectedBoundary, sessionTargetPrimarySet: unexpectedBoundary, sessionTargetTrackedSet: unexpectedBoundary,
        sessionList: unexpectedBoundary, sessionActivityGet: unexpectedBoundary, sessionRecentMessagesGet: unexpectedBoundary,
        daemonMemorySearch: unexpectedBoundary, daemonMemoryGetWindow: unexpectedBoundary, daemonMemoryEnsureUpToDate: unexpectedBoundary,
        resetGlobalVoiceAgent: () => { throw new Error('Unexpected host effect'); },
        isActionEnabled: () => !disabled,
        mcpServerAction: request => wired ? family(request) : Promise.resolve({ ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' }),
        registryActionExecute: request => registry.execute(request.actionId, request.input),
    });
    const execute: Parameters<typeof useMcpFoundAdoption>[0]['execution']['execute'] = async (id, input) => {
        calls.push({ id, input });
        return executor.execute(id, input, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } });
    };
    return { execution: { execute, ready: true, isCurrent: () => current }, get catalog() { return catalog; }, get revision() { return revision; },
        get writes() { return writes; }, calls, disable: () => { disabled = true; }, retire: () => { current = false; },
        removeSource: () => { sourceRemoved = true; }, setUpstream: (value: typeof upstreamMode) => { upstreamMode = value; },
        setLatest: (version: string) => { latestVersion = version; }, requireTenant: () => { newRequired = true; }, miswire: () => { wired = false; } };
}

const found = DetectedMcpServerV1Schema.parse({ provider: 'claude', name: 'one', transport: 'stdio', stdio: { command: 'tool', args: [] },
    envKeys: ['API_KEY'], enabled: true, source: { kind: 'user', path: '/config.json' } });
const saved = McpServerCatalogV1Schema.parse({ v: 1, servers: [{ id: 'saved', name: 'mine', title: 'My tools', transport: 'http',
    remote: { url: 'https://previous.example.test/mcp', headers: { Authorization: { t: 'savedSecret', secretId: 'chosen-secret' } } },
    env: { REGION: { t: 'literal', v: 'eu' } }, tools: { default: 'ask', overrides: { remove: 'off' } }, createdAt: 1, updatedAt: 1,
    origin: { kind: 'registry', provenance: { sourceId: 'builtin:mcp-registry', sourceUrl: 'https://registry.modelcontextprotocol.io', format: 'mcp-registry',
        itemId: 'com.playwrightgen/playwrightgen', ref: { kind: 'version', version: '1.0.0' }, importedAt: 1 }, upstream: { state: 'update_available', latest: { kind: 'version', version: '2.0.0' } } },
}], bindings: [{ id: 'rule', serverId: 'saved', enabled: false, target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1 }] });

describe('Found adoption continuation', () => {
    it.each([{ t: 'savedSecret', secretId: 'chosen-ref' }, { t: 'literal', v: '${API_KEY}' }, { t: 'literal', v: 'entered-value' }] as const)
    ('waits for an explicit value choice then recovers an already-added server without a write: %j', async choice => {
        const owner = harness();
        const hook = await renderHook(() => useMcpFoundAdoption({ machineOnline: true, machineId: 'machine-1', catalog: owner.catalog, catalogRevision: owner.revision, execution: owner.execution }));
        await act(async () => { await hook.getCurrent().begin(found); });
        expect(hook.getCurrent().state.status).toBe('choosing');
        expect(hook.getCurrent().openValues).toBe(1);
        expect(owner.writes).toBe(0);
        await act(async () => { hook.getCurrent().setValue('one:env:API_KEY', choice); });
        expect(hook.getCurrent().openValues).toBe(0);
        await act(async () => { await hook.getCurrent().submit(); });
        expect(hook.getCurrent().state).toMatchObject({ status: 'adopted', serverId: owner.catalog.servers[0]?.id });
        expect(owner.catalog.servers[0]?.env.API_KEY).toEqual(choice);
        const input = owner.calls.find(call => call.id === 'mcp.found.adopt')?.input;
        expect(MCP_SERVER_ACTION_INPUT_SCHEMAS_V1['mcp.found.adopt'].parse(input)).toMatchObject({ values: { 'one:env:API_KEY': choice } });
        await act(async () => { await hook.getCurrent().begin(found); });
        expect(hook.getCurrent().state).toMatchObject({ status: 'adopted', serverId: owner.catalog.servers[0]?.id });
        expect(owner.writes).toBe(1);
    });
    it('keeps choices on an admission refusal, and cancels without committing them', async () => {
        const owner = harness();
        const hook = await renderHook(() => useMcpFoundAdoption({ machineOnline: true, machineId: 'machine-1', catalog: owner.catalog, catalogRevision: owner.revision, execution: owner.execution }));
        await act(async () => { await hook.getCurrent().begin(found); });
        await act(async () => { hook.getCurrent().setValue('one:env:API_KEY', { t: 'literal', v: '${API_KEY}' }); });
        owner.disable();
        await act(async () => { await hook.getCurrent().submit(); });
        expect(hook.getCurrent().state).toMatchObject({ status: 'failed', errorCode: 'action_disabled' });
        expect(hook.getCurrent().answers.rows['one:env:API_KEY']).toEqual({ t: 'literal', v: '${API_KEY}' });
        expect(owner.writes).toBe(0);
        act(() => { hook.getCurrent().cancel(); });
        expect(hook.getCurrent().state.status).toBe('idle');
    });
    it('asks remote header names separately from environment names and never invents values', async () => {
        const owner = harness();
        const item = DetectedMcpServerV1Schema.parse({ ...found, transport: 'http', stdio: undefined,
            remote: { url: 'https://found.example.test/mcp', headers: ['Authorization'] }, envKeys: ['REGION'] });
        const hook = await renderHook(() => useMcpFoundAdoption({ machineOnline: true, machineId: 'machine-1', catalog: owner.catalog,
            catalogRevision: owner.revision, execution: owner.execution }));
        await act(async () => { await hook.getCurrent().begin(item); await hook.getCurrent().submit(); });
        expect(owner.writes).toBe(0);
        expect(hook.getCurrent().openValues).toBe(2);
        act(() => {
            hook.getCurrent().setValue('one:header:Authorization', { t: 'template', template: 'Bearer {key}', vars: { key: { t: 'savedSecret', secretId: 'header-key' } } });
            hook.getCurrent().setValue('one:env:REGION', { t: 'literal', v: 'eu' });
        });
        await act(async () => { await hook.getCurrent().submit(); });
        expect(owner.catalog.servers[0]).toMatchObject({ env: { REGION: { t: 'literal', v: 'eu' } },
            remote: { headers: { Authorization: { t: 'template', vars: { key: { t: 'savedSecret', secretId: 'header-key' } } } } } });
        expect(hook.getCurrent().state.status).toBe('adopted');
    });
    it('withdraws a continuation on machine change and rejects retired admission', async () => {
        const owner = harness();
        const hook = await renderHook((machineId: string) => useMcpFoundAdoption({ machineOnline: true, machineId, catalog: owner.catalog,
            catalogRevision: owner.revision, execution: owner.execution }), { initialProps: 'machine-1' });
        await act(async () => { await hook.getCurrent().begin(found); });
        await hook.rerender('machine-2');
        expect(hook.getCurrent().state.status).toBe('idle');
        await act(async () => { await hook.getCurrent().submit(); });
        expect(owner.writes).toBe(0);
        owner.retire();
        await act(async () => { await hook.getCurrent().begin(found); });
        expect(owner.calls).toHaveLength(0);
    });
});

describe('saved MCP upstream continuation', () => {
    it('reviews the pinned version, asks new inputs, and preserves user refs, name, tools and rules when Update is admitted', async () => {
        const owner = harness(saved); owner.requireTenant();
        // The page holds the saved row it reviewed until the catalog refresh lands, so the ACK is observable as applied.
        const reviewed = owner.catalog.servers[0]!;
        const hook = await renderHook(() => useMcpServerUpdate({ server: reviewed, catalogRevision: owner.revision, execution: owner.execution, reload: () => {} }));
        await act(async () => { await hook.getCurrent().checkNow(); });
        await act(async () => { await hook.getCurrent().loadReview(); });
        expect(hook.getCurrent().review).toMatchObject({ status: 'ready', pointer: { version: '2.0.0' }, missingValues: [{ key: 'X-Tenant' }] });
        expect(hook.getCurrent().canApply).toBe(false);
        act(() => { hook.getCurrent().setValue('X-Tenant', { t: 'literal', v: 'acme' }); });
        expect(hook.getCurrent().canApply).toBe(true);
        owner.setLatest('3.0.0');
        await act(async () => { await hook.getCurrent().apply(); });
        expect(hook.getCurrent().applyState.status).toBe('applied');
        expect(owner.catalog.servers[0]).toMatchObject({ name: 'mine', title: 'My tools', env: saved.servers[0]!.env, tools: saved.servers[0]!.tools,
            remote: { url: 'https://updated.example.test/mcp', headers: { Authorization: { t: 'savedSecret', secretId: 'chosen-secret' }, 'X-Tenant': { t: 'literal', v: 'acme' } } },
            origin: { provenance: { ref: { kind: 'version', version: '2.0.0' } } } });
        expect(owner.catalog.bindings).toEqual(saved.bindings);
        const update = owner.calls.find(call => call.id === 'mcp.servers.update');
        expect(MCP_SERVER_ACTION_INPUT_SCHEMAS_V1['mcp.servers.update'].parse(update?.input)).toMatchObject({ from: { registry: { version: '2.0.0' } } });
    });
    it.each(['failed', 'removed', 'source-removed'] as const)('does not mistake %s for current, and never writes', async mode => {
        const owner = harness(saved);
        const hook = await renderHook(() => useMcpServerUpdate({ server: owner.catalog.servers[0]!, catalogRevision: owner.revision, execution: owner.execution, reload: () => {} }));
        if (mode === 'source-removed') owner.removeSource(); else owner.setUpstream(mode);
        await act(async () => { await hook.getCurrent().checkNow(); });
        expect(hook.getCurrent().check.upstream).toMatchObject(mode === 'removed' ? { state: 'removed_from_source' }
            : { state: 'unchecked', reason: { state: mode === 'failed' ? 'unreachable' : 'invalid_source' } });
        expect(hook.getCurrent().check.failed).toBe(mode !== 'removed');
        await act(async () => { await hook.getCurrent().loadReview(); await hook.getCurrent().apply(); });
        expect(hook.getCurrent().canApply).toBe(false);
        expect(owner.writes).toBe(0);
        expect(owner.catalog).toEqual(saved);
    });
    it('uses real admission and detects a missing MCP family binding', async () => {
        const owner = harness(saved);
        const hook = await renderHook(() => useMcpServerUpdate({ server: owner.catalog.servers[0]!, catalogRevision: owner.revision, execution: owner.execution, reload: () => {} }));
        await act(async () => { await hook.getCurrent().loadReview(); });
        owner.disable();
        await act(async () => { await hook.getCurrent().apply(); });
        expect(hook.getCurrent().applyState).toMatchObject({ status: 'failed', code: 'action_disabled' });
        expect(owner.writes).toBe(0);
        const disconnected = harness(saved); disconnected.miswire();
        const other = await renderHook(() => useMcpServerUpdate({ server: disconnected.catalog.servers[0]!, catalogRevision: disconnected.revision, execution: disconnected.execution, reload: () => {} }));
        await act(async () => { await other.getCurrent().loadReview(); await other.getCurrent().apply(); });
        expect(other.getCurrent().applyState).toMatchObject({ status: 'failed', code: 'unsupported_action' });
        expect(disconnected.writes).toBe(0);
    });
    it('withdraws Update when the reviewed catalog revision changes, without recapturing the CAS', async () => {
        const owner = harness(saved);
        const hook = await renderHook((catalogRevision: number) => useMcpServerUpdate({ server: saved.servers[0]!,
            catalogRevision, execution: owner.execution, reload: () => {} }), { initialProps: owner.revision });
        await act(async () => { await hook.getCurrent().loadReview(); });
        expect(hook.getCurrent().canApply).toBe(true);
        await hook.rerender(1);
        expect(hook.getCurrent().staleReview).toBe(true);
        await act(async () => { await hook.getCurrent().apply(); });
        expect(hook.getCurrent().canApply).toBe(false);
        expect(owner.writes).toBe(0);
        expect(owner.calls.filter(call => call.id === 'mcp.servers.update')).toHaveLength(0);
    });
    it('does not apply an earlier review after a failed Check now, and allows recovery after a successful check', async () => {
        const owner = harness(saved);
        const hook = await renderHook(() => useMcpServerUpdate({ server: saved.servers[0]!,
            catalogRevision: owner.revision, execution: owner.execution, reload: () => {} }));
        await act(async () => { await hook.getCurrent().loadReview(); });
        expect(hook.getCurrent().canApply).toBe(true);
        owner.setUpstream('failed');
        await act(async () => { await hook.getCurrent().checkNow(); });
        expect(hook.getCurrent().canApply).toBe(false);
        await act(async () => { await hook.getCurrent().apply(); });
        expect(owner.writes).toBe(0);
        owner.setUpstream('ready');
        await act(async () => { await hook.getCurrent().checkNow(); });
        expect(hook.getCurrent().canApply).toBe(true);
        await act(async () => { await hook.getCurrent().apply(); });
        expect(hook.getCurrent().applyState.status).toBe('applied');
        expect(owner.writes).toBe(1);
    });
    it('keeps a reviewed value choice after refusal and clears it on Account retirement', async () => {
        const owner = harness(saved); owner.requireTenant();
        const hook = await renderHook((scopeKey: string) => useMcpServerUpdate({ server: saved.servers[0]!,
            scopeKey, catalogRevision: owner.revision, execution: owner.execution, reload: () => {} }), { initialProps: 'account-1' });
        await act(async () => { await hook.getCurrent().loadReview(); });
        act(() => { hook.getCurrent().setValue('X-Tenant', { t: 'literal', v: 'acme' }); });
        owner.disable();
        await act(async () => { await hook.getCurrent().apply(); });
        expect(hook.getCurrent().values['X-Tenant']).toEqual({ t: 'literal', v: 'acme' });
        expect(hook.getCurrent().applyState).toMatchObject({ status: 'failed', code: 'action_disabled' });
        await hook.rerender('account-2');
        expect(hook.getCurrent().review.status).toBe('idle');
        expect(hook.getCurrent().values).toEqual({});
        expect(hook.getCurrent().canApply).toBe(false);
    });
});
