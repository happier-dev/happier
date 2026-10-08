import * as React from 'react';
import { AccountSettingsV2GetResponseSchema, AUTHORING_MEMORY_ROUTE_V1, AuthoringMemoryListResponseV1Schema, CurrentCursorResponseSchema, FeaturesResponseSchema, MACHINE_PLAIN_DATA_KEY_MARKER, V2SessionByIdResponseSchema, V2SessionByIdNotFoundSchema, V2SessionListResponseSchema } from '@happier-dev/protocol';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { AccountPetListResponseV1Schema } from '@happier-dev/protocol/pets/accountLibrary';
import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityIntentsListActionOutputV1Schema, PluginAvailabilityMaterializationsReadActionOutputV1Schema } from '@happier-dev/protocol/plugins/availability';
import { RpcError } from '@happier-dev/protocol/rpcErrors';
import { beforeEach, afterEach, afterAll, vi } from 'vitest';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createPlainSessionCurrentProjectionRecordFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { storage } from '@/sync/domains/state/storageStore';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import type { RuntimeFetch } from '@/utils/system/runtimeFetch';
import type { Socket } from 'socket.io-client';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';

installDisconnectedServerSocketBoundary();
vi.mock('@/sync/domains/state/browserRecordStorage', async () => (
    (await import('@/dev/testkit/mocks/browserRecordStorage')).createBrowserRecordStorageModuleMock()
));

