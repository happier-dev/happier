import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyAcknowledgedMcpServerCatalog, applyMcpServerCatalogSnapshot, beginMcpServerCatalogLoad, getMcpServerCatalogSnapshot,
    resetMcpServerCatalogSnapshotsForTests, subscribeMcpServerCatalogSnapshots } from './mcpServerCatalogSnapshot';
import type { McpServerCatalogSnapshotV1 } from '@happier-dev/protocol/mcp/servers/serverCatalogV1';
import type { McpServerCatalogV1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { buildMcpServerCollection } from '@/components/settings/mcpServers/collection/mcpServerCollectionModel';
import { buildMcpHome } from '@/components/settings/mcpServers/home/mcpHomeModel';
import { resolveSavedSecretReference } from './savedSecretCatalogSnapshot';

// Collect the real global-reset owners before hooks, so cold module transforms do not consume their deadline.
await Promise.all([
    import('@/dev/testkit/harness/persistentUiState'),
    vi.importActual('@/sync/domains/machines/reachability/machineReachability'),
]);

afterEach(resetMcpServerCatalogSnapshotsForTests);
const scope = { serverId: 'home', accountId: 'account' };
const ready: McpServerCatalogSnapshotV1 = { status: 'ready', authority: 'active', revision: 3, diagnostics: [],
    catalog: { v: 1, servers: [{ id: 'server', name: 'server', transport: 'stdio',
        stdio: { command: 'mcp-server', args: [] }, env: {}, createdAt: 1, updatedAt: 1 }], bindings: [] } };

describe('MCP scoped catalog publication', () => {
    it.each(['read', 'acknowledgement'] as const)('reconciles a 128-server %s by identity without publishing equal responses', (source) => {
        const catalog: McpServerCatalogV1 = { v: 1,
            servers: Array.from({ length: 128 }, (_, index) => ({ id: `server-${index}`, name: `server-${index}`,
                transport: 'stdio', stdio: { command: 'mcp-server', args: [] }, env: {},
                tools: { default: 'ask', overrides: {} }, origin: { kind: 'registry', provenance: {
                    sourceId: 'registry', sourceUrl: 'https://registry.example.test', format: 'mcp-registry', itemId: `item-${index}`,
                    ref: { kind: 'version', version: '1.0.0' }, importedAt: 1,
                }, iconUrl: 'https://example.test/light.png', iconDarkUrl: 'https://example.test/dark.png' },
                createdAt: 1, updatedAt: 1 })),
            bindings: Array.from({ length: 128 }, (_, index) => ({ id: `rule-${index}`, serverId: `server-${index}`,
                target: { t: 'allMachines' }, enabled: true, createdAt: 1, updatedAt: 1 })),
            pluginServers: { 'plugin:test/one': { tools: { default: 'ask', overrides: {} } },
                'plugin:test/two': { tools: { default: 'ask', overrides: {} } } },
        };
        const publish = (value: McpServerCatalogV1, revision: number) => source === 'read'
            ? applyMcpServerCatalogSnapshot(scope, { status: 'ready', authority: 'active', revision, diagnostics: [], catalog: value }, true)
            : applyAcknowledgedMcpServerCatalog(scope, value, revision, true);
        publish(catalog, 1);
        const before = getMcpServerCatalogSnapshot(scope);
        expect(before.brandMarks?.['server-63']).toMatchObject({ displayName: 'server-63',
            light: { uri: 'https://example.test/light.png' }, dark: { uri: 'https://example.test/dark.png' } });
        const rows = buildMcpServerCollection({ ...before.value!, strictMode: false }, '', [], before.brandMarks);
        expect(rows.find(row => row.server.id === 'server-63')?.brandMark).toBe(before.brandMarks?.['server-63']);
        const home = buildMcpHome({ rows, signInOf: () => null, firstVisitDismissed: true,
            savedSecretCatalog: { resolveReference: ref => resolveSavedSecretReference(null, [], ref) } });
        expect(home.servers.find(server => server.id === 'server-63')?.brandMark).toBe(before.brandMarks?.['server-63']);
        const notify = vi.fn();
        const unsubscribe = subscribeMcpServerCatalogSnapshots(notify);
        publish(structuredClone(catalog), 1);
        expect(getMcpServerCatalogSnapshot(scope)).toBe(before);
        expect(notify).toHaveBeenCalledTimes(0);

        const changed = structuredClone(catalog);
        changed.servers[63] = { ...changed.servers[63]!, title: 'Changed', updatedAt: 2 };
        publish(changed, 2);
        const next = getMcpServerCatalogSnapshot(scope).value!;
        const marks = getMcpServerCatalogSnapshot(scope).brandMarks!;
        expect(Object.keys(marks)).toHaveLength(128);
        expect(Object.keys(marks).filter(id => marks[id] !== before.brandMarks?.[id])).toEqual(['server-63']);
        expect(notify).toHaveBeenCalledTimes(1);
        expect(next.servers.filter((server, index) => server !== before.value!.servers[index])).toHaveLength(1);
        expect(next.servers[63]!.stdio).toBe(before.value!.servers[63]!.stdio);
        expect(next.servers[63]!.env).toBe(before.value!.servers[63]!.env);
        expect(next.servers[63]!.tools).toBe(before.value!.servers[63]!.tools);
        expect(next.bindings).toBe(before.value!.bindings);
        expect(next.pluginServers).toBe(before.value!.pluginServers);

        const bindingChange = structuredClone(changed);
        bindingChange.bindings[63] = { ...bindingChange.bindings[63]!, enabled: false, updatedAt: 3 };
        publish(bindingChange, 3);
        const afterBinding = getMcpServerCatalogSnapshot(scope).value!;
        expect(getMcpServerCatalogSnapshot(scope).brandMarks).toBe(marks);
        expect(afterBinding.servers).toBe(next.servers);
        expect(afterBinding.bindings.filter((binding, index) => binding !== next.bindings[index])).toHaveLength(1);
        expect(afterBinding.bindings[63]!.target).toBe(next.bindings[63]!.target);
        expect(notify).toHaveBeenCalledTimes(2);

        const reordered = structuredClone(bindingChange);
        reordered.servers.reverse();
        reordered.bindings.reverse();
        publish(reordered, 4);
        const afterReorder = getMcpServerCatalogSnapshot(scope).value!;
        const serversById = new Map(afterBinding.servers.map(server => [server.id, server]));
        const bindingsById = new Map(afterBinding.bindings.map(binding => [binding.id, binding]));
        expect(afterReorder.servers.every(server => server === serversById.get(server.id))).toBe(true);
        expect(afterReorder.bindings.every(binding => binding === bindingsById.get(binding.id))).toBe(true);
        expect(afterReorder.servers.map(server => server.id)).toEqual(reordered.servers.map(server => server.id));

        const pluginChange = structuredClone(reordered);
        pluginChange.pluginServers!['plugin:test/one'] = { tools: { default: 'allow_all', overrides: {} } };
        publish(pluginChange, 5);
        const afterPlugin = getMcpServerCatalogSnapshot(scope).value!;
        expect(afterPlugin.servers).toBe(afterReorder.servers);
        expect(afterPlugin.bindings).toBe(afterReorder.bindings);
        expect(afterPlugin.pluginServers!['plugin:test/two']).toBe(afterReorder.pluginServers!['plugin:test/two']);
        expect(afterPlugin.pluginServers!['plugin:test/one']).not.toBe(afterReorder.pluginServers!['plugin:test/one']);

        const remaining = { ...pluginChange, servers: pluginChange.servers.slice(1), bindings: pluginChange.bindings.slice(1) };
        publish(remaining, 6);
        const afterRemoval = getMcpServerCatalogSnapshot(scope).value!;
        expect(afterRemoval.servers).toHaveLength(127);
        expect(afterRemoval.bindings).toHaveLength(127);
        expect(afterRemoval.servers[0]).toBe(afterPlugin.servers[1]);
        expect(afterRemoval.bindings[0]).toBe(afterPlugin.bindings[1]);
        unsubscribe();
    });
    it('keeps unchanged catalog identity and subscribers quiet across equal reads and other Accounts', () => {
        const notify = vi.fn();
        const unsubscribe = subscribeMcpServerCatalogSnapshots(notify);
        applyMcpServerCatalogSnapshot(scope, ready, true);
        const first = getMcpServerCatalogSnapshot(scope);
        applyMcpServerCatalogSnapshot(scope, structuredClone(ready), true);
        expect(getMcpServerCatalogSnapshot(scope)).toBe(first);
        expect(notify).toHaveBeenCalledTimes(1);
        applyMcpServerCatalogSnapshot({ serverId: 'other', accountId: 'account' }, ready, true);
        expect(getMcpServerCatalogSnapshot(scope)).toBe(first);
        unsubscribe();
    });
    it('retains explicitly stale display data during reload, rejects retired responses and withdraws on lost admission', () => {
        applyMcpServerCatalogSnapshot(scope, ready, true);
        const value = getMcpServerCatalogSnapshot(scope).value;
        beginMcpServerCatalogLoad(scope);
        expect(getMcpServerCatalogSnapshot(scope)).toMatchObject({ status: 'loading', stale: true, value });
        applyMcpServerCatalogSnapshot(scope, ready, false);
        expect(getMcpServerCatalogSnapshot(scope).status).toBe('loading');
        applyMcpServerCatalogSnapshot(scope, { status: 'unavailable', reason: 'encryption-material-unavailable' }, true);
        expect(getMcpServerCatalogSnapshot(scope)).toMatchObject({ status: 'unavailable', value: null, stale: true });
    });
});
