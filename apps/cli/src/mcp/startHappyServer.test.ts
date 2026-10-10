import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { accountSettingsParse, ActionsSettingsV1Schema, FeaturesResponseSchema } from '@happier-dev/protocol';
import type { ProjectedPluginToolCatalogEntry } from '@/plugins/runtime/toolCatalog';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';

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
    it('refreshes the admitted inventory on policy, feature and contributor occurrence changes', async () => {
        let settings = accountSettingsParse({});
        let features: CliServerFeaturesSnapshot = { status: 'ready', features: FeaturesResponseSchema.parse({
            features: { sessions: { enabled: true, board: { enabled: true } } }, capabilities: {},
        }) };
        let tools: readonly ProjectedPluginToolCatalogEntry[] = [];
        daemonCatalogBoundary.read.mockReset();
        daemonCatalogBoundary.read.mockImplementation(async () => ({ kind: 'available', plugins: [], tools: structuredClone(tools) }));
        const session = createMutableApiSessionClientFixture({
            sessionId: 'inventory-refresh-session', overrides: {
                getServerBinding: () => ({ serverId: 'test-home', serverUrl: 'https://test-home.example.test' }),
                getServerFeaturesSnapshot: () => features,
            },
        });
        const server = await startHappyServer(session, {
            sessionCredentials: { token: 'offline-fixture', encryption: null },
            getAccountSettings: () => settings,
            requiredDirectActionIds: ['session.board.get'],
        });
        const client = new Client({ name: 'inventory-refresh-test', version: '1.0.0' });
        try {
            await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
            const names = async () => (await client.listTools()).tools.map(tool => tool.name);
            expect(await names()).toContain('change_title');
            expect(await names()).toContain('session_board_get');
            vi.stubEnv('HAPPIER_BUILD_FEATURES_DENY', 'sessions.board');
            expect(await names()).not.toContain('session_board_get');
            vi.unstubAllEnvs();
            expect(await names()).toContain('session_board_get');
            // Supply the reader's effective policy rather than exercise a
            // persisted Settings migration in this inventory regression.
            settings = { ...settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({
                v: 1, actions: { 'session.title.set': { enabled: false } },
            }) };
            expect(await names()).not.toContain('change_title');
            features = { status: 'ready', features: FeaturesResponseSchema.parse({ features: {}, capabilities: {} }) };
            expect(await names()).not.toContain('session_board_get');
            settings = accountSettingsParse({});
            expect(await names()).toContain('change_title');
            tools = [{ toolId: 'acme.plugin/read', actionId: 'acme.plugin/read-action', name: 'plugin_read',
                title: 'Plugin read', description: 'Read', inputSchema: { type: 'object', properties: {} },
                surfaces: ['agent'], expectedContributorOccurrenceId: 'occurrence-one' }];
            expect(await names()).toContain('plugin_read');
            tools = tools.map(tool => ({ ...tool, name: 'replacement_read', expectedContributorOccurrenceId: 'occurrence-two' }));
            expect(await names()).not.toContain('plugin_read');
            expect(await names()).toContain('replacement_read');
            tools = [];
            expect(await names()).not.toContain('replacement_read');
        } finally {
            vi.unstubAllEnvs();
            await client.close();
            server.stop();
        }
    });
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
