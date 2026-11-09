import { replacePersistentUiStateForTest } from '@/dev/testkit/harness/persistentUiState';
import 'fake-indexeddb/auto';
import * as React from 'react';
import { AccountSettingsV2GetResponseSchema} from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { AUTHORING_MEMORY_ROUTE_V1, AuthoringMemoryListResponseV1Schema} from '@happier-dev/protocol/account/authoringMemory';
import { CurrentCursorResponseSchema} from '@happier-dev/protocol/changes';
import { FeaturesResponseSchema} from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { V2SessionByIdNotFoundSchema } from '@happier-dev/protocol/sessions/control/contract';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { buildSessionTurnsProjectionV1 } from '@happier-dev/protocol/sessions/turns/sessionTurnV1';
import { RpcError } from '@happier-dev/protocol/rpcErrors';
import { beforeEach, afterEach, vi } from 'vitest';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createPlainSessionByIdResponseFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { storage } from '@/sync/domains/state/storageStore';
import { paneUiState } from '@/sync/domains/state/filePaneUiState';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import type { RuntimeFetch } from '@/utils/system/runtimeFetch';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { Socket } from 'socket.io-client';
import { createAuthoringMemoryHttpBoundary } from '@/dev/testkit/mocks/authoringMemoryHttp';
import { createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { resolveServerScopedMachines } from '@/sync/domains/machines/resolveServerScopedMachines';
import { captureActiveServerAccountScopeLifetime, getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { SessionViewerSourceAccountScopeProvider } from '@/components/sessions/viewer/SessionViewerSourceAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createCompactSessionListRowFixture, createSessionReadBatchHttpBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { V2SessionListResponseSchema } from '@happier-dev/protocol/sessions/control/contract';
import {
    SESSION_HUMAN_PRESENCE_VISIBLE_REPLACE_EVENT,
    SessionHumanPresenceVisibleReplaceV1Schema,
    SessionHumanPresenceVisibleReplaceResultV1Schema,
} from '@happier-dev/protocol/sessions';

// This harness statically imports runtime owners through storage and Home governance.
// Install the external transport before those imports, then configure it below.
vi.mock('socket.io-client', async (importOriginal) => (
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal)
));
installDisconnectedServerSocketBoundary();
// The connected Account lifecycle must use the real store beneath transport fixtures.
vi.doUnmock('@/sync/domains/state/storage');
vi.mock('@/sync/domains/state/browserRecordStorage', async () => (
    (await import('@/dev/testkit/mocks/browserRecordStorage')).createBrowserRecordStorageModuleMock()
));

/** Call after installing case-owned boundaries; cold graph preparation can run during collection. */
export async function prepareSessionPaneRuntimeForTests() {
    const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
    await prepareSessionDraftPersistenceStorage();
    await loadSyncSingletonForTests();
    const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
    const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
    const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');
    const { resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
    return { AppPaneProvider, InjectedAuthProvider, useAppPaneScope, resetServerFeaturesClientForTests };
}

/** A real scoped Session and pane reducer; only Home HTTP/Socket transport is replaced. */
export function installSessionPaneRuntimeTestHarness(params: Readonly<{
    sessionId?: string;
    sessionSeq?: number;
    scopeId?: string | ((scope: Readonly<{ sessionId: string; serverId: string }>) => string);
    features?: () => ReturnType<typeof createRootLayoutFeaturesResponse>;
    accountCurrentness?: () => ReturnType<typeof createPlainAccountEncryptionCurrentnessFixture>;
    /** Current signed provenance when a journey exercises the ordinary Home Action front door. */
    credentials?: AuthCredentials;
    request?: (...args: Parameters<RuntimeFetch>) => Promise<Response | null>;
    configureSocket?: (socket: Socket, serverUrl?: string) => void;
    rpc?: (method: string, input: unknown, targetId: string, context: Readonly<{ serverUrl: string | undefined; targetId: string }>) => Promise<unknown>;
}> = {}) {
    const sessionId = params.sessionId ?? 's1';
    const serverIdentityId = 'srv_session_pane';
    const accountId = 'account-a';
    let account: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
    let accountDisposed = true;
    let previous: ReturnType<typeof storage.getState>;
    let pane: AppPaneScopeApi;
    let AppPaneProvider: typeof import('@/components/appShell/panes/AppPaneProvider')['AppPaneProvider'];
    let InjectedAuthProvider: typeof import('@/auth/context/AuthContext')['InjectedAuthProvider'];
    let useAppPaneScope: typeof import('@/components/appShell/panes/hooks/useAppPaneScope')['useAppPaneScope'];
    beforeEach(async () => {
        installDisconnectedServerSocketBoundary((socket, serverUrl) => {
            if (params.rpc) {
                vi.mocked(socket.connect).mockImplementation(() => {
                    socket.connected = true;
                    for (const listener of socket.listeners('connect')) listener();
                    return socket;
                });
                vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event, payload: unknown) => {
                    if (event === SESSION_HUMAN_PRESENCE_VISIBLE_REPLACE_EVENT) {
                        const request = SessionHumanPresenceVisibleReplaceV1Schema.parse(payload);
                        return SessionHumanPresenceVisibleReplaceResultV1Schema.parse({
                            v: 1, ok: true, admittedSessionIds: request.sessionIds,
                            ...(request.locations ? { admittedLocations: request.locations } : {}),
                        });
                    }
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
        const prepared = await prepareSessionPaneRuntimeForTests();
        ({ AppPaneProvider, InjectedAuthProvider, useAppPaneScope } = prepared);
        prepared.resetServerFeaturesClientForTests();
        previous = storage.getState();
        await restoreRealm({ accountId });
        replacePersistentUiStateForTest(paneUiState, {});
    });
    async function restoreRealm(realm: Readonly<{ serverUrl?: string; serverIdentityId?: string; accountId: string }>) {
        if (account && !accountDisposed) {
            const { scmStatusSync } = await import('@/scm/scmStatusSync');
            scmStatusSync.stop(sessionId, account.serverId);
            await account.dispose();
            accountDisposed = true;
        }
        const realmIdentityId = realm.serverIdentityId ?? serverIdentityId;
        const authoringMemory = createAuthoringMemoryHttpBoundary();
        const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => realm.accountId, encryptionMode: 'plain' });
        const readSession = (path: string): Response | undefined => {
            const turns = /^\/v1\/sessions\/([^/]+)\/turns$/.exec(path);
            if (turns && decodeURIComponent(turns[1]!) === sessionId) {
                // The registered Home Session exists before a cold client has hydrated it.
                const session = createSessionFixture({ id: sessionId, serverId: account.serverId });
                return Response.json(buildSessionTurnsProjectionV1({
                    sessionId: session.id, updatedAt: session.updatedAt, turns: [],
                }));
            }
            const exact = /^\/v2\/sessions\/([^/]+)$/.exec(path);
            if (!exact) return undefined;
            const session = storage.getState().sessions[decodeURIComponent(exact[1]!)];
            if (!session || !areServerProfileIdentifiersEquivalent(session.serverId, account?.serverId)) return Response.json(
                V2SessionByIdNotFoundSchema.parse({ error: 'Session not found' }), { status: 404 },
            );
            return Response.json(createPlainSessionByIdResponseFixture(session));
        };
        const sessionBoundary = createSessionReadBatchHttpBoundary(async request => {
            if (request.path === '/v2/sessions/read-batch') return undefined;
            return await params.request?.(request.url, { method: request.method, headers: request.headers,
                signal: request.signal }) ?? readSession(request.path);
        });
        account = await restoreServerAccountForTest({
            serverUrl: realm.serverUrl ?? 'https://session-pane.test',
            serverIdentityId: realmIdentityId,
            accountId: realm.accountId,
            ...(params.credentials && realm.accountId === accountId ? { credentials: params.credentials } : {}),
            request: async (url, init) => {
                const path = new URL(String(url)).pathname;
                const json = (value: unknown) => Response.json(value);
                const state = storage.getState();
                const machines = resolveServerScopedMachines({ serverId: realmIdentityId,
                    activeServerId: getActiveServerAccountScope()?.serverId ?? '', activeMachines: Object.values(state.machines),
                    machineListByServerId: state.machineListByServerId, machineListStatusByServerId: state.machineListStatusByServerId }) ?? [];
                const readMachine = (machineId: string) => {
                    const machine = machines.find(machine => machine.id === machineId);
                    return machine ? createPlainMachineRowFixture({ id: machineId, accountId: realm.accountId, machine }) : null;
                };
                if (path === '/v1/features' || path === '/v1/features/authenticated') {
                    const features = params.features?.() ?? createRootLayoutFeaturesResponse();
                    return json(FeaturesResponseSchema.parse({ ...features, capabilities: {
                        ...features.capabilities, serverIdentity: { serverIdentityId: realmIdentityId },
                    } }));
                }
                if ((init?.method ?? 'GET') === 'GET' && path === '/v2/cursor') return json(CurrentCursorResponseSchema.parse({ cursor: 0, changesFloor: 0 }));
                if (path === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v1/account/encryption/currentness') return json(params.accountCurrentness?.() ?? createPlainAccountEncryptionCurrentnessFixture());
                if (path === '/v1/account/profile') return json(AccountProfileSchema.parse({ id: realm.accountId }));
                const response = await params.request?.(url, init);
                if (response) return response;
                if ((init?.method ?? 'GET') === 'GET' && (path === '/v2/sessions' || path === '/v2/sessions/active')) {
                    // The same Home serves seeded Sessions by id and in its snapshots. An empty
                    // bootstrap snapshot after mount would authoritatively retire those rows.
                    const sessions = Object.values(storage.getState().sessions)
                        .filter(session => areServerProfileIdentifiersEquivalent(session.serverId, account?.serverId)
                            && (path !== '/v2/sessions/active' || session.active))
                        .map(session => createCompactSessionListRowFixture(createPlainSessionByIdResponseFixture(session).session));
                    return json(V2SessionListResponseSchema.parse({ sessions,
                        nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false }));
                }
                const memoryResponse = await authoringMemory.handle(url, init);
                if (memoryResponse) return memoryResponse;
                if (path === '/v1/account/project-rows/list') return json(createPlainProjectAccountRowListFixture());
                const artifactResponse = artifacts.handle(String(url), init);
                if (artifactResponse) return artifactResponse;
                if ((init?.method ?? 'GET') === 'GET' && path === '/v2/account/settings') return json(AccountSettingsV2GetResponseSchema.parse({ content: { t: 'plain', v: {} }, version: 0 }));
                if ((init?.method ?? 'GET') === 'GET' && path === '/v1/machines') return json(machines.map(machine =>
                    createPlainMachineRowFixture({ id: machine.id, accountId: realm.accountId, machine })));
                const bootstrapResponse = createEmptyAccountBootstrapHttpResponse(path, init);
                if (bootstrapResponse) return bootstrapResponse;
                if ((init?.method ?? 'GET') === 'GET' && path === AUTHORING_MEMORY_ROUTE_V1) return json(AuthoringMemoryListResponseV1Schema.parse({ rows: [] }));
                if (path === '/v2/sessions/read-batch' && init?.method === 'POST') {
                    return await sessionBoundary.handle({ home: realmIdentityId, accountId: realm.accountId,
                        url: new URL(String(url)), path, method: init.method, headers: new Headers(init.headers),
                        signal: init.signal, body: init.body ? JSON.parse(String(init.body)) : undefined })
                        ?? new Response('{}', { status: 404 });
                }
                if ((init?.method ?? 'GET') === 'GET') {
                    const sessionResponse = readSession(path);
                    if (sessionResponse) return sessionResponse;
                }
                if (path === '/v1/machines/read-batch' && init?.method === 'POST') {
                    return createMachineReadBatchResponseFixture(init.body, readMachine);
                }
                if ((init?.method ?? 'GET') === 'GET' && path.startsWith('/v1/machines/')) {
                    const machineId = decodeURIComponent(path.slice('/v1/machines/'.length));
                    const machine = readMachine(machineId);
                    if (!machine) return new Response('{}', { status: 404 });
                    return json({ machine });
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
        return <InjectedAuthProvider credentials={account.credentials}>
            <SessionViewerSourceAccountScopeProvider accountLifetime={captureActiveServerAccountScopeLifetime()}><AppPaneProvider>
            <Probe />{children}
        </AppPaneProvider></SessionViewerSourceAccountScopeProvider></InjectedAuthProvider>;
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
