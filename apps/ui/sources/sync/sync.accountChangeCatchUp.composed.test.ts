import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import React from 'react';
import 'fake-indexeddb/auto';
import type { Socket } from 'socket.io-client';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import type { RenderScreenResult } from '@/dev/testkit/render/renderScreen';
import {
    CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
    AUTHORING_MEMORY_ROUTE_V1,
    AuthoringMemoryListResponseV1Schema,
    projectLegacySessionAccessCapabilitiesV1,
    type NormalizedPluginCollectionUiQueryDescriptorV1,
    type PluginCollectionUiQueryRequestV1,
} from '@happier-dev/protocol';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { SESSION_DRAFT_V2_ROUTE_LIST, SessionDraftListResponseV2Schema } from '@happier-dev/protocol/drafts/sessionDraftsV2';
import {
    PluginAvailabilityActionHttpPathsV1,
    PluginAvailabilityIntentReadActionOutputV1Schema,
} from '@happier-dev/protocol/plugins/availability';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { ChangesCursorScope } from '@/sync/domains/state/persistence';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { FeedResponseSchema } from '@/sync/domains/social/feedTypes';

import {
    installLocalStorageMock,
    installWebLockManagerMock,
    type LocalStorageMockHandle,
    type WebLockManagerMockHandle,
} from '@/auth/storage/tokenStorage.web.testHelpers';

const ACCOUNT_ID = 'account-a';
const ACCOUNT_TOKEN = 'hdr.eyJzdWIiOiJhY2NvdW50LWEifQ.sig';
const DATA_PLUGIN_ID = 'example.tasks';
const SETTINGS_PLUGIN_ID = 'example.settings';
const AVAILABILITY_PLUGIN_ID = 'example.availability';

// Test-only narrow harness for the private canonical catch-up owner.
type SyncAccountChangeCatchUpHarness = {
    credentials: AuthCredentials | null;
    serverID: string | null;
    changesCursor: string | null;
    getChangesCursorScope(): ChangesCursorScope | null;
    resumeViaChanges(options: { accountId: string; shouldContinue?: () => boolean }): Promise<unknown>;
    disconnectServer(): void;
};

type SyncAccountChangeWakeSchedulingHarness = SyncAccountChangeCatchUpHarness & {
    resumeInFlight: Promise<void> | null;
    resumeViaChanges(options: { accountId: string; shouldContinue?: () => boolean }): Promise<unknown>;
    resumeSync(reason: 'app-foreground' | 'socket-reconnect' | 'changes-catch-up' | 'manual' | 'server-reachable'): Promise<void>;
    handleUpdate(update: unknown): Promise<void>;
};

const descriptor: NormalizedPluginCollectionUiQueryDescriptorV1 = {
    collection: { pluginId: DATA_PLUGIN_ID, collectionId: 'tasks' },
    id: 'open',
    indexId: 'by-status',
    parameters: {
        status: { kind: 'string', maxUtf8Bytes: 16, enum: ['open'] },
    },
    prefix: [{ kind: 'parameter', parameterId: 'status' }],
    order: 'asc',
    pageSize: 50,
    projectedFields: [
        { field: 'status', kind: 'string' },
        { field: 'title', kind: 'string' },
    ],
};

const queryRequest: PluginCollectionUiQueryRequestV1 = {
    pluginId: DATA_PLUGIN_ID,
    collectionId: 'tasks',
    readerContext: {
        pluginId: DATA_PLUGIN_ID,
        collectionId: 'tasks',
        schemaVersion: 1,
        contractDigest: 'a'.repeat(43),
    },
    uiQueryId: 'open',
    parameters: { status: 'open' },
};

// Sync imports persistence, which instantiates MMKV. Mock the device boundary.
const kvStore = vi.hoisted(() => new Map<string, string>());
vi.mock('react-native-mmkv', () => {
    class MMKV {
        getString(key: string) {
            return kvStore.get(key);
        }
        set(key: string, value: string) {
            kvStore.set(key, value);
        }
        delete(key: string) {
            kvStore.delete(key);
        }
        getAllKeys() {
            return [...kvStore.keys()];
        }
        clearAll() {
            kvStore.clear();
        }
    }

    return { MMKV };
});

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'web' },
        AppState: {
            currentState: 'active',
            addEventListener: vi.fn(() => ({ remove: vi.fn() })),
        },
    });
});

