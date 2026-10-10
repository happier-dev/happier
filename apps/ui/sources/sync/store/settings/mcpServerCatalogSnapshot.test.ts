import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyMcpServerCatalogSnapshot, beginMcpServerCatalogLoad, getMcpServerCatalogSnapshot,
    resetMcpServerCatalogSnapshotsForTests, subscribeMcpServerCatalogSnapshots } from './mcpServerCatalogSnapshot';
import type { McpServerCatalogSnapshotV1 } from '@happier-dev/protocol/mcp/servers/serverCatalogV1';

afterEach(resetMcpServerCatalogSnapshotsForTests);
const scope = { serverId: 'home', accountId: 'account' };
const ready: McpServerCatalogSnapshotV1 = { status: 'ready', authority: 'active', revision: 3, diagnostics: [],
    catalog: { v: 1, servers: [{ id: 'server', name: 'server', transport: 'stdio',
        stdio: { command: 'mcp-server', args: [] }, env: {}, createdAt: 1, updatedAt: 1 }], bindings: [] } };

describe('MCP scoped catalog publication', () => {
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
