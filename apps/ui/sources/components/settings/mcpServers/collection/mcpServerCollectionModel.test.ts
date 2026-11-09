import { describe, expect, it } from 'vitest';
import type { McpServersSettingsV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';

import { buildMcpServerCollection } from './mcpServerCollectionModel';

function settings(): McpServersSettingsV1 {
    return { v: 1, strictMode: false,
        servers: Array.from({ length: 128 }, (_, index) => ({ id: `server-${index}`, name: `server-${index}`,
            title: `Server ${String(index).padStart(3, '0')}`, transport: 'stdio',
            stdio: { command: 'mcp-server', args: [] }, env: {}, createdAt: 1, updatedAt: 1 })),
        bindings: Array.from({ length: 128 }, (_, index) => ({ id: `rule-${index}`, serverId: `server-${index}`,
            target: { t: 'allMachines' }, enabled: true, createdAt: 1, updatedAt: 1 })),
    };
}

describe('MCP server collection projection', () => {
    it('replaces only the changed row and retains unaffected binding groups across 128 servers', () => {
        const first = settings();
        const before = buildMcpServerCollection(first, '');
        const changed: McpServersSettingsV1 = { ...first, servers: first.servers.map(server => server.id === 'server-63'
            ? { ...server, title: 'Changed server' } : server) };
        const next = buildMcpServerCollection(changed, '', before);
        const previousById = new Map(before.map(row => [row.server.id, row]));
        expect(next.filter(row => row !== previousById.get(row.server.id))).toHaveLength(1);
        expect(next.find(row => row.server.id === 'server-63')!.bindings).toBe(previousById.get('server-63')!.bindings);

        const bindingChange = { ...changed, bindings: changed.bindings.map(binding => binding.serverId === 'server-63'
            ? { ...binding, enabled: false } : binding) };
        const afterBinding = buildMcpServerCollection(bindingChange, '', next);
        const nextById = new Map(next.map(row => [row.server.id, row]));
        expect(afterBinding.filter(row => row !== nextById.get(row.server.id))).toHaveLength(1);
        expect(afterBinding.find(row => row.server.id === 'server-63')!.unbound).toBe(true);
        expect(buildMcpServerCollection(bindingChange, '', afterBinding)).toBe(afterBinding);
    });

    it('keeps server identity through reorder, search and removal, and never retains a removed binding', () => {
        const first = settings();
        const before = buildMcpServerCollection(first, '');
        const reordered = { ...first, servers: [...first.servers].reverse(), bindings: [...first.bindings].reverse() };
        expect(buildMcpServerCollection(reordered, '', before)).toBe(before);
        const filtered = buildMcpServerCollection(reordered, 'server 063', before);
        expect(filtered).toEqual([before[63]]);
        expect(filtered[0]).toBe(before[63]);
        const removed = buildMcpServerCollection({ ...first, servers: [first.servers[63]!], bindings: [] }, '', before);
        expect(removed).toHaveLength(1);
        expect(removed[0]!.bindings).toEqual([]);
        expect(removed[0]!.unbound).toBe(true);
    });
});
