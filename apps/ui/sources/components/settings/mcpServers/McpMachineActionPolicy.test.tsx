import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { MachineAccessGrantsListResponseV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { createMachineFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { upsertServerProfileOnly } from '@/sync/domains/server/serverRuntime';
import { setServerProfileIdentityForUrl } from '@/sync/domains/server/serverProfiles';
import { resolveFreshMachineAdministrationExecutionTarget, useMachineAdministrationTargetSelection } from '@/sync/domains/machines/administration/useTargetSelection';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { ItemList } from '@/components/ui/lists/ItemList';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';

vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
installApprovalCommonModuleMocks({ storage: original => original(), reactNavigation: async () =>
    (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock() });

const modal = await import('@/modal');
const { storage } = await import('@/sync/domains/state/storageStore');
const { McpServerTestPanel } = await import('./McpServerTestPanel');
const { McpDetectedServersScreen } = await import('./McpDetectedServersScreen');
const initialState = storage.getState();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
let disposeActionExecutorModuleLoader: (() => void) | undefined;
beforeEach(async () => { disposeActionExecutorModuleLoader = await installRealActionExecutorModuleLoader(); });

afterEach(async () => {
    await standardCleanup();
    await connection?.dispose();
    connection = null;
    resetRuntimeFetch();
    storage.setState(initialState, true);
    vi.restoreAllMocks();
    disposeActionExecutorModuleLoader?.();
    disposeActionExecutorModuleLoader = undefined;
});

describe('offered MCP Machine Actions through their selected Home', () => {
    it.each([
        { operation: 'test', disabled: true },
        { operation: 'probe', disabled: true },
        { operation: 'test', disabled: false },
    ] as const)('honors the selected Home $operation Action policy (disabled=$disabled)', async ({ operation, disabled }) => {
        const actionId = operation === 'test' ? 'mcp.servers.test' : 'mcp.servers.probe';
        const rpcMethod = operation === 'test' ? RPC_METHODS.DAEMON_MCP_SERVERS_TEST : RPC_METHODS.DAEMON_MCP_SERVERS_DETECT;
        const active = await upsertServerProfileOnly({ serverUrl: 'https://mcp-policy-focus.test', name: 'Focused Home' });
        await upsertServerProfileOnly({ serverUrl: 'https://mcp-policy-machine.test', name: 'Machine Home' });
        const target = await setServerProfileIdentityForUrl('https://mcp-policy-machine.test', 'srv_mcp-policy-machine');
        if (!target) throw new Error('Expected the canonical portable Home identity');
        const token = (id: string) => `e30.${Buffer.from(JSON.stringify({ sub: id })).toString('base64url')}.signature`;
        const activeCredentials = { token: token('focused-owner') };
        const targetCredentials = { token: token('machine-owner') };
        await TokenStorage.setCredentialsForServerUrl(active.serverUrl, { serverId: active.id }, activeCredentials);
        await TokenStorage.setCredentialsForServerUrl(target.serverUrl, { serverId: target.id }, targetCredentials);
        const machine = createMachineFixture({ id: 'policy-machine', active: true, activeAt: Date.now() });
        const targetSelection = { serverIdentityId: 'srv_mcp-policy-machine', machineId: machine.id };
        const rpcRequests: Array<Readonly<{ home: string | undefined; method: string }>> = [];
        installDisconnectedServerSocketBoundary((socket, home) => {
            // Socket.IO is the external network boundary. The real scoped RPC
            // owner and request-correlated codec remain beneath the panel.
            socket.connected = true;
            socket.emitWithAck = vi.fn(async (event: string, payload: unknown) => {
                if (event !== SOCKET_RPC_EVENTS.CALL) return { v: 1, ok: true, admittedSessionIds: [] };
                if (!payload || typeof payload !== 'object') throw new Error('Expected a wire RPC request');
                const method = Reflect.get(payload, 'method');
                if (typeof method !== 'string') throw new Error('Expected a wire RPC method');
                rpcRequests.push({ home, method });
                const content = { mode: 'plain' } as const;
                const request = await socketRpcCodec.decodeRequestParams(content, Reflect.get(payload, 'params'), method);
                return { ok: true, result: await socketRpcCodec.encodeResponse(content,
                    operation === 'test' ? { ok: true, toolCount: 1, durationMs: 1 }
                        : { ok: true, servers: [], warnings: [] }, request.callId) };
            });
        });
        const request: Parameters<typeof setRuntimeFetch>[0] = async (url, init) => {
            const parsed = new URL(String(url));
            const targetHome = parsed.origin === target.serverUrl;
            if (targetHome && (parsed.pathname.startsWith('/v1/account/') || parsed.pathname === '/v2/account/settings'
                || parsed.pathname.startsWith('/v1/machines/'))) {
                expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${targetCredentials.token}`);
            }
            if (parsed.pathname === '/health' || parsed.pathname === '/v1/auth/ping') return Response.json({});
            if (parsed.pathname === '/v1/features' || parsed.pathname === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
            if (parsed.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (parsed.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 1 }));
            if (parsed.pathname === '/v2/account/settings') return Response.json({ version: 1, content: { t: 'plain', v: {
                actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1, ...(targetHome && disabled
                    ? { actions: { [actionId]: { disabledSurfaces: ['ui'] } } }
                    : { approvalWaivedSurfaces: { [actionId]: ['ui'] } }) }),
            } } });
            if (parsed.pathname === `/v1/machines/${machine.id}`) return Response.json({ machine: {
                ...machine, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
            } });
            if (parsed.pathname === `/v1/machines/${machine.id}/access`) {
                const custodian = { accountId: 'machine-owner', displayName: 'Machine owner' };
                return Response.json(MachineAccessGrantsListResponseV1Schema.parse({ machineId: machine.id, custodian,
                    access: { custodian, role: 'manage', resourceMode: 'plain', accessState: 'ready' },
                    canManage: true, grants: [], ownDirectGrant: false, ownAccessSources: [] }));
            }
            if (parsed.pathname === '/v1/machines') return Response.json(targetHome
                ? [createPlainMachineRowFixture({ id: machine.id, accountId: 'machine-owner' })] : []);
            if (parsed.pathname === '/v1/account/entity-rows/mcp') return Response.json({ status: 'present', revision: 1,
                content: { t: 'plain', v: { v: 1, servers: [], bindings: [] } } });
            return Response.json({ error: 'not_found' }, { status: 404 });
        };
        setRuntimeFetch(request);
        await loadSyncSingletonForTests();
        connection = await restoreServerAccountForTest({ serverUrl: active.serverUrl, accountId: 'focused-owner',
            credentials: activeCredentials, request });
        // Both synthetic credentials were persisted before restore. Remove the
        // harness's one-Home shortcut so the foreign reader uses its actual key.
        vi.mocked(TokenStorage.getCredentialsForServerUrl).mockRestore();
        setRuntimeFetch(request);
        storage.getState().applyMachines([machine], true, { sourceServerId: target.id });
        expect(resolveFreshMachineAdministrationExecutionTarget(targetSelection)?.serverId).toBe(target.id);
        const selection = await renderHook(() => useMachineAdministrationTargetSelection(MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.mcpServers));
        await act(async () => { selection.getCurrent().selectTarget(targetSelection); });
        await vi.waitFor(() => expect(selection.getCurrent().selectedTarget).toEqual(targetSelection));
        await selection.unmount();
        const alert = vi.spyOn(modal.Modal, 'alert');
        const screen = await renderScreen(operation === 'probe' ? React.createElement(McpDetectedServersScreen)
            : React.createElement(ItemList, null, React.createElement(McpServerTestPanel, {
            server: { id: 'policy-server', name: 'policy_server', transport: 'stdio', stdio: { command: 'mcp-tool', args: [] },
                env: {}, createdAt: 1, updatedAt: 1 }, bindings: [], machines: [machine], targetSelection: {
                    selectedTarget: targetSelection,
                    resolveExecutionTarget: () => resolveFreshMachineAdministrationExecutionTarget(targetSelection),
                },
        })));
        const buttonId = operation === 'probe' ? 'settings.mcpServers.detect.refresh' : 'mcp.server.test.run';
        await vi.waitFor(() => expect(screen.findByTestId(buttonId).props.disabled).toBe(false));
        alert.mockClear();
        rpcRequests.length = 0;
        act(() => { screen.pressByTestId(buttonId); });
        await vi.waitFor(() => expect(alert.mock.calls.length + rpcRequests.filter(item => item.method.includes(rpcMethod)).length).toBeGreaterThan(0));
        if (disabled) {
            expect(rpcRequests.filter(item => item.method.includes(rpcMethod))).toEqual([]);
            expect(alert).toHaveBeenCalledWith('common.error', 'action_disabled');
        } else {
            expect(alert).not.toHaveBeenCalled();
            expect(rpcRequests.filter(item => item.method.includes(rpcMethod)).map(item => {
                if (!item.home) throw new Error('Expected the selected RPC Home');
                return { home: new URL(item.home).origin, method: item.method };
            })).toEqual([{ home: target.serverUrl, method: `${machine.id}:${rpcMethod}` }]);
            await vi.waitFor(() => expect(screen.findByTestId('mcp.server.test.result.ok')).not.toBeNull());
            // The actual Machine publication withdraws this exact target.
            // A stale button must not dispatch on the focused Home instead.
            await act(async () => { storage.getState().applyMachines([], true, { sourceServerId: target.id }); });
            expect(resolveFreshMachineAdministrationExecutionTarget(targetSelection)).toBeNull();
            act(() => { screen.pressByTestId(buttonId); });
            await act(async () => {});
            expect(rpcRequests.filter(item => item.method.includes(rpcMethod))).toHaveLength(1);
        }
    });
});