/** A real scoped Session and pane reducer; only Home HTTP/Socket transport is replaced. */
export function installSessionPaneRuntimeTestHarness(params: Readonly<{
    sessionId?: string;
    sessionSeq?: number;
    scopeId?: string | ((scope: Readonly<{ sessionId: string; serverId: string }>) => string);
    features?: () => ReturnType<typeof createRootLayoutFeaturesResponse>;
    request?: (...args: Parameters<RuntimeFetch>) => Promise<Response | null>;
    configureSocket?: (socket: Socket, serverUrl?: string) => void;
    rpc?: (method: string, input: unknown, targetId: string, context: Readonly<{ serverUrl: string | undefined; targetId: string }>) => Promise<unknown>;
}> = {}) {
    const sessionId = params.sessionId ?? 's1';
    const serverIdentityId = 'srv_session_pane';
    let account: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
    let accountDisposed = true;
    let previous: ReturnType<typeof storage.getState>;
    let pane: AppPaneScopeApi;
    let AppPaneProvider: typeof import('@/components/appShell/panes/AppPaneProvider')['AppPaneProvider'];
    let InjectedAuthProvider: typeof import('@/auth/context/AuthContext')['InjectedAuthProvider'];
    let useAppPaneScope: typeof import('@/components/appShell/panes/hooks/useAppPaneScope')['useAppPaneScope'];
    let disposeActionModuleLoader: (() => void) | undefined;
    afterAll(() => disposeActionModuleLoader?.());
    beforeEach(async () => {
        installDisconnectedServerSocketBoundary((socket, serverUrl) => {
            if (params.rpc) {
                vi.mocked(socket.connect).mockImplementation(() => {
                    socket.connected = true;
                    for (const listener of socket.listeners('connect')) listener();
                    return socket;
                });
                vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event, payload: unknown) => {
                    if (event !== 'rpc-call') return { v: 1, ok: true, admittedSessionIds: [sessionId] };
                    if (!payload || typeof payload !== 'object' || !('method' in payload) || typeof payload.method !== 'string' || !('params' in payload)) {
                        throw new Error('Unexpected Socket RPC envelope');
                    }
                    const colon = payload.method.indexOf(':');
                    if (colon < 1) throw new Error('Socket RPC target unavailable');
                    const targetId = payload.method.slice(0, colon);
                    try {
                        return { ok: true, result: await params.rpc!(payload.method.slice(colon + 1), payload.params, targetId, { serverUrl, targetId }) };
                    } catch (error) {
                        // A daemon refusal is a relay ACK; actual transport failures remain rejections.
                        if (error instanceof RpcError) return { ok: false, error: error.message, errorCode: error.rpcErrorCode };
                        throw error;
                    }
                });
            }
            params.configureSocket?.(socket, serverUrl);
        });
        await loadSyncSingletonForTests();
        disposeActionModuleLoader ??= await installRealActionExecutorModuleLoader();
        ({ AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider'));
        ({ InjectedAuthProvider } = await import('@/auth/context/AuthContext'));
        ({ useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope'));
        const { resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
        resetServerFeaturesClientForTests();
        previous = storage.getState();
        await restoreRealm({ accountId: 'account_1' });
        storage.setState({ localSettings: { ...storage.getState().localSettings, appPaneScopesV1: {} } });
    });
    async function restoreRealm(realm: Readonly<{ serverUrl?: string; serverIdentityId?: string; accountId: string }>) {
        if (account && !accountDisposed) {
            const { scmStatusSync } = await import('@/scm/scmStatusSync');
            scmStatusSync.stop(sessionId, account.serverId);
            await account.dispose();
            accountDisposed = true;
        }
        const realmIdentityId = realm.serverIdentityId ?? serverIdentityId;
        const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => realm.accountId, encryptionMode: 'plain' });
        account = await restoreServerAccountForTest({
            serverUrl: realm.serverUrl ?? 'https://session-pane.test',
            serverIdentityId: realmIdentityId,
            accountId: realm.accountId,
            request: async (url, init) => {
                const path = new URL(String(url)).pathname;
                const json = (value: unknown) => Response.json(value);
                if (path === '/v1/features' || path === '/v1/features/authenticated') {
                    const features = params.features?.() ?? createRootLayoutFeaturesResponse();
                    return json(FeaturesResponseSchema.parse({ ...features, capabilities: {
                        ...features.capabilities, serverIdentity: { serverIdentityId: realmIdentityId },
                    } }));
                }
                if ((init?.method ?? 'GET') === 'GET' && path === '/v2/cursor') return json(CurrentCursorResponseSchema.parse({ cursor: 0, changesFloor: 0 }));
                if (path === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v1/account/encryption/currentness') return json(createPlainAccountEncryptionCurrentnessFixture());
                const response = await params.request?.(url, init);
                if (response) return response;
                const artifactResponse = artifacts.handle(String(url), init);
                if (artifactResponse) return artifactResponse;
                if ((init?.method ?? 'GET') === 'GET' && path === '/v1/account/profile') return json(AccountProfileSchema.parse({ id: realm.accountId }));
                if ((init?.method ?? 'GET') === 'GET' && path === '/v2/account/settings') return json(AccountSettingsV2GetResponseSchema.parse({ content: { t: 'plain', v: {} }, version: 0 }));
                if ((init?.method ?? 'GET') === 'GET' && path === '/v1/machines') return json([]);
                if ((init?.method ?? 'GET') === 'GET' && (path === '/v2/sessions' || path === '/v2/sessions/active')) return json(V2SessionListResponseSchema.parse({
                    sessions: [], nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
                }));
                if ((init?.method ?? 'GET') === 'GET' && path === '/v1/account/pets') return json(AccountPetListResponseV1Schema.parse({ ok: true, pets: [] }));
                if (init?.method === 'POST' && path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list']) return json(
                    PluginAvailabilityIntentsListActionOutputV1Schema.parse({ availabilityCursor: 0, pluginIds: [] }),
                );
                if (init?.method === 'POST' && path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read']) return json(
                    PluginAvailabilityMaterializationsReadActionOutputV1Schema.parse({ availabilityCursor: 0, snapshots: [] }),
                );
                if ((init?.method ?? 'GET') === 'GET' && path === AUTHORING_MEMORY_ROUTE_V1) return json(AuthoringMemoryListResponseV1Schema.parse({ rows: [] }));
                if ((init?.method ?? 'GET') === 'GET' && path === `/v2/sessions/${sessionId}`) {
                    const session = storage.getState().sessions[sessionId];
                    if (!session || !areServerProfileIdentifiersEquivalent(session.serverId, account?.serverId)) return Response.json(
                        V2SessionByIdNotFoundSchema.parse({ error: 'Session not found' }), { status: 404 },
                    );
                    return json(V2SessionByIdResponseSchema.parse({ session: {
                        ...createPlainSessionCurrentProjectionRecordFixture({
                            id: session.id, seq: session.seq, createdAt: session.createdAt, updatedAt: session.updatedAt,
                            active: session.active, activeAt: session.activeAt, metadata: session.metadata,
                            metadataVersion: session.metadataVersion, agentStateVersion: session.agentStateVersion,
                        }),
                        pendingVersion: session.pendingVersion, pendingCount: session.pendingCount,
                    } }));
                }
                if ((init?.method ?? 'GET') === 'GET' && path.startsWith('/v1/machines/')) {
                    const machineId = decodeURIComponent(path.slice('/v1/machines/'.length));
                    const machine = storage.getState().machines[machineId];
                    if (!machine) return new Response('{}', { status: 404 });
                    return json({ machine: { id: machineId, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER } });
                }
                if ((init?.method ?? 'GET') === 'GET' && path === `/v2/sessions/${sessionId}/pending`) return json({ pending: [] });
                if ((init?.method ?? 'GET') === 'GET' && path === `/v1/sessions/${sessionId}/messages`) return json({ messages: [], hasMore: false, nextBeforeSeq: null });
                return new Response('{}', { status: 404 });
            },
        });
        accountDisposed = false;
        const accountScope = getActiveServerAccountScope();
        if (!accountScope || accountScope.accountId !== realm.accountId
            || !areServerProfileIdentifiersEquivalent(accountScope.serverId, account.serverId)) throw new Error('Test pane Account scope unavailable');
        await waitForHomeGovernance(() => {
            const state = storage.getState();
            if (!areAccountSettingsScopesEqual(state.settingsScope, accountScope)
                || typeof state.settingsVersion !== 'number') {
                throw new Error('Test pane Account Settings have not hydrated');
            }
        });
        await waitForHomeGovernance(() => {
            if (!areServerAccountScopesEqual(getActiveServerAccountScope(), accountScope)
                || !storage.getState().isDataReady) {
                throw new Error('Test pane Account core bootstrap has not settled');
            }
        });
        // Core bootstrap includes draft refresh and outbox rearm. Case-owned
        // Session/Machine publications must not race that still-live producer.
        storage.getState().applySessions([createSessionFixture({ id: sessionId, serverId: account.serverId, seq: params.sessionSeq ?? 1, metadataVersion: 0 })]);
        const { ensureSessionDraftRepositoryHydrated } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
        await ensureSessionDraftRepositoryHydrated(accountScope);
        if (params.rpc) {
            // Account restore starts the real endpoint supervisor asynchronously. An RPC
            // fixture promises the connected Socket, not merely a restored credential.
            const { apiSocket } = await import('@/sync/api/session/apiSocket');
            let connected = false;
            const unsubscribe = apiSocket.onStatusChange(status => { connected = status === 'connected'; });
            try {
                await waitForHomeGovernance(() => {
                    if (!connected) throw new Error('Test pane RPC Socket has not connected');
                });
            } finally {
                unsubscribe();
            }
        }
    }
    afterEach(async () => {
        await standardCleanup();
        const { scmStatusSync } = await import('@/scm/scmStatusSync');
        scmStatusSync.stop(sessionId, account?.serverId);
        await account?.dispose();
        accountDisposed = true;
        storage.setState(previous, true);
    });
    function Probe() {
        const scopeId = typeof params.scopeId === 'function'
            ? params.scopeId({ sessionId, serverId: account.serverId })
            : params.scopeId ?? `session:${sessionId}`;
        pane = useAppPaneScope(scopeId);
        return null;
    }
    function Wrapper({ children }: React.PropsWithChildren) {
        return <InjectedAuthProvider credentials={account.credentials}><AppPaneProvider>
            <Probe />{children}
        </AppPaneProvider></InjectedAuthProvider>;
    }
    return {
        Wrapper,
        restoreRealm,
        get pane() { return pane; },
        get credentials() { return account.credentials; },
        get accountScope() {
            return getActiveServerAccountScope();
        },
        get serverId() { return account.serverId; },
        get serverIdentityId() {
            const identity = account.home.serverIdentityId;
            if (!identity) throw new Error('Test Home has no advertised server identity');
            return identity;
        },
    };
}
