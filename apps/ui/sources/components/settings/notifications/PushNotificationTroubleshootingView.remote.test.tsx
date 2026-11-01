import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createServerFetchWithReachabilityProbe, flushHookEffects } from '@/dev/testkit';
import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

const fixture = vi.hoisted(() => ({
    token: `header.${Buffer.from(JSON.stringify({ sub: 'account-a' })).toString('base64')}.signature`,
    scope: { serverId: '', accountId: 'account-a' },
    machinesByServerId: {} as Record<string, ReturnType<typeof createMachineFixture>[]>,
    alert: vi.fn(),
    emit: vi.fn(),
    io: vi.fn(),
}));

vi.mock('@/auth/context/AuthContext', () => {
    const credentials = { token: fixture.token };
    return { useAuth: () => ({ credentials }) };
});
// SecureStore and Socket.IO are external boundaries. The real fetch adapter,
// scoped credential check, encryption, RPC pool, result parsing and UI run below.
vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/auth/storage/tokenStorage')>(),
    TokenStorage: { getCredentialsForServerUrl: async () => ({ token: fixture.token }) },
}));
vi.mock('socket.io-client', () => ({ io: (...args: unknown[]) => fixture.io(...args) }));
vi.mock('expo-notifications', () => ({
    getPermissionsAsync: async () => ({ status: 'granted', granted: true, canAskAgain: false, expires: 'never' }),
    getExpoPushTokenAsync: async () => ({ type: 'expo', data: 'ExponentPushToken[phone]' }),
}));
vi.mock('@/components/ui/lists/Item', () => ({ Item: (props: Record<string, unknown> & { rightElement?: React.ReactNode }) => React.createElement('Item', props, props.rightElement) }));
vi.mock('@/components/ui/lists/ItemList', () => ({ ItemList: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('@/components/ui/lists/ItemGroup', () => ({ ItemGroup: ({ children }: { children: React.ReactNode }) => children }));

installSettingsViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({ Platform: { OS: 'ios' } });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSettings: () => ({}),
            useActiveServerAccountScope: () => fixture.scope,
            useMachineListByServerId: () => fixture.machinesByServerId,
        });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({ spies: { alert: fixture.alert } }).module;
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
});

describe('remote push troubleshooting through scoped HTTP and Socket.IO', () => {
    afterEach(async () => {
        const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
        await serverScopedRpcSocketPool.stopAll();
        serverScopedRpcSocketPool.resetForTests();
        vi.unstubAllGlobals();
        vi.clearAllMocks();
    });

    it.each(['accepted', 'malformed', 'unsupported'])('keeps captured Home/Account across a switch and reports %s honestly', async (response) => {
        const { upsertAndActivateServer, setActiveServer } = await import('@/sync/domains/server/serverRuntime');
        const homeA = upsertAndActivateServer({ serverUrl: 'https://push-home-a.test' });
        const homeB = upsertAndActivateServer({ serverUrl: 'https://push-home-b.test' });
        setActiveServer({ serverId: homeA.id });
        fixture.scope = { serverId: homeA.id, accountId: 'account-a' };
        fixture.machinesByServerId = {
            [homeA.id]: [createMachineFixture({ id: 'sender-a', activeAt: Date.now() })],
            [homeB.id]: [createMachineFixture({ id: 'sender-b', activeAt: Date.now() })],
        };
        fixture.emit.mockResolvedValue(response === 'unsupported'
            ? { ok: false, error: 'Unavailable', errorCode: 'RPC_METHOD_NOT_AVAILABLE' }
            : { ok: true, result: response === 'accepted' ? { status: 'accepted' } : undefined });
        fixture.io.mockImplementation(() => ({
            connected: true, connect: vi.fn(), disconnect: vi.fn(), on: vi.fn(), off: vi.fn(), emit: vi.fn(),
            emitWithAck: fixture.emit, timeout: () => ({ emitWithAck: fixture.emit }),
        }));
        let registryReads = 0;
        const requests: Array<{ url: string; authorization: string | null }> = [];
        vi.stubGlobal('fetch', vi.fn(createServerFetchWithReachabilityProbe(async (input, init) => {
            const url = String(input);
            const path = new URL(url).pathname;
            requests.push({ url, authorization: new Headers(init?.headers).get('Authorization') });
            if (url.includes('/v1/push-tokens')) {
                registryReads++;
                if (registryReads === 2) {
                    // The explicit action has already captured A. Change focus while its
                    // registry request is in flight, before transport setup starts.
                    setActiveServer({ serverId: homeB.id });
                    fixture.scope = { serverId: homeB.id, accountId: 'account-b' };
                }
                return new Response(JSON.stringify({ tokens: [{ id: 'phone-a', token: 'ExponentPushToken[phone]', createdAt: 1, updatedAt: 1 }] }));
            }
            if (path === '/v1/machines') return new Response(JSON.stringify([{ id: 'sender-a', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER }]));
            if (path === '/v1/account/encryption') return new Response(JSON.stringify({ mode: 'plain', updatedAt: 1 }));
            throw new Error(`Unexpected HTTP request: ${url}`);
        })));
        const { PushNotificationTroubleshootingView } = await import('./PushNotificationTroubleshootingView');
        const screen = await renderSettingsView(<PushNotificationTroubleshootingView />);
        try {
            await flushHookEffects({ cycles: 30 });
            const row = screen.findRow('settings-notifications-push-troubleshooting-test-remote');
            await act(async () => { await row!.props.onPress(); });
            await vi.waitFor(() => expect(fixture.alert).toHaveBeenLastCalledWith(expect.any(String), `settingsNotifications.pushTroubleshooting.remoteTest.${response === 'malformed' ? 'unconfirmed' : response}`), { timeout: 30_000 });
            expect(fixture.io).toHaveBeenCalledWith('https://push-home-a.test', expect.objectContaining({ auth: expect.objectContaining({ token: fixture.token }) }));
            expect(fixture.emit).toHaveBeenCalledTimes(1);
            expect(fixture.emit.mock.calls[0]?.[1]).toMatchObject({ method: 'sender-a:daemon.notifications.testPush', params: { tokenId: 'phone-a' } });
            expect(requests.every((request) => request.url.startsWith('https://push-home-a.test') && request.authorization === `Bearer ${fixture.token}`)).toBe(true);
        } finally {
            await screen.unmount();
        }
    });
});
