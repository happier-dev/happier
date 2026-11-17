import '@/testkit/async/mockNodeTimers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { PromptLibraryCatalogKeyV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { emptyPromptLibraryRecordV1, readPromptLibraryCatalogRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import * as persistence from '@/persistence';
import type { Machine } from '@/api/types';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { clearActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshot, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { emptyAccountSettingsHistoryCaptureResponse } from '@/settings/accountSettings/emptyAccountSettingsHistoryCapture.testkit';
import { bindApiSessionSocketMock, createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { ApiMachineClient } from './apiMachine';
import { subscribePluginAccountAvailabilityChanges } from '@/plugins/runtime/context/pluginAccountSettingsChangeBroker';

const { mockIo, axiosGet } = vi.hoisted(() => ({ mockIo: vi.fn(), axiosGet: vi.fn() }));
// Network transports and on-disk credentials are system boundaries; catalog owners remain real.
vi.mock('socket.io-client', () => ({ io: mockIo }));
vi.mock('axios', () => ({ default: { get: axiosGet, post: vi.fn(), defaults: {}, isAxiosError: vi.fn(() => false) }, isAxiosError: vi.fn(() => false) }));
vi.mock('@/persistence', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/persistence')>(),
    readAccountChangesCursor: vi.fn(async () => 0),
}));

afterEach(() => vi.restoreAllMocks());