// The SDK and HTTP leaves are the only replaced owners in the composed cases.
const sockets: Socket[] = [];
installDisconnectedServerSocketBoundary((socket) => { sockets.push(socket); });
const domainHttp = vi.hoisted(() => vi.fn<(params: { url: string; init?: RequestInit }) => Promise<Response>>());
const changesResponse = vi.hoisted(() => vi.fn());
// Holding the genuine profile HTTP response keeps the real change applier in flight.
const profileResponseGate = vi.hoisted(() => vi.fn<() => Promise<void>>());
let account: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let authScreen: RenderScreenResult | undefined;

async function restoreTestAccount(options: { mountAuth?: boolean } = {}): Promise<void> {
    await loadSyncSingletonForTests();
    const { profileDefaults } = await import('./domains/profiles/profile');
    let bootstrapping = true;
    account = await restoreServerAccountForTest({
        serverUrl: 'http://localhost:53288',
        accountId: ACCOUNT_ID,
        credentials: { token: ACCOUNT_TOKEN },
        request: async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/health') return jsonResponse({});
            if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
            if (path === '/v1/account/encryption') return jsonResponse({ mode: 'plain', updatedAt: 1 });
            if (path === '/v1/account/encryption/currentness') return jsonResponse({
                mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null,
                updatedAt: 1, recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
            });
            if (path === '/v2/account/settings') return jsonResponse({ content: null, version: 0 });
            if (path === '/v1/account/profile') {
                await profileResponseGate();
                return jsonResponse({ ...profileDefaults, id: ACCOUNT_ID });
            }
            if (path === AUTHORING_MEMORY_ROUTE_V1) return jsonResponse(AuthoringMemoryListResponseV1Schema.parse({ rows: [] }));
            if (path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`) return jsonResponse(createPlainProjectAccountRowListFixture());
            if (path === SESSION_DRAFT_V2_ROUTE_LIST) return jsonResponse(SessionDraftListResponseV2Schema.parse({ items: [] }));
            if (path === '/v2/sessions' || path === '/v2/sessions/active') return jsonResponse({ sessions: [], nextCursor: null, hasNext: false });
            if (path === '/v1/machines' || path === '/v1/artifacts') return jsonResponse([]);
            if (path === '/v1/friends' || path === '/v1/friends/requests') return jsonResponse({ friends: [], requests: [] });
            if (path === '/v1/kv') return jsonResponse({ items: [] });
            if (path === '/v1/account/saved-secrets/resources/materials') return jsonResponse({ resources: [] });
            if (path === '/v1/feed') return jsonResponse(FeedResponseSchema.parse({ items: [], hasMore: false }));
            if (bootstrapping && path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read']) return jsonResponse({ availabilityCursor: 0, snapshots: [] });
            if (bootstrapping && path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list']) return jsonResponse({ availabilityCursor: 0, pluginIds: [], intentReads: [], failedPluginIds: [] });
            if (path === '/v2/cursor') return jsonResponse({ cursor: 0, changesFloor: 0 });
            if (path === '/v2/changes') {
                const page = await changesResponse({ url: String(url), init });
                return jsonResponse({ changes: page?.changes ?? [], nextCursor: Number(page?.nextCursor ?? 0) });
            }
            return domainHttp({ url: String(url), init });
        },
    });
    const { storage } = await import('./domains/state/storage');
    await waitForHomeGovernance(() => {
        expect(storage.getState().isDataReady).toBe(true);
        expect(storage.getState().profile.id).toBe(ACCOUNT_ID);
    });
    bootstrapping = false;
    if (!options.mountAuth) return;
    const { AuthProvider } = await import('@/auth/context/AuthContext');
    const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
    authScreen = await renderScreen(React.createElement(AuthProvider, {
        initialCredentials: account.credentials, children: null,
    }));
}

function jsonResponse(value: unknown): Response {
    return new Response(JSON.stringify(value), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}

function collectionResponse(title: string, changeCursor: number): Response {
    return jsonResponse({
        rows: [{
            context: {
                collection: { pluginId: DATA_PLUGIN_ID, collectionId: 'tasks' },
                rowId: 'task-1',
                revision: changeCursor,
            },
            fields: { status: 'open', title },
        }],
        changeCursor,
    });
}

function availabilityMaterializationsResponse(): Response {
    return jsonResponse({
        availabilityCursor: 9,
        snapshots: [],
    });
}

function availabilityIntentDiscoveryResponse(): Response {
    return jsonResponse({
        availabilityCursor: 9,
        pluginIds: [AVAILABILITY_PLUGIN_ID],
        intentReads: [{ pluginId: AVAILABILITY_PLUGIN_ID, response: availabilityIntentValue(AVAILABILITY_PLUGIN_ID) }],
        failedPluginIds: [],
    });
}

function availabilityIntentValue(pluginId: string) {
    return {
        availabilityCursor: 9,
        packageAssets: [],
        hostingCapability: { enabled: false },
        intent: {
            pluginId,
            desiredVersion: '1.2.3',
            enabled: true,
            offlineUiHosting: 'disabled',
            writableCollections: [],
            revision: '1',
        },
        release: null,
        uiArtifacts: [],
    };
}

function currentAccountStoredContentCompatibilityFeaturesResponse(): Response {
    return jsonResponse({
        features: {},
        capabilities: {
            accountStoredContentCompatibility: {
                v: 1,
                minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                declarationTransport: 'http-header-and-socket-auth-v1',
            },
        },
    });
}

async function prepareAccountChangeWakeSchedulingHarness(): Promise<SyncAccountChangeWakeSchedulingHarness> {
    await restoreTestAccount();
    const { sync } = await import('./syncEngine');
    return sync as unknown as SyncAccountChangeWakeSchedulingHarness;
}

function accountChangeWake(id: string): Readonly<{
    id: string;
    seq: number;
    createdAt: number;
    body: { t: 'account-change' };
}> {
    return {
        id,
        seq: 9,
        createdAt: 9,
        body: { t: 'account-change' },
    };
}

describe('sync AccountChange catch-up projection', () => {
    let localStorage: LocalStorageMockHandle | null = null;
    let webLocks: WebLockManagerMockHandle | null = null;

    beforeEach(async () => {
        vi.resetModules();
        kvStore.clear();
        localStorage = installLocalStorageMock();
        webLocks = installWebLockManagerMock();
        sockets.length = 0;
        domainHttp.mockReset();
        domainHttp.mockResolvedValue(Response.json({}, { status: 404 }));
        changesResponse.mockReset();
        profileResponseGate.mockReset();
        profileResponseGate.mockResolvedValue(undefined);
    });

    afterEach(async () => {
        await authScreen?.unmount();
        authScreen = undefined;
        await account?.dispose();
        account = undefined;
        const { sync } = await import('./syncEngine');
        sync.disposeEmbedSession();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        localStorage?.restore();
        localStorage = null;
        webLocks?.restore();
        webLocks = null;
        vi.resetModules();
        vi.clearAllMocks();
        vi.unstubAllGlobals();
    });

    it('boots and renews the embed session with only its explicit child credential and session corridor', async () => {
        // The browser realm is a genuine boundary: capture its route before importing owners.
        vi.stubGlobal('window', { location: { pathname: '/embed/session/embed' }, localStorage: globalThis.localStorage,
            addEventListener: vi.fn(), removeEventListener: vi.fn() });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const storedCredentialRead = vi.spyOn(TokenStorage, 'getCredentials');
        const scopedCredentialRead = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl');
        await loadSyncSingletonForTests();
        const { sync } = await import('./syncEngine');
        const { apiSocket } = await import('@/sync/api/session/apiSocket');
        const apiRequest = vi.spyOn(apiSocket, 'request');
        const initialize = vi.spyOn(apiSocket, 'initialize');
        const paths: string[] = [];
        const changesAfter: string[] = [];
        let expectedToken = 'hap_v1_child';
        let accessLevel: 'view' | 'edit' = 'view';
        let credentialRejected = false;
        const onCredentialRejected = vi.fn();
        vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const url = new URL(String(input));
            paths.push(url.pathname);
            expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${expectedToken}`);
            if (url.pathname === '/v1/features/authenticated') return currentAccountStoredContentCompatibilityFeaturesResponse();
            if (url.pathname === '/v2/cursor') return credentialRejected
                ? new Response(null, { status: 401 }) : jsonResponse({ cursor: 8, changesFloor: 0 });
            if (url.pathname === '/v2/changes') {
                expect(url.searchParams.get('sessionId')).toBe('embed');
                changesAfter.push(url.searchParams.get('after') ?? '');
                return jsonResponse({ changes: [], nextCursor: 9 });
            }
            if (url.pathname === '/v2/sessions/embed') return jsonResponse({ session: {
                id: 'embed', createdAt: 1, updatedAt: 1, seq: 0, active: false, activeAt: 0,
                encryptionMode: 'plain', dataEncryptionKey: null, metadataLayoutVersion: 0,
                metadataVersion: 1, metadata: JSON.stringify({ path: '/hidden', host: 'hidden', name: 'Embedded' }),
                agentStateVersion: 0, agentState: null, share: null,
                responsibleAccountId: null, responsibleAccount: null,
                effectiveAccess: { v: 1, level: accessLevel, sources: [],
                    capabilities: projectLegacySessionAccessCapabilitiesV1({ level: accessLevel }) },
            } });
            if (url.pathname === '/v1/sessions/embed/turns') return jsonResponse({ v: 1, sessionId: 'embed', updatedAt: 1, turns: [] });
            if (url.pathname === '/v1/sessions/embed/messages') return jsonResponse({ messages: [], nextAfterSeq: null });
            if (url.pathname === '/v2/sessions/embed/pending') return jsonResponse({ pending: [], pendingVersion: 0 });
            throw new Error(`Account request escaped embed: ${url.pathname}`);
        }));
        await sync.create({ token: 'hap_v1_child' }, null, undefined, {
            scope: { kind: 'embedSession', sessionId: 'embed' }, accountId: ACCOUNT_ID,
            endpointUrl: 'http://localhost:53288', isCurrent: () => true, onCredentialRejected,
        });
        expect(paths).toContain('/v2/sessions/embed');
        expect(paths).toContain('/v1/sessions/embed/messages');
        expect(paths).toContain('/v2/sessions/embed/pending');
        expect(paths.every((path) => path.includes('/embed') || path === '/v2/cursor' || path === '/v1/features/authenticated')).toBe(true);
        expect(storedCredentialRead).not.toHaveBeenCalled();
        expect(scopedCredentialRead).not.toHaveBeenCalled();
        expect(apiRequest).not.toHaveBeenCalled();
        expect(kvStore.size).toBe(0);
        const state = (await import('@/sync/domains/state/storage')).storage;
        const retainedTranscriptBeforeRenewal = state.getState().sessionMessages.embed;
        const retainedTurnsBeforeRenewal = state.getState().sessions.embed?.sessionTurns;
        expect(retainedTurnsBeforeRenewal).toBeDefined();
        expect(state.getState().isDataReady).toBe(true);
        expect((sync as unknown as SyncAccountChangeCatchUpHarness).changesCursor).toBe('8');
        const initialContext = sync.getEmbedSessionRequestContext();
        paths.length = 0;
        expectedToken = 'hap_v1_renewed';
        accessLevel = 'edit';
        await sync.create({ token: expectedToken }, null, undefined, {
            scope: { kind: 'embedSession', sessionId: 'embed' }, accountId: ACCOUNT_ID,
            endpointUrl: 'http://localhost:53288', isCurrent: () => true, onCredentialRejected,
        });
        expect(paths).toContain('/v2/sessions/embed');
        expect(paths).toContain('/v2/changes');
        expect(changesAfter).toEqual(['8']);
        expect(paths).not.toContain('/v1/features/authenticated');
        expect(paths).not.toContain('/v2/cursor');
        expect(paths).not.toContain('/v1/sessions/embed/turns');
        expect(paths).not.toContain('/v1/sessions/embed/messages');
        expect(state.getState().sessionMessages.embed).toBe(retainedTranscriptBeforeRenewal);
        expect(state.getState().sessions.embed?.sessionTurns).toBe(retainedTurnsBeforeRenewal);
        expect(state.getState().sessions.embed?.access?.capabilities.submitAgentInput).toBe(true);
        expect(initialize.mock.calls.map(([configuration]) => configuration.token))
            .toEqual(['hap_v1_child', 'hap_v1_renewed']);
        await expect(initialContext!.request('/v2/sessions/embed')).rejects.toMatchObject({ name: 'StaleServerGenerationError' });
        const onUpdate = sockets.at(-1)?.listeners('update')[0];
        const before = (await import('@/sync/domains/state/storage')).storage.getState().sessions.embed?.access;
        await onUpdate?.({ id: 'u', seq: 1, createdAt: 2, body: { t: 'update-session', id: 'embed',
            access: { role: 'owner', capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'owner' }) } } }, { serverId: 'http://localhost:53288' });
        expect((await import('@/sync/domains/state/storage')).storage.getState().sessions.embed?.access).toEqual(before);
        const context = sync.getEmbedSessionRequestContext();
        expect(context).not.toBeNull();
        await expect(context!.request('/v2/sessions/another')).rejects.toThrow('outside the embed Session corridor');
        credentialRejected = true;
        expect((await context!.request('/v2/cursor')).status).toBe(401);
        expect(onCredentialRejected).toHaveBeenCalledOnce();
        const retainedSession = state.getState().sessions.embed;
        const retainedTranscript = state.getState().sessionMessages.embed;
        sync.disposeEmbedSession({ preserveSessionState: true });
        expect(state.getState().sessions.embed).toBe(retainedSession);
        expect(state.getState().sessionMessages.embed).toBe(retainedTranscript);
        await expect(context!.request('/v2/sessions/embed')).rejects.toMatchObject({ name: 'StaleServerGenerationError' });
    });

    it('projects one V3 AccountChange catch-up page through the existing Data, Settings, and Availability owners', async () => {
        const availabilityRefresh = createDeferred<void>();
        let dataReadCount = 0;
        domainHttp.mockImplementation(async ({ url }: { url: string }) => {
            const path = new URL(url).pathname;
            if (path === '/v1/features') {
                return currentAccountStoredContentCompatibilityFeaturesResponse();
            }
            if (path === '/v1/account/saved-secrets/resources/materials') {
                return jsonResponse({ resources: [] });
            }
            if (path === '/v2/sessions/metadata-upgrades') {
                // This Account's empty Session inventory has no metadata tuples to upgrade.
                return jsonResponse({ sessionIds: [] });
            }
            if (path === '/v1/plugins/data/ui-query') {
                dataReadCount += 1;
                return collectionResponse(
                    dataReadCount === 1 ? 'before AccountChange' : 'after AccountChange',
                    dataReadCount,
                );
            }
            if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read']) {
                await availabilityRefresh.promise;
                return availabilityMaterializationsResponse();
            }
            if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list']) {
                return availabilityIntentDiscoveryResponse();
            }
            return jsonResponse({});
        });
        changesResponse.mockResolvedValue({
            status: 'ok',
            changes: [
                {
                    cursor: 5,
                    kind: 'account',
                    entityId: 'self',
                    changedAt: 5,
                    hint: null,
                },
                {
                    cursor: 6,
                    kind: 'pluginDomain',
                    entityId: `pluginDomain/${SETTINGS_PLUGIN_ID}/settings`,
                    changedAt: 6,
                    hint: {
                        pluginDomain: 'settings',
                        pluginId: SETTINGS_PLUGIN_ID,
                        scope: 'account',
                        revision: 1,
                    },
                },
                {
                    cursor: 8,
                    kind: 'pluginDomain',
                    entityId: `pluginDomain/${DATA_PLUGIN_ID}/data-collection/tasks`,
                    changedAt: 8,
                    hint: {
                        pluginDomain: 'dataCollection',
                        pluginId: DATA_PLUGIN_ID,
                        collectionId: 'tasks',
                        contractDigest: 'a'.repeat(43),
                        revision: 1,
                        full: true,
                    },
                },
                {
                    cursor: 9,
                    kind: 'pluginDomain',
                    entityId: `pluginDomain/${AVAILABILITY_PLUGIN_ID}/availability`,
                    changedAt: 9,
                    hint: {
                        pluginDomain: 'availability',
                        pluginId: AVAILABILITY_PLUGIN_ID,
                    },
                },
            ],
            nextCursor: '9',
        });

        const { upsertAndActivateServer, getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        const { storage } = await import('./domains/state/storage');
        const { loadChangesCursor } = await import('./domains/state/persistence');
        const { recordAccountStoredContentServerRequirements } = await import(
            './http/accountStoredContentCompatibility'
        );
        const { captureActiveServerAccountScopeLifetime } = await import(
            '@/sync/domains/scope/activeServerAccountScope'
        );
        const {
            createActivePluginCollectionUiQueryPager,
        } = await import('./api/plugins/data/queryPluginCollectionUiQuery');
        const {
            watchActiveScopedPluginSettingsChanges,
        } = await import('./domains/plugins/settings/scopedPluginSettingsChangeWatch');
        const {
            subscribeAccountEncryptionModeCacheInvalidation,
        } = await import('./api/account/apiAccountEncryptionMode');
        await restoreTestAccount({ mountAuth: true });
        const { sync } = await import('./sync');
        const syncHarness = sync as unknown as SyncAccountChangeCatchUpHarness;
        const serverId = String(getActiveServerSnapshot().serverId ?? '').trim();
        const cursorScope = syncHarness.getChangesCursorScope();
        expect(cursorScope).not.toBeNull();

        const {
            replacePluginAccountAvailabilityProjection,
            useActivePluginAccountAvailabilityReader,
        } = await import('./domains/plugins/availability/projection');
        const unaffectedPluginId = 'example.unaffected';
        replacePluginAccountAvailabilityProjection({
            scope: { serverId, accountId: ACCOUNT_ID },
            snapshot: {
                availabilityCursor: 8,
                intentReads: await Promise.all([AVAILABILITY_PLUGIN_ID, unaffectedPluginId].map(async (pluginId) => ({
                    pluginId,
                    response: PluginAvailabilityIntentReadActionOutputV1Schema.parse({
                        ...availabilityIntentValue(pluginId),
                        availabilityCursor: 8,
                    }),
                }))),
                materializations: [],
                snapshots: [],
            },
        });
        const availabilityHook = await renderHook(useActivePluginAccountAvailabilityReader);
        const availabilityReader = availabilityHook.getCurrent();
        expect(availabilityReader?.readMaterializations()).toMatchObject({
            kind: 'available',
            intentReads: [{ pluginId: AVAILABILITY_PLUGIN_ID }, { pluginId: unaffectedPluginId }],
        });

        const pager = createActivePluginCollectionUiQueryPager({ descriptor, request: queryRequest });
        await pager.refresh();
        expect(pager.getSnapshot()).toMatchObject({
            status: 'ready',
            rows: [{ fields: { title: 'before AccountChange' } }],
        });

        const lifetime = captureActiveServerAccountScopeLifetime();
        expect(lifetime?.isCurrent()).toBe(true);
        const onSettingsInvalidated = vi.fn();
        const onAccountEncryptionModeInvalidated = vi.fn();
        const accountEncryptionModeInvalidation = subscribeAccountEncryptionModeCacheInvalidation(
            onAccountEncryptionModeInvalidated,
        );
        const settingsWatch = watchActiveScopedPluginSettingsChanges({
            pluginId: SETTINGS_PLUGIN_ID,
            target: { kind: 'account', serverIdentityId: 'server-identity-a' },
            lifetime: lifetime!,
            onInvalidated: onSettingsInvalidated,
        });
        const pagerRefreshed = new Promise<void>((resolve) => {
            const subscription = pager.subscribe(() => {
                if (pager.getSnapshot().status !== 'ready') return;
                if (pager.getSnapshot().rows[0]?.fields.title !== 'after AccountChange') return;
                subscription();
                resolve();
            });
        });

        try {
            await act(async () => {
                await expect(syncHarness.resumeViaChanges({ accountId: ACCOUNT_ID })).resolves.toMatchObject({
                    status: 'ok',
                });
            });
            // A freshness hint has no replacement fact: retain confirmed reads
            // while the named plugin's authoritative refresh is held.
            expect(availabilityReader?.readMaterializations()).toMatchObject({
                kind: 'available',
                availabilityCursor: 8,
                intentReads: [{ pluginId: AVAILABILITY_PLUGIN_ID }, { pluginId: unaffectedPluginId }],
            });
        } finally {
            availabilityRefresh.resolve();
        }
        await act(async () => {
            await pagerRefreshed;
            await waitForHomeGovernance(() => {
                expect(availabilityReader?.readMaterializations()).toMatchObject({
                    kind: 'available',
                    availabilityCursor: 9,
                });
            });
        });
        // A named X refresh replaces X, not the unaffected Y read.
        expect(availabilityReader?.readMaterializations()).toMatchObject({
            intentReads: [
                { pluginId: AVAILABILITY_PLUGIN_ID, response: { availabilityCursor: 9 } },
                { pluginId: unaffectedPluginId, response: { availabilityCursor: 8 } },
            ],
        });
        await availabilityHook.unmount();

        expect(syncHarness.changesCursor).toBe('9');
        expect(loadChangesCursor(cursorScope)).toBe('9');
        expect(onSettingsInvalidated).toHaveBeenCalledOnce();
        expect(onAccountEncryptionModeInvalidated).toHaveBeenCalledOnce();
        expect(dataReadCount).toBe(2);
        expect(pager.getSnapshot()).toMatchObject({
            status: 'ready',
            rows: [{ fields: { title: 'after AccountChange' } }],
        });
        expect(domainHttp.mock.calls.map(([params]) => new URL(params.url).pathname)).toEqual(expect.arrayContaining([
            PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read'],
            PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list'],
        ]));

        accountEncryptionModeInvalidation();
        settingsWatch.dispose();
        pager.dispose();
        syncHarness.disconnectServer();
    });

    it('publishes a fetched AccountChange to the Home whose cursor was read when focus changes in flight', async () => {
        const harness = await prepareAccountChangeWakeSchedulingHarness();
        const { subscribeHomeAccountChange } = await import('./runtime/orchestration/homeAccountChange');
        const { getActiveServerSnapshot, upsertAndActivateServer } = await import('./domains/server/serverRuntime');
        const sourceServerId = String(getActiveServerSnapshot().serverId ?? '').trim();

        let releaseChanges!: () => void;
        const changesReleased = new Promise<void>((resolve) => {
            releaseChanges = resolve;
        });
        let markChangesStarted!: () => void;
        const changesStarted = new Promise<void>((resolve) => {
            markChangesStarted = resolve;
        });
        changesResponse.mockImplementationOnce(async () => {
            markChangesStarted();
            await changesReleased;
            return {
                status: 'ok' as const,
                changes: [{
                    cursor: 1,
                    kind: 'account' as const,
                    entityId: 'self',
                    changedAt: 1,
                    hint: null,
                }],
                nextCursor: '1',
            };
        });

        const observedWakes: Array<{
            serverId: string;
            entityIds?: readonly string[];
            sessionListQueryAffects?: boolean | 'structural';
        }> = [];
        const dispose = subscribeHomeAccountChange((event) => observedWakes.push(event));
        const catchUp = harness.resumeViaChanges({ accountId: ACCOUNT_ID });
        await changesStarted;
        const focusedServer = await upsertAndActivateServer({
            serverUrl: 'http://localhost:53289',
            scope: 'tab',
        });
        expect(focusedServer.id).not.toBe(sourceServerId);
        releaseChanges();

        await expect(catchUp).resolves.toMatchObject({ status: 'ok' });
        expect(observedWakes).toMatchObject([{
            serverId: sourceServerId,
            entityIds: ['self'],
            // An unqualified self change can alter credential/Account currentness.
            sessionListQueryAffects: true,
        }]);
        dispose();
        harness.disconnectServer();
    });

    it('keeps an AccountChange refresh on the applied Home while another Home is staged', async () => {
        const harness = await prepareAccountChangeWakeSchedulingHarness();
        const { subscribeHomeAccountChange } = await import('./runtime/orchestration/homeAccountChange');
        const { getActiveServerSnapshot, upsertAndActivateServer } = await import('./domains/server/serverRuntime');
        const { getActiveServerAccountScope } = await import('./domains/scope/activeServerAccountScope');
        const appliedSnapshot = getActiveServerSnapshot();
        const appliedServerId = String(appliedSnapshot.serverId ?? '').trim();
        changesResponse.mockResolvedValueOnce({
            status: 'ok' as const,
            changes: [{
                cursor: 1,
                kind: 'account' as const,
                entityId: 'self',
                changedAt: 1,
                hint: null,
            }],
            nextCursor: '1',
        });

        await upsertAndActivateServer({
            serverUrl: 'http://localhost:53289',
            scope: 'device',
        });
        const stagedSnapshot = getActiveServerSnapshot();
        expect(stagedSnapshot.serverId).not.toBe(appliedServerId);
        // Selecting a Home cannot grant its Account an applied runtime lifetime.
        expect(getActiveServerAccountScope()).toEqual({ serverId: appliedServerId, accountId: ACCOUNT_ID });

        const observedWakes: Array<{ serverId: string }> = [];
        const dispose = subscribeHomeAccountChange((event) => observedWakes.push(event));
        await expect(harness.resumeViaChanges({ accountId: ACCOUNT_ID })).resolves.toMatchObject({
            status: 'ok',
        });

        expect(changesResponse).toHaveBeenCalledOnce();
        expect(observedWakes).toEqual([expect.objectContaining({ serverId: appliedServerId })]);
        dispose();
        harness.disconnectServer();
    });

    it('coalesces wakes received after a changes response into one trailing canonical catch-up', async () => {
        const harness = await prepareAccountChangeWakeSchedulingHarness();
        const { subscribeHomeAccountChange } = await import('./runtime/orchestration/homeAccountChange');
        const { loadChangesCursor } = await import('./domains/state/persistence');
        const observed: Array<readonly string[] | undefined> = [];
        const dispose = subscribeHomeAccountChange(({ entityIds }) => observed.push(entityIds));
        const profileStarted = createDeferred<void>();
        const releaseProfile = createDeferred<void>();
        profileResponseGate.mockImplementationOnce(async () => {
            profileStarted.resolve();
            await releaseProfile.promise;
        });
        changesResponse.mockResolvedValue({ changes: [], nextCursor: '1' }).mockResolvedValueOnce({
            changes: [{ cursor: 1, kind: 'account', entityId: 'self', changedAt: 1, hint: null }], nextCursor: '1',
        });
        const firstResume = harness.resumeSync('manual');
        try {
            await profileStarted.promise;
            // The page arrived; its real profile materialization still owns the resume slot.
            await Promise.all([1, 2, 3].map(id => harness.handleUpdate(accountChangeWake(`account-change-${id}`))));
            expect(changesResponse).toHaveBeenCalledOnce();
            releaseProfile.resolve();
            await firstResume;
            await waitForHomeGovernance(() => {
                expect(changesResponse).toHaveBeenCalledTimes(2);
                expect(harness.resumeInFlight).toBeNull();
            });
            expect(changesResponse.mock.calls.map(([request]) => new URL(request.url).searchParams.get('after'))).toEqual(['0', '1']);
            expect(loadChangesCursor(harness.getChangesCursorScope())).toBe('1');
            expect(observed).toEqual([['self']]);
        } finally {
            releaseProfile.resolve();
            dispose();
        }
    });

    it('publishes no content-free Home change for a focused-Home wake and asks for the exact page instead', async () => {
        const harness = await prepareAccountChangeWakeSchedulingHarness();
        const { subscribeHomeAccountChange } = await import('./runtime/orchestration/homeAccountChange');
        const changesStarted = createDeferred<void>();
        const releaseChanges = createDeferred<void>();
        changesResponse.mockImplementationOnce(async () => {
            changesStarted.resolve();
            await releaseChanges.promise;
            return { changes: [{ cursor: 1, kind: 'account', entityId: 'self', changedAt: 1, hint: null }], nextCursor: '1' };
        });
        const observed: Array<Readonly<{ serverId: string; entityIds?: readonly string[] }>> = [];
        const dispose = subscribeHomeAccountChange((event) => observed.push(event));

        try {
            await harness.handleUpdate(accountChangeWake('account-change-focused'));
            await changesStarted.promise;
            expect(observed).toEqual([]);
            releaseChanges.resolve();
            await waitForHomeGovernance(() => expect(harness.resumeInFlight).toBeNull());
            expect(changesResponse).toHaveBeenCalledOnce();
            expect(observed).toEqual([expect.objectContaining({ entityIds: ['self'] })]);
        } finally {
            releaseChanges.resolve();
            dispose();
        }
    });

    it('drops a queued AccountChange wake when its server/account lifetime resets', async () => {
        const harness = await prepareAccountChangeWakeSchedulingHarness();
        const { loadChangesCursor } = await import('./domains/state/persistence');
        const scope = harness.getChangesCursorScope();
        const cursorBefore = loadChangesCursor(scope);
        const changesStarted = createDeferred<void>();
        const releaseChanges = createDeferred<void>();
        changesResponse.mockImplementationOnce(async () => {
            changesStarted.resolve();
            await releaseChanges.promise;
            return { changes: [], nextCursor: '1' };
        });
        const firstResume = harness.resumeSync('manual');
        try {
            await changesStarted.promise;
            await harness.handleUpdate(accountChangeWake('account-change-before-reset'));
            harness.disconnectServer();
            releaseChanges.resolve();
            await firstResume;
            await waitForHomeGovernance(() => expect(harness.resumeInFlight).toBeNull());
            expect(changesResponse).toHaveBeenCalledOnce();
            expect(loadChangesCursor(scope)).toBe(cursorBefore);
        } finally {
            releaseChanges.resolve();
        }
    });
});
