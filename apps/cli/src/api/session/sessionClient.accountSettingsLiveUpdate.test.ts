import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createMockSession } from '@/testkit/backends/sessionFixtures';
import { encodeBase64, encrypt } from '../encryption';
import {
    bindApiSessionSocketPairMock,
    createApiSessionSocketStub,
} from '@/testkit/backends/apiSessionSocketHarness';

const { mockIo, readCredentialsMock, readStoredCredentialsMock } = vi.hoisted(() => ({
    mockIo: vi.fn(),
    readCredentialsMock: vi.fn(),
    readStoredCredentialsMock: vi.fn(),
}));

vi.mock('socket.io-client', () => ({ io: mockIo }));
vi.mock('@/api/connection/createLoopbackReadinessProbe', () => ({
    createLoopbackReadinessProbe: () => async () => ({ status: 'ready' as const }),
}));
vi.mock('@/persistence', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/persistence')>()),
    readCredentials: readCredentialsMock,
    readStoredCredentials: readStoredCredentialsMock,
}));

import { ApiSessionClient } from './sessionClient';

function deferred<T>() {
    let resolve: (value: T) => void = () => {};
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

function update(body: Record<string, unknown>, id: string) {
    return { id, seq: 1, createdAt: 1, body } as never;
}

describe('ApiSessionClient live account settings convergence', () => {
    const clients = new Set<ApiSessionClient>();
    let previousEnableV2Changes: string | undefined;

    beforeEach(() => {
        previousEnableV2Changes = process.env.HAPPY_ENABLE_V2_CHANGES;
        process.env.HAPPY_ENABLE_V2_CHANGES = 'false';
        mockIo.mockReset();
        readCredentialsMock.mockReset();
        readStoredCredentialsMock.mockReset();
        const credentials = {
            token: 'fake-token',
            encryption: { type: 'legacy', secret: new Uint8Array(32).fill(2) },
        };
        readCredentialsMock.mockResolvedValue(credentials);
        readStoredCredentialsMock.mockResolvedValue(credentials);
        resetActiveAccountSettingsSnapshotForTests();
    });

    it('applies a plain settings update with token-only credentials', async () => {
        readCredentialsMock.mockResolvedValue(null);
        readStoredCredentialsMock.mockResolvedValue({
            token: 'fake-token',
            encryption: null,
        });
        const { client, userSocket } = createClient();
        await vi.waitFor(() => expect((client as never as { currentConnectionState: { phase: string } }).currentConnectionState.phase).toBe('online'));
        vi.spyOn(axios, 'get').mockResolvedValue({
            status: 200,
            data: { id: 'account-1' },
        } as never);
        const wake = vi.spyOn(client, 'wakePendingMaterialization');

        userSocket.trigger('update', update({
            t: 'update-account',
            id: 'account-1',
            settingsV2: {
                content: { t: 'plain', v: { codexBackendMode: 'appServer' } },
                version: 1,
            },
        }, 'plain-account-settings'));

        await vi.waitFor(() => expect(wake).toHaveBeenCalledOnce());
        expect(readStoredCredentialsMock).toHaveBeenCalled();
        expect(readCredentialsMock).not.toHaveBeenCalled();
    });

    afterEach(async () => {
        await Promise.allSettled([...clients].map((client) => client.close()));
        clients.clear();
        vi.restoreAllMocks();
        if (previousEnableV2Changes === undefined) delete process.env.HAPPY_ENABLE_V2_CHANGES;
        else process.env.HAPPY_ENABLE_V2_CHANGES = previousEnableV2Changes;
    });

    function createClient() {
        const sessionSocket = createApiSessionSocketStub({ connected: true });
        const userSocket = createApiSessionSocketStub({ connected: true });
        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });
        const client = new ApiSessionClient('fake-token', createMockSession({
            pendingCount: 1,
            pendingVersion: 3,
            latestTurnStatus: 'in_progress',
        }));
        clients.add(client);
        return { client, sessionSocket, userSocket };
    }

    it('fails malformed direct settings hints closed while unrelated runtime updates still apply', async () => {
        const { client, userSocket } = createClient();
        await vi.waitFor(() => expect((client as never as { currentConnectionState: { phase: string } }).currentConnectionState.phase).toBe('online'));
        await vi.waitFor(() => expect((client as never as { sessionSyncPendingInputServerContractResult: unknown }).sessionSyncPendingInputServerContractResult).not.toBeNull());
        const getSpy = vi.spyOn(axios, 'get');

        userSocket.trigger('update', update({
            t: 'account-settings-changed',
            settingsVersion: -1,
        }, 'malformed-settings'));
        const session = createMockSession();
        userSocket.trigger('update', update({
            t: 'update-session',
            id: session.id,
            metadata: {
                version: 1,
                value: encodeBase64(encrypt(session.encryptionKey, session.encryptionVariant, {
                    ...session.metadata,
                    path: '/tmp/fresh-after-failed-settings',
                })),
            },
        }, 'unrelated-session'));

        expect(getSpy).not.toHaveBeenCalled();
        expect(client.getMetadataSnapshot()?.path).toBe('/tmp/fresh-after-failed-settings');

        expect((client as never as { accountSettingsSyncBarrier: unknown }).accountSettingsSyncBarrier).not.toBeNull();

        getSpy.mockResolvedValue({ status: 200, data: { id: 'account-1' } } as never);
        const wake = vi.spyOn(client, 'wakePendingMaterialization');
        userSocket.trigger('update', update({
            t: 'update-account',
            id: 'wrong-account',
            settingsV2: { content: { t: 'plain', v: {} }, version: 1 },
        }, 'wrong-account-settings'));
        await (client as never as { accountSettingsSyncBarrier: Promise<boolean> }).accountSettingsSyncBarrier;
        expect(wake).not.toHaveBeenCalled();

        userSocket.trigger('update', update({
            t: 'update-account',
            id: 'account-1',
            settingsV2: {
                content: { t: 'plain', v: { sessionPendingQueueDeliveryTiming: 'after_foreground_ready' } },
                version: 2,
            },
        }, 'valid-account-settings'));
        await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(1));
        expect((client as never as { accountSettingsSyncBarrier: unknown }).accountSettingsSyncBarrier).toBeNull();
    });

    it('only clears and wakes for the latest successful live settings event', async () => {
        const older = deferred<{ status: number; data: unknown }>();
        const newer = deferred<{ status: number; data: unknown }>();
        const responses = [older, newer];
        vi.spyOn(axios, 'get').mockImplementation(async (url) => {
            if (!String(url).endsWith('/v2/account/settings')) throw new Error(`Unexpected URL: ${String(url)}`);
            const response = responses.shift();
            if (!response) throw new Error('Unexpected settings request');
            return await response.promise as never;
        });
        const { client, userSocket } = createClient();
        await vi.waitFor(() => expect((client as never as { currentConnectionState: { phase: string } }).currentConnectionState.phase).toBe('online'));
        const wake = vi.spyOn(client, 'wakePendingMaterialization');

        userSocket.trigger('update', update({ t: 'account-settings-changed', settingsVersion: 3 }, 'older'));
        userSocket.trigger('update', update({ t: 'account-settings-changed', settingsVersion: 4 }, 'newer'));
        await vi.waitFor(() => expect(axios.get).toHaveBeenCalledTimes(2));

        newer.resolve({
            status: 200,
            data: {
                content: { t: 'plain', v: { sessionPendingQueueDeliveryTiming: 'after_foreground_ready' } },
                version: 4,
            },
        });
        await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(1));
        expect((client as never as { accountSettingsSyncBarrier: unknown }).accountSettingsSyncBarrier).toBeNull();

        older.resolve({
            status: 200,
            data: {
                content: { t: 'plain', v: { sessionPendingQueueDeliveryTiming: 'after_runtime_idle' } },
                version: 3,
            },
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(wake).toHaveBeenCalledTimes(1);
    });

    it('does not let an older malformed event invalidate a newer observed settings refresh', async () => {
        const response = deferred<{ status: number; data: unknown }>();
        vi.spyOn(axios, 'get').mockImplementation(async (url) => {
            if (String(url).endsWith('/v2/account/settings')) return await response.promise as never;
            throw new Error(`Unexpected URL: ${String(url)}`);
        });
        const { client, userSocket } = createClient();
        await vi.waitFor(() => expect((client as never as { currentConnectionState: { phase: string } }).currentConnectionState.phase).toBe('online'));
        const wake = vi.spyOn(client, 'wakePendingMaterialization');

        userSocket.trigger('update', update({ t: 'account-settings-changed', settingsVersion: 5 }, 'newer-v5'));
        await vi.waitFor(() => expect(axios.get).toHaveBeenCalledTimes(1));
        userSocket.trigger('update', update({
            t: 'update-account',
            id: 'account-1',
            settingsV2: { content: { t: 'invalid-envelope' }, version: 4 },
        }, 'older-malformed-v4'));
        response.resolve({
            status: 200,
            data: { content: { t: 'plain', v: {} }, version: 5 },
        });

        await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(1));
        expect((client as never as { accountSettingsSyncBarrier: unknown }).accountSettingsSyncBarrier).toBeNull();
    });

    it('rejects reconnect convergence from a disconnected originating session socket', async () => {
        const settingsResponse = deferred<{ status: number; data: unknown }>();
        vi.spyOn(axios, 'get').mockImplementation(async (url) => {
            if (String(url).endsWith('/v1/account/profile')) {
                return { status: 200, data: { id: 'account-1' } } as never;
            }
            if (String(url).endsWith('/v2/account/settings')) return await settingsResponse.promise as never;
            throw new Error(`Unexpected URL: ${String(url)}`);
        });
        const { client, sessionSocket } = createClient();
        await vi.waitFor(() => expect((client as never as { currentConnectionState: { phase: string } }).currentConnectionState.phase).toBe('online'));
        const wake = vi.spyOn(client, 'wakePendingMaterialization');
        const refresh = (client as never as {
            refreshAccountSettingsForMinimumVersion: (version: number | null) => Promise<void>;
        }).refreshAccountSettingsForMinimumVersion(5);
        await vi.waitFor(() => expect(axios.get).toHaveBeenCalledWith(expect.stringContaining('/v2/account/settings'), expect.anything()));

        sessionSocket.connected = false;
        settingsResponse.resolve({
            status: 200,
            data: { content: { t: 'plain', v: {} }, version: 5 },
        });

        await expect(refresh).rejects.toThrow(/stale|source/i);
        expect(wake).not.toHaveBeenCalled();
        expect((client as never as { accountSettingsSyncBarrier: unknown }).accountSettingsSyncBarrier).not.toBeNull();
    });
});
