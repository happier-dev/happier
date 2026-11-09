import { createTestApiSessionClient } from '@/testkit/backends/createTestApiSessionClient';
import { createAccountSessionClientTransport } from '@/api/client/createAccountSessionClientTransport';
import { createSessionSocketTransport } from '@/api/session/connection/createSessionSocketTransport';
import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot, commitActiveAccountSettingsSnapshot,
    clearActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshot, readAccountRoleOverridesFromSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { readAutonomousExchangeAdmissionV1 } from '@happier-dev/protocol/sessions/messages/autonomousExchangeV1';
import { SESSION_FOLLOW_OBSERVE_PENDING_EVENT_V1, SessionFollowObservePendingRequestV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import type { ApiSessionClientOptions } from './sessionClient';
import { buildPromptLibraryPhysicalKeyV1, PromptLibraryCatalogKeyV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
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
        // Socket fixtures have an admitted Machine binding. Feature discovery
        // is an HTTP boundary too; don't race online against an absent contract.
        vi.stubGlobal('fetch', vi.fn(async () => Response.json({ features: {},
            capabilities: { session: { pendingInput: { protocolVersion: 1 } } } })));
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

    it('classifies a live Account hint through the changes owner before demanding unrelated catalogs', async () => {
        const credentials = { token: 'fake-token', encryption: null } as const;
        readStoredCredentialsMock.mockResolvedValue(credentials);
        setActiveAccountSettingsSnapshot({ source: 'network', rawSettings: {}, settings: accountSettingsParse({}),
            settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials),
            promptLibraryCatalog: { status: 'ready', rows: [], tombstones: [], diagnostics: [] } });
        const firstChangeRead = deferred<void>();
        let changeReads = 0;
        let catalogChanged = false;
        const get = vi.spyOn(axios, 'get').mockImplementation(async url => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/account/profile') return { status: 200, data: { id: 'account-1' } };
            if (path === '/v2/changes') {
                changeReads++;
                if (changeReads === 1) await firstChangeRead.promise;
                return { status: 200, data: { nextCursor: catalogChanged ? 5 : 4, changes: [
                    catalogChanged
                        ? { cursor: 5, kind: 'account', entityId: buildPromptLibraryPhysicalKeyV1('role-overrides'), changedAt: 2 }
                        : { cursor: 4, kind: 'session', entityId: 'another-session', changedAt: 1 },
                ] } };
            }
            if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
                mode: 'plain', version: 1, settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
            if (path === '/v1/account/entity-rows/prompt-library') return { status: 200, data: {
                status: 'listed', rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision: 2, content: { t: 'plain',
                    v: key === 'role-overrides' ? { key, value: { v: 1, overrides: { builder: { roleId: 'builder', workspaceWrites: 'deny' } } } }
                        : emptyPromptLibraryRecordV1(key) } })),
            } };
            if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
            if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
            if (path === '/v1/account/entity-rows/profiles/transfer') return { status: 200, data: { status: 'absent' } };
            return { status: 404, data: {} };
        });
        // Online precedes the initial connection's recovery work. Start this
        // live-hint cost measurement after that independently owned read ends.
        const connected = deferred<void>();
        const { client, userSocket } = createClient({ onSessionFollowInvalidated: () => connected.resolve() });
        await vi.waitFor(() => expect((client as never as { currentConnectionState: { phase: string } }).currentConnectionState.phase).toBe('online'));
        await connected.promise;
        process.env.HAPPY_ENABLE_V2_CHANGES = 'true';
        userSocket.trigger('update', update({ t: 'account-change' }, 'unrelated-account-hint'));
        await vi.waitFor(() => expect(get.mock.calls.filter(([url]) => new URL(String(url)).pathname === '/v2/changes')).toHaveLength(1));
        userSocket.trigger('update', update({ t: 'account-change' }, 'overlapping-hint-1'));
        userSocket.trigger('update', update({ t: 'account-change' }, 'overlapping-hint-2'));
        firstChangeRead.resolve();
        await vi.waitFor(() => expect(changeReads).toBe(2));
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(changeReads).toBe(2);
        expect(get.mock.calls.map(([url]) => new URL(String(url)).pathname)
            .filter(path => path.includes('/entity-rows/') || path.includes('/settings/history') || path.includes('/encryption/currentness'))).toEqual([]);
        catalogChanged = true;
        userSocket.trigger('update', update({ t: 'account-change' }, 'role-catalog-hint'));
        await vi.waitFor(() => {
            const snapshot = getActiveAccountSettingsSnapshot();
            expect(snapshot && readAccountRoleOverridesFromSnapshot(snapshot))
                .toMatchObject({ status: 'ready', overrides: { builder: { workspaceWrites: 'deny' } } });
        });
    });

    afterEach(async () => {
        await Promise.allSettled([...clients].map((client) => client.close()));
        clients.clear();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        if (previousEnableV2Changes === undefined) delete process.env.HAPPY_ENABLE_V2_CHANGES;
        else process.env.HAPPY_ENABLE_V2_CHANGES = previousEnableV2Changes;
    });

    function createClient(options: Partial<ApiSessionClientOptions> = {}) {
        const sessionSocket = createApiSessionSocketStub({ connected: true });
        const userSocket = createApiSessionSocketStub({ connected: true });
        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket,
            fallbackSocket: createApiSessionSocketStub({ connected: true }) });
        const accountTransport = createAccountSessionClientTransport('fake-token');
        const client = createTestApiSessionClient(ApiSessionClient, 'fake-token', createMockSession({
            pendingCount: 1,
            pendingVersion: 3,
            latestTurnStatus: 'in_progress',
        }), { localMachineId: 'machine', transport: { ...accountTransport,
            createSessionSocketTransport: binding => createSessionSocketTransport({ ...binding,
                token: 'fake-token', serverUrl: accountTransport.serverUrl, accessKeyBinding: 'preestablished' }),
        }, ...options });
        clients.add(client);
        return { client, sessionSocket, userSocket };
    }

    it('reads the originating Discussion check-in choice under current Account authority', async () => {
        const credentials = { token: 'fake-token', encryption: null } as const;
        readStoredCredentialsMock.mockResolvedValue(credentials);
        let override: Readonly<{ afterTurns: number | null }> | undefined | null;
        const readDiscussionAutonomousCheckIn = vi.fn(async () => override);
        const { client } = createClient({ readDiscussionAutonomousCheckIn,
            getServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({
                features: { sessions: { enabled: true, autonomousExchange: { enabled: true } } }, capabilities: {},
            }) }) });
        setActiveAccountSettingsSnapshot({ source: 'network', rawSettings: {}, settings: accountSettingsParse({}),
            settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
        const reader = client as unknown as { readCurrentAutonomousCheckIn(origin?: { serverId: string; discussionId: string }): Promise<unknown> };
        const origin = { serverId: client.getServerBinding().serverId, discussionId: 'discussion' };
        for (const afterTurns of [null, 12, undefined]) {
            override = afterTurns === undefined ? undefined : { afterTurns };
            expect(await reader.readCurrentAutonomousCheckIn(origin)).toEqual({ afterTurns: afterTurns === undefined ? 5 : afterTurns });
            expect(readDiscussionAutonomousCheckIn).toHaveBeenCalledWith(origin);
            readDiscussionAutonomousCheckIn.mockClear();
        }
        expect(await reader.readCurrentAutonomousCheckIn()).toEqual({ afterTurns: 5 });
        expect(readDiscussionAutonomousCheckIn).not.toHaveBeenCalled();
        override = null;
        expect(await reader.readCurrentAutonomousCheckIn(origin)).toBeNull();
    });

    it.each(['network', 'cache'] as const)('admits a Discussion-origin Follow wake from %s settings despite an unrelated publication and holds unreadable origin policy', async source => {
        const credentials = { token: 'fake-token', encryption: null } as const;
        readStoredCredentialsMock.mockResolvedValue(credentials);
        let override: { afterTurns: number | null } | null | undefined = { afterTurns: null };
        const features = () => ({ status: 'ready' as const, features: FeaturesResponseSchema.parse({
            features: { sessions: { enabled: true, autonomousExchange: { enabled: true }, conversations: { enabled: true } },
                sharing: { enabled: true, session: { enabled: true } } }, capabilities: {},
        }) });
        let publishedUnrelatedPreference = false;
        let retireAccountDuringRead = false;
        let changeCheckInDuringRead = false;
        const requestDiscussion = vi.spyOn(axios, 'request').mockImplementation(async () => {
            if (retireAccountDuringRead) {
                const snapshot = getActiveAccountSettingsSnapshot()!;
                clearActiveAccountSettingsSnapshot();
                commitActiveAccountSettingsSnapshot({ ...snapshot, settingsVersion: snapshot.settingsVersion + 1 });
            }
            if (!publishedUnrelatedPreference) {
                publishedUnrelatedPreference = true;
                const snapshot = getActiveAccountSettingsSnapshot()!;
                const rawSettings = { ...snapshot.rawSettings, codexBackendMode: 'appServer' };
                commitActiveAccountSettingsSnapshot({ ...snapshot, rawSettings,
                    settings: accountSettingsParse(rawSettings), settingsVersion: snapshot.settingsVersion + 1 });
            }
            if (changeCheckInDuringRead) {
                changeCheckInDuringRead = false;
                const snapshot = getActiveAccountSettingsSnapshot()!;
                const rawSettings = { ...snapshot.rawSettings, coordinationAutonomousCheckIn: { afterTurns: null } };
                commitActiveAccountSettingsSnapshot({ ...snapshot, rawSettings,
                    settings: accountSettingsParse(rawSettings), settingsVersion: snapshot.settingsVersion + 1 });
            }
            return override === null
                ? { status: 503, data: {} }
                : { status: 200, data: { discussionId: 'originating-discussion',
                    settings: override === undefined ? {} : { coordination: { autonomousCheckIn: override } } } };
        });
        const { createDiscussionAutonomousCheckInReader } = await import('@/discussions/discussionActionDeps');
        const { configuration } = await import('@/configuration');
        const readDiscussionAutonomousCheckIn = createDiscussionAutonomousCheckInReader({ credentials,
            serverId: configuration.activeServerId, serverHttpBaseUrl: 'http://discussion-wake.test',
            resolveServerFeaturesSnapshot: features });
        const { client, sessionSocket } = createClient({ readDiscussionAutonomousCheckIn, getServerFeaturesSnapshot: features });
        setActiveAccountSettingsSnapshot({ source, rawSettings: {}, settings: accountSettingsParse({}),
            settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
        // The receiver may start from disk before its first network read. The
        // real publication owner must admit confirmation of that same revision.
        commitActiveAccountSettingsSnapshot({ ...getActiveAccountSettingsSnapshot()!, source: 'network', loadedAtMs: 2 });
        const settingsReads = vi.spyOn(axios, 'get');
        const origin = { serverId: client.getServerBinding().serverId, discussionId: 'originating-discussion' };
        let reportedOrigin: typeof origin | undefined = origin;
        // Home is the network boundary; keep the actual check-in reducer and
        // strict request parser under the real Session client's wake entry point.
        sessionSocket.emitWithAck.mockImplementation(async (event: string, payload: unknown) => {
            if (event !== SESSION_FOLLOW_OBSERVE_PENDING_EVENT_V1) throw new Error(`Unexpected event ${event}`);
            const request = SessionFollowObservePendingRequestV1Schema.parse(payload);
            const decision = request.wakeAdmission?.autonomousCheckIn
                ? readAutonomousExchangeAdmissionV1({ v: 1, observedStarts: 5, pauseAtStarts: null,
                    stopped: false, afterTurns: request.wakeAdmission.autonomousCheckIn.afterTurns }) : 'check_in';
            return { ok: true, v: 1, sessionId: request.sessionId, publisherGeneration: '1',
                currentSourceSessionIds: ['source'], observations: [], wakeAdmission: {
                    status: decision === 'allow' ? 'allowed' : 'held',
                    ...(decision === 'allow' ? {} : { code: 'autonomous_check_in' }),
                    ...(reportedOrigin ? { originatingDiscussion: reportedOrigin } : {}),
                } };
        });
        const frontier = { transcriptSeq: 0, readyEventSeq: 0, agentStateVersion: 0, turn: null };
        const options = { wakeAdmission: { eventLocalId: 'session-follow-wake:origin', observations: [{
            sourceSessionId: 'source', relation: 'follower' as const, policy: { preset: 'everything' as const },
            expected: frontier, consumed: { ...frontier, transcriptSeq: 1 },
        }] } };
        expect(await client.observePendingSessionFollow(options)).toMatchObject({ wakeAdmission: { status: 'allowed' } });
        expect(requestDiscussion).toHaveBeenCalledWith(expect.objectContaining({
            url: 'http://discussion-wake.test/v1/discussions/originating-discussion/settings',
        }));
        override = { afterTurns: 5 };
        expect(await client.observePendingSessionFollow(options)).toMatchObject({
            wakeAdmission: { status: 'held', code: 'autonomous_check_in' },
        });
        override = null;
        expect(await client.observePendingSessionFollow(options)).toMatchObject({
            wakeAdmission: { status: 'held', code: 'session_input_target_unavailable' },
        });
        // One canonical admitted snapshot supplies every wake. Reading check-in
        // must not reopen Account preferences per delivery or inventory its Sessions.
        expect(settingsReads.mock.calls.filter(([url]) => new URL(String(url)).pathname === '/v2/account/settings')).toHaveLength(0);
        reportedOrigin = undefined;
        override = { afterTurns: null };
        expect(await client.observePendingSessionFollow(options)).toMatchObject({
            wakeAdmission: { status: 'held', code: 'session_input_target_unavailable' },
        });
        reportedOrigin = origin;
        override = undefined;
        changeCheckInDuringRead = true;
        expect(await client.observePendingSessionFollow(options)).toMatchObject({
            wakeAdmission: { status: 'held', code: 'session_input_target_unavailable' },
        });
        override = { afterTurns: null };
        retireAccountDuringRead = true;
        expect(await client.observePendingSessionFollow(options)).toMatchObject({
            wakeAdmission: { status: 'held', code: 'session_input_target_unavailable' },
        });
    });

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
        await vi.waitFor(() => expect(vi.mocked(axios.get).mock.calls
            .filter(([url]) => String(url).endsWith('/v2/account/settings'))).toHaveLength(2));

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
