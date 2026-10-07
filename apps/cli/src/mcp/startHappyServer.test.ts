import { describe, expect, it, vi } from 'vitest';

const daemonCatalogBoundary = vi.hoisted(() => ({ read: vi.fn() }));

// The daemon control transport is outside the Session process; MCP/HTTP owners
// and catalog admission below it remain real.
vi.mock('@/daemon/controlClient', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/daemon/controlClient')>(),
    readDaemonPluginCatalog: daemonCatalogBoundary.read,
}));

import { startHappyServer } from '@/mcp/startHappyServer';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';

describe('startHappyServer notification stream', () => {
    it('keeps notifications available during catalog loss while tool requests fail closed', async () => {
        daemonCatalogBoundary.read.mockReset();
        daemonCatalogBoundary.read.mockResolvedValueOnce({ kind: 'available', plugins: [], tools: [] });
        daemonCatalogBoundary.read.mockResolvedValue({ kind: 'unavailable', code: 'daemon_unavailable' });

        const client = createMutableApiSessionClientFixture({
            sessionId: 'notification-stream-session',
            overrides: {
                getServerBinding: () => ({ serverId: 'test-home', serverUrl: 'https://test-home.example.test' }),
            },
        });
        const server = await startHappyServer(client);
        const notificationStream = new AbortController();
        try {
            const response = await fetch(server.url, {
                headers: { Accept: 'text/event-stream' },
                signal: notificationStream.signal,
            });
            expect(response.status).toBe(200);
            expect(response.headers.get('content-type')).toContain('text/event-stream');
            notificationStream.abort();

            const toolResponse = await fetch(server.url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
            });
            expect(toolResponse.status).toBe(503);
            await expect(toolResponse.json()).resolves.toMatchObject({
                ok: false, errorCode: 'daemon_plugin_catalog_unavailable',
            });
        } finally {
            notificationStream.abort();
            server.stop();
        }
    });
});