describe('ApiMachineClient Account changes fallbacks', () => {
    it('refreshes demanded current rows without walking retained Settings history on a live Settings hint', async () => {
        const previous = getActiveAccountSettingsSnapshot();
        const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'current-catalog-account' })).toString('base64url')}.signature`, encryption: null };
        vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
        clearActiveAccountSettingsSnapshot();
        setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 7,
            loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKeyForToken(credentials.token),
            promptLibraryCatalog: { status: 'loading' }, mcpServerCatalog: { status: 'loading' } });
        const machine: Machine = { id: 'current-catalog-machine', encryptionMode: 'plain', metadata: null,
            metadataVersion: 0, daemonState: null, daemonStateVersion: 0 };
        bindApiSessionSocketMock(mockIo, createApiSessionSocketStub());
        const requests: string[] = [];
        let pending = true;
        axiosGet.mockImplementation(async (url: string) => {
            const path = new URL(url).pathname;
            requests.push(path);
            if (path === '/v1/account/profile') return { status: 200, data: { id: 'current-catalog-account' } };
            if (path === '/v2/changes') return { status: 200, data: { changes: pending
                ? [{ cursor: 1, kind: 'account', entityId: 'self', changedAt: 1, hint: { settingsVersion: 8 } }] : [], nextCursor: 1 } };
            if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
                mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
            if (path === '/v1/account/entity-rows/prompt-library') return { status: 200, data: {
                status: 'listed', rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision: 2,
                    content: { t: 'plain', v: emptyPromptLibraryRecordV1(key) } })),
            } };
            if (path === '/v1/account/entity-rows/mcp') return { status: 200, data: { status: 'present', revision: 2,
                content: { t: 'plain', v: { v: 1, servers: [], bindings: [] } } } };
            if (path === '/v2/account/settings') return { status: 200, data: { version: 8, content: { t: 'plain', v: {} } } };
            if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
            const historyResponse = emptyAccountSettingsHistoryCaptureResponse(path);
            if (historyResponse) return historyResponse;
            throw new Error(`Unexpected current catalog request: ${path}`);
        });
        const client = new ApiMachineClient(credentials.token, machine);
        client.onConnectedServicesProjection(async () => {});
        try {
            const catchUp = () => (client as unknown as { syncChangesOnConnect(options: { reason: 'live' }): Promise<void> })
                .syncChangesOnConnect({ reason: 'live' });
            await catchUp();
            expect(getActiveAccountSettingsSnapshot()?.mcpServerCatalog).toMatchObject({ status: 'ready', authority: 'active', revision: 2 });
            expect(readPromptLibraryCatalogRecordV1({ catalog: getActiveAccountSettingsSnapshot()?.promptLibraryCatalog ?? { status: 'loading' }, key: 'coding' }))
                .toMatchObject({ status: 'ready', authority: 'active', revision: 2 });
            expect(requests.filter(path => path.startsWith('/v2/account/settings/history'))).toEqual([]);
            expect([...new Set(requests.filter(path => path.startsWith('/v1/account/entity-rows/')))].sort())
                .toEqual(['/v1/account/entity-rows/mcp', '/v1/account/entity-rows/prompt-library']);
            pending = false;
            requests.length = 0;
            await catchUp();
            expect(requests.filter(path => path.startsWith('/v1/account/entity-rows/'))).toEqual([]);
        } finally {
            await client.shutdown(); clearActiveAccountSettingsSnapshot();
            if (previous) setActiveAccountSettingsSnapshot(previous);
        }
    });

    it('reconciles reconnect recovery once per transport while the changes retry owner retries only the feed', async () => {
        const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'retry-account' })).toString('base64url')}.signature`, encryption: null };
        vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
        const previous = getActiveAccountSettingsSnapshot();
        clearActiveAccountSettingsSnapshot();
        setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 7,
            loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKeyForToken(credentials.token) });
        const machine: Machine = { id: 'retry-machine', encryptionMode: 'plain', metadata: null,
            metadataVersion: 0, daemonState: null, daemonStateVersion: 0 };
        bindApiSessionSocketMock(mockIo, createApiSessionSocketStub());
        const requests: string[] = [];
        let failingFeedReads = 2;
        axiosGet.mockImplementation(async (url: string) => {
            const path = new URL(url).pathname;
            requests.push(path);
            if (path === '/v1/account/profile') return { status: 200, data: { id: 'retry-account' } };
            if (path === '/v2/changes') {
                if (failingFeedReads > 0) { failingFeedReads -= 1; return { status: 500, data: { error: 'internal' } }; }
                return { status: 200, data: { changes: [], nextCursor: 0 } };
            }
            if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
                mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
            if (path === '/v2/account/settings') return { status: 200, data: { version: 7, content: { t: 'plain', v: {} } } };
            return { status: 404, data: {} };
        });
        let machineSnapshots = 0;
        // The authenticated ApiClient is the injected Machine snapshot boundary.
        const client = new ApiMachineClient(credentials.token, machine, undefined,
            { loadMachine: async () => { machineSnapshots += 1; return machine; } });
        await client.getMachineRoleRpcHandlerManager().invokeLocal(RPC_METHODS.CAPABILITIES_DESCRIBE, {});
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const reconciliations: string[] = [];
        const availability = vi.fn();
        const unsubscribeAvailability = subscribePluginAccountAvailabilityChanges(availability);
        client.onConnectedServicesProjection(async notification => { reconciliations.push(notification.source); });
        const internals = client as unknown as {
            startChangesSyncWithRetry(options: { reason: 'reconnect' }): void;
            connectedServicesProjectionRetry: { waitForIdle(): Promise<void>; hasPendingWork(): boolean };
            activeTransportGeneration: number;
        };
        const settle = async () => {
            // Advance the retry owner's real backoff boundary until it is idle.
            for (let step = 0; step < 20 && internals.connectedServicesProjectionRetry.hasPendingWork(); step += 1) {
                await vi.advanceTimersByTimeAsync(30_000);
            }
        };
        try {
            internals.startChangesSyncWithRetry({ reason: 'reconnect' });
            await settle();
            // Two failed feed reads and one success: the feed is retried, recovery is not.
            expect(requests.filter(path => path === '/v2/changes')).toHaveLength(3);
            expect(reconciliations).toEqual(['reconnect']);
            expect(machineSnapshots).toBe(1);
            expect(availability).toHaveBeenCalledExactlyOnceWith(resolveAccountSettingsScopeKeyForToken(credentials.token), []);

            // A new transport is the next natural boundary: its reconnect reconciles again,
            // including when it merges into retry work still pending for the old transport.
            failingFeedReads = 1;
            internals.startChangesSyncWithRetry({ reason: 'reconnect' });
            await vi.advanceTimersByTimeAsync(0);
            internals.activeTransportGeneration += 1;
            internals.startChangesSyncWithRetry({ reason: 'reconnect' });
            await settle();
            expect(reconciliations).toEqual(['reconnect', 'reconnect', 'reconnect']);
            expect(internals.connectedServicesProjectionRetry.hasPendingWork()).toBe(false);
        } finally {
            unsubscribeAvailability();
            await client.shutdown();
            vi.useRealTimers();
            clearActiveAccountSettingsSnapshot();
            if (previous) setActiveAccountSettingsSnapshot(previous);
        }
    });

    it.each(['disabled', 'not-found'] as const)('refreshes demanded prompt and MCP catalogs when changes is %s', async (fallback) => {
        const previous = getActiveAccountSettingsSnapshot();
        const previousFlag = process.env.HAPPY_ENABLE_V2_CHANGES;
        process.env.HAPPY_ENABLE_V2_CHANGES = fallback === 'disabled' ? 'false' : 'true';
        const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'fallback-account' })).toString('base64url')}.signature`, encryption: null };
        vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
        clearActiveAccountSettingsSnapshot();
        setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 7,
            loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKeyForToken(credentials.token),
            promptLibraryCatalog: { status: 'loading' }, mcpServerCatalog: { status: 'loading' } });
        const machine: Machine = { id: 'fallback-machine', encryptionMode: 'plain', metadata: null,
            metadataVersion: 0, daemonState: null, daemonStateVersion: 0 };
        bindApiSessionSocketMock(mockIo, createApiSessionSocketStub());
        axiosGet.mockImplementation(async (url: string) => {
            const path = new URL(url).pathname;
            if (path === '/v1/account/profile') return { status: 200, data: { id: 'fallback-account' } };
            if (path === '/v2/changes') return { status: 404, data: {} };
            if (path === `/v1/machines/${machine.id}`) return { status: 200, data: { machine } };
            if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
                mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
            if (path === '/v1/account/entity-rows/prompt-library') return { status: 200, data: {
                status: 'listed', rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision: 2,
                    content: { t: 'plain', v: emptyPromptLibraryRecordV1(key) } })),
            } };
            if (path === '/v1/account/entity-rows/mcp') return { status: 200, data: { status: 'present', revision: 2,
                content: { t: 'plain', v: { v: 1, servers: [], bindings: [] } } } };
            if (path === '/v2/account/settings') return { status: 200, data: { version: 7, content: { t: 'plain', v: {} } } };
            if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
            const historyResponse = emptyAccountSettingsHistoryCaptureResponse(path);
            if (historyResponse) return historyResponse;
            throw new Error(`Unexpected fallback catalog request: ${path}`);
        });
        const client = new ApiMachineClient(credentials.token, machine);
        client.onConnectedServicesProjection(async () => {});
        try {
            await (client as unknown as { syncChangesOnConnect(options: { reason: 'reconnect' }): Promise<void> })
                .syncChangesOnConnect({ reason: 'reconnect' });
            const snapshot = getActiveAccountSettingsSnapshot();
            expect(readPromptLibraryCatalogRecordV1({ catalog: snapshot?.promptLibraryCatalog ?? { status: 'loading' }, key: 'coding' }))
                .toMatchObject({ status: 'ready', authority: 'active', revision: 2 });
            expect(snapshot?.mcpServerCatalog).toMatchObject({ status: 'ready', authority: 'active', revision: 2 });
        } finally {
            await client.shutdown();
            clearActiveAccountSettingsSnapshot();
            if (previous) setActiveAccountSettingsSnapshot(previous);
            if (previousFlag === undefined) delete process.env.HAPPY_ENABLE_V2_CHANGES;
            else process.env.HAPPY_ENABLE_V2_CHANGES = previousFlag;
        }
    });
});
