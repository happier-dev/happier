import { afterAll, beforeEach, expect, it } from 'vitest';
import { SESSION_RPC_METHODS, RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { createPlainMachineRowFixture } from "@/dev/testkit/fixtures/machineFixtures";
import { createPlainSessionByIdResponseFixture, createSessionAccessFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';

const homes = createHomeGovernanceHarness();
const network = await installSessionOpsNetworkBoundary();
installHomeGovernanceBoundaries(homes);
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');

beforeEach(async () => {
    network.resetRequests();
    await homes.reset();
    installHomeGovernanceBoundaries(homes);
});
afterAll(async () => {
    await homes.reset();
    network.dispose();
});

it.each([
    { action: 'session.vendor_plugin_catalog.list', method: SESSION_RPC_METHODS.SESSION_VENDOR_PLUGIN_CATALOG_LIST, key: 'vendorPlugins' },
    { action: 'session.skill_catalog.list', method: SESSION_RPC_METHODS.SESSION_SKILL_CATALOG_LIST, key: 'skills' },
] as const)('reads $action through the Session owner and conceals a foreign Session', async ({ action, method, key }) => {
    const serverId = await homes.addHome({ name: 'Catalog Home', serverUrl: 'https://session-catalog.test',
        accountId: 'reader', currentAccount: true, accountEncryptionMode: 'plain' });
    const visible = 'visible-session';
    homes.answer(serverId, `GET /v2/sessions/${visible}`, {
        body: createPlainSessionByIdResponseFixture(createSessionFixture({
            id: visible, active: true, encryptionMode: 'plain', access: createSessionAccessFixture('owner'),
        })),
    });
    homes.answer(serverId, 'GET /v2/sessions/foreign-session', { status: 404, body: { error: 'Session not found' } });
    network.respond(method, { supported: true, [key]: [] });
    const executor = createDefaultActionExecutor();
    const execute = (sessionId: string) => executor.execute(action, { sessionId },
        { surface: 'ui', serverId, expectedAccountId: 'reader' });

    expect(await execute(visible)).toEqual({ ok: true, result: { supported: true, [key]: [] } });
    expect(await execute('foreign-session')).toEqual({ ok: true, result: {
        unsupported: true, [key]: [], diagnostic: 'session_not_found',
    } });
});

it('projects the Machine preview and preserves the Machine refusal', async () => {
    const serverId = await homes.addHome({ name: 'Preview Home', serverUrl: 'https://spawn-preview.test',
        accountId: 'reader', currentAccount: true, accountEncryptionMode: 'plain' });
    const machineId = 'preview-machine';
    homes.answer(serverId, `/v1/machines/${machineId}`, {
        body: { machine: createPlainMachineRowFixture({ id: machineId, accountId: 'reader' }) },
    });
    const preview = { ok: true, builtIn: [{ key: 'built-in:test', name: 'test', title: 'Test server',
        transport: 'stdio', authMode: 'none', selected: true, selectable: false, availability: 'active',
        sourceKind: 'builtIn', scopeKind: 'builtIn',
    }], managed: [], detected: [] };
    network.respond(RPC_METHODS.DAEMON_MCP_SERVERS_PREVIEW, preview);
    const executor = createDefaultActionExecutor();
    const execute = () => executor.execute('sessions.spawn.mcp_servers.preview', { machineId, agentId: 'codex', directory: '/workspace' },
        { surface: 'ui', serverId, expectedAccountId: 'reader' });
    expect(await execute()).toEqual({ ok: true, result: { ok: true, preview, items: [{
        value: 'built-in:test', label: 'Test server', selected: true, selectable: false,
        sourceKind: 'builtIn', authMode: 'none', availability: 'active',
    }] } });
    network.setRpcAckResponder(async () => ({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN, error: 'Access denied' }));
    expect(await execute()).toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
});
