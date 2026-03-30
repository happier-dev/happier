import { describe, expect, it } from 'vitest';

import type { McpServerBindingV1, McpServerCatalogEntryV1, McpServersSettingsV1 } from '@happier-dev/protocol';

import {
    addMcpServerBindingV1,
    addMcpServerCatalogEntryV1,
    deleteMcpServerCatalogEntryV1,
    upsertMcpServerWithBindingsV1,
} from './mcpServerCrud';

function baseSettings(): McpServersSettingsV1 {
    return { v: 1, strictMode: false, servers: [], bindings: [] };
}

function makeStdioServer(params: { id: string; name: string; now?: number }): McpServerCatalogEntryV1 {
    const now = params.now ?? 1_700_000_000_000;
    return {
        id: params.id,
        name: params.name,
        transport: 'stdio',
        stdio: { command: 'node', args: ['server.js'] },
        env: {},
        createdAt: now,
        updatedAt: now,
    };
}

function makeAllMachinesBinding(params: { id: string; serverId: string; now?: number }): McpServerBindingV1 {
    const now = params.now ?? 1_700_000_000_000;
    return {
        id: params.id,
        serverId: params.serverId,
        enabled: true,
        target: { t: 'allMachines' },
        createdAt: now,
        updatedAt: now,
    };
}

describe('mcpServerCrud', () => {
    it('adds servers to the catalog', () => {
        const settings = baseSettings();
        const server = makeStdioServer({ id: 's1', name: 'foo' });
        const next = addMcpServerCatalogEntryV1(settings, server);
        expect(next.servers.map((s) => s.id)).toEqual(['s1']);
    });

    it('rejects duplicate server names', () => {
        const settings = addMcpServerCatalogEntryV1(baseSettings(), makeStdioServer({ id: 's1', name: 'foo' }));
        expect(() => addMcpServerCatalogEntryV1(settings, makeStdioServer({ id: 's2', name: 'foo' }))).toThrow(/duplicate server name/i);
    });

    it('adds bindings and deletes bindings when the server is deleted', () => {
        const server = makeStdioServer({ id: 's1', name: 'foo' });
        const binding = makeAllMachinesBinding({ id: 'b1', serverId: 's1' });
        const settings = addMcpServerBindingV1(addMcpServerCatalogEntryV1(baseSettings(), server), binding);
        expect(settings.bindings.map((b) => b.id)).toEqual(['b1']);

        const deleted = deleteMcpServerCatalogEntryV1(settings, 's1');
        expect(deleted.servers).toEqual([]);
        expect(deleted.bindings).toEqual([]);
    });

    it('returns the original settings when deleting a missing server', () => {
        const settings = addMcpServerCatalogEntryV1(baseSettings(), makeStdioServer({ id: 's1', name: 'foo' }));

        expect(deleteMcpServerCatalogEntryV1(settings, 'missing')).toBe(settings);
    });

    it('rejects bindings for missing serverId', () => {
        const binding = makeAllMachinesBinding({ id: 'b1', serverId: 'missing' });
        expect(() => addMcpServerBindingV1(baseSettings(), binding)).toThrow(/server not found/i);
    });

    it('upserts a server and replaces its bindings', () => {
        const server = makeStdioServer({ id: 's1', name: 'foo', now: 10 });
        const binding1 = makeAllMachinesBinding({ id: 'b1', serverId: 's1', now: 10 });
        const initial = addMcpServerBindingV1(addMcpServerCatalogEntryV1(baseSettings(), server), binding1);

        const updatedServer: McpServerCatalogEntryV1 = { ...server, title: 'Foo', updatedAt: 20 };
        const binding2: McpServerBindingV1 = { ...binding1, id: 'b2', updatedAt: 20 };

        const next = upsertMcpServerWithBindingsV1(initial, updatedServer, [binding2]);
        expect(next.servers[0]?.title).toBe('Foo');
        expect(next.bindings.map((b) => b.id)).toEqual(['b2']);
    });

    it('rejects upserting a server name that collides with another server', () => {
        const s1 = makeStdioServer({ id: 's1', name: 'one' });
        const s2 = makeStdioServer({ id: 's2', name: 'two' });
        const initial = addMcpServerCatalogEntryV1(addMcpServerCatalogEntryV1(baseSettings(), s1), s2);
        expect(() => upsertMcpServerWithBindingsV1(initial, { ...s2, name: 'one' }, [])).toThrow(/duplicate server name/i);
    });
});
