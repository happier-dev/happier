import * as React from 'react';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { projectLegacySessionAccessCapabilitiesV1, SessionAwarenessListResultV1Schema } from '@happier-dev/protocol';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { Encryption } from '@/sync/encryption/encryption';
import { encodeBase64 } from '@/encryption/base64';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';
import 'fake-indexeddb/auto';

installDisconnectedServerSocketBoundary();

// Sync imports persistence, which instantiates MMKV. Mock it for deterministic tests.
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
        clearAll() {
            kvStore.clear();
        }
    }

    return { MMKV };
});

const appStateAddListener = vi.hoisted(() => vi.fn(() => ({ remove: vi.fn() })));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
            Platform: { OS: 'web' },
            AppState: { addEventListener: appStateAddListener },
        }
    );
});

vi.mock('@/log', () => ({
    log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const requestMock = vi.hoisted(() => vi.fn());
const runtimeFetchMock = vi.hoisted(() => vi.fn());

import { storage } from './domains/state/storage';
import { createDeferred, renderHook, renderScreen } from '@/dev/testkit';
import { setActiveServerId, upsertServerProfile } from './domains/server/serverProfiles';
import { getActiveServerSnapshot } from './domains/server/serverRuntime';
import { loadSessionMaterializedMaxSeqById } from './domains/state/persistence';
import type { AccountSettingsScope } from './domains/settings/scope/accountSettingsScope';
import type { Session } from './domains/state/storageTypes';
import { createReducer } from "@happier-dev/session-core/reducer";
import type { Message } from "@happier-dev/session-core/messages";
import {
    markSessionSurfaceHidden,
    markSessionSurfaceVisible,
    resetSessionSurfaceVisibilityForTests,
} from './domains/session/sessionSurfaceVisibility';

const initialStorageState = storage.getState();

function createSession(params: { sessionId: string; serverId?: string }): Session {
    const now = Date.now();
    return {
        id: params.sessionId,
        // Every row the store actually holds is addressed to the Home it came from
        // (`syncSessions` writes `serverId`); an unscoped fixture row is a shape the
        // runtime never produces and it refuses the message-route fast path.
        serverId: params.serverId ?? String(getActiveServerSnapshot().serverId ?? '').trim(),
        seq: 0,
        encryptionMode: 'e2ee',
        createdAt: now,
        updatedAt: now,
        active: true,
        activeAt: now,
        metadata: null,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        optimisticThinkingAt: null,
    };
}

function tokenForSub(sub: string): string {
    const payload = globalThis.btoa(JSON.stringify({ sub }))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replaceAll('=', '');
    return `e30.${payload}.signature`;
}

async function waitForAssertion(assertion: () => void): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
            assertion();
            return;
        } catch (error) {
            lastError = error;
            await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
    }
    throw lastError;
}

function expectRuntimeFetchWithBearer(url: string, token: string): void {
    const call = runtimeFetchMock.mock.calls.find(([requestedUrl]) => requestedUrl === url);
    expect(call).toBeDefined();
    const init = call?.[1] as RequestInit | undefined;
    expect(init).toEqual(expect.objectContaining({ method: 'GET' }));
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${token}`);
}

async function applySelectedHomeForSessionListTest(credentials?: import('@/auth/storage/tokenStorage').AuthCredentials): Promise<void> {
    const { disconnectActiveServerConnection } = await import('./runtime/orchestration/connectionManager');
    await disconnectActiveServerConnection();
    const selected = getActiveServerSnapshot();
    const appliedCredentials = credentials ?? { token: tokenForSub('account-a') };
    await TokenStorage.setCredentialsForServerUrl(selected.serverUrl, { serverId: selected.serverId }, appliedCredentials);
    const connection = await restoreServerAccountForTest({
        serverUrl: selected.serverUrl,
        credentials: appliedCredentials,
        request: (url, init) => runtimeFetchMock(String(url), init),
    });
    vi.mocked(TokenStorage.getCredentialsForServerUrl).mockRestore();
    const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    setRuntimeFetch((url, init) => runtimeFetchMock(String(url), init));
    onTestFinished(connection.dispose);
    const { sync } = await import('./sync');
    // Bootstrap's settings queue precedes its Session queue. Join both real
    // queues before a case installs a held response for an Account mutation.
    const settingsQueue = Reflect.get(sync, 'settingsSync') as import('@/utils/sessions/sync').InvalidateSync;
    await settingsQueue.awaitQueue();
    await sync.refreshSessions();
    requestMock.mockClear();
    runtimeFetchMock.mockClear();
}

async function createEncryptedSessionFixture(sessionId: string) {
    const secret = new Uint8Array(32).fill(7);
    const dataKey = new Uint8Array(32).fill(8);
    const encryption = await Encryption.create(secret);
    const writer = await Encryption.create(secret);
    await writer.initializeSessions(new Map([[sessionId, dataKey]]));
    const cipher = writer.getSessionEncryption(sessionId)!;
    const metadataValue = { path: '/repo', host: 'host' };
    const agentStateValue = { controlledByUser: true, requests: {}, completedRequests: {} };
    const dataEncryptionKey = encodeBase64(sealEncryptedDataKeyEnvelopeV1({
        dataKey, recipientPublicKey: encryption.contentDataKey,
        randomBytes: (length) => new Uint8Array(length).fill(3),
    }), 'base64');
    return {
        encryption, dataKey, credentials: { token: tokenForSub('account-a'), secret: encodeBase64(secret, 'base64url') },
        row: {
            id: sessionId, createdAt: 1, updatedAt: 2, seq: 3, active: true, activeAt: 2,
            encryptionMode: 'e2ee' as const, dataEncryptionKey,
            metadataVersion: 1, metadata: await cipher.encryptRaw(metadataValue),
            agentStateVersion: 1, agentState: await cipher.encryptRaw(agentStateValue), share: null,
        },
    };
}

describe('sync.ensureSessionVisibleForMessageRoute', () => {
    it.each(['current', 'retired'] as const)('upgrades offscreen legacy public-linked Sessions through the real tuple writer only for the %s Account lifetime', async (lifetime) => {
        const home = await upsertServerProfile({ serverUrl: 'https://owner-first-visit.example.test', name: 'First visit' });
        await setActiveServerId(home.id, { scope: 'device' });
        await applySelectedHomeForSessionListTest({ token: tokenForSub('owner-first-visit') });
        const { sync } = await import('./syncEngine');
        const credentials = { token: tokenForSub('owner-first-visit') };
        Reflect.set(sync, 'credentials', credentials);
        Reflect.set(sync, 'encryption', null);
        storage.setState({ profileScope: { serverId: home.id, accountId: 'owner-first-visit' } });
        const legacyMetadata = { path: '/owner/private', host: 'owner-host', name: 'Retained session' };
        const patches: unknown[] = [];
        const discovery = createDeferred<Response>();
        const request = async (path: string, init?: RequestInit): Promise<Response> => {
            const route = path.split('?')[0];
            if (route === '/v1/auth/ping') return Response.json({ success: true });
            if (route === '/v1/account/encryption/currentness') return Response.json({
                mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
            });
            if (route === '/v2/sessions/metadata-upgrades') {
                return patches.length ? Response.json({ sessionIds: [] }) : discovery.promise;
            }
            if (route === '/v2/sessions/legacy-offscreen' && init?.method === 'PATCH') {
                patches.push(JSON.parse(String(init.body)));
                return Response.json({ success: true, metadataLayoutVersion: 1, sharedMetadata: { version: 4 }, agentState: { version: 6 } });
            }
            if (route === '/v2/sessions/legacy-offscreen') return Response.json({ session: {
                id: 'legacy-offscreen', seq: 1, createdAt: 1, updatedAt: 2, active: false, activeAt: 2,
                archivedAt: 3, encryptionMode: 'plain', dataEncryptionKey: null, metadataLayoutVersion: 0,
                metadata: JSON.stringify(legacyMetadata), metadataVersion: 3, agentState: null, agentStateVersion: 5, share: null,
                effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], audienceContext: null,
                    capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'owner', canApprovePermissions: true }) },
            } });
            if (route === '/v2/sessions' || route === '/v2/sessions/active') return Response.json({ sessions: [], nextCursor: null, hasNext: false });
            return new Response(null, { status: 404 });
        };
        requestMock.mockImplementation(request);
        runtimeFetchMock.mockImplementation((url: string, init?: RequestInit) => request(new URL(url).pathname + new URL(url).search, init));
        const refreshing = sync.refreshSessions({ awaitSessionListHydration: true });
        await waitForAssertion(() => expect(storage.getState().concurrentSessionListCacheByServerId[home.id]?.listObservation?.phase).toBe('ready'));
        expect(patches).toEqual([]);
        if (lifetime === 'retired') storage.setState({ profileScope: { serverId: home.id, accountId: 'different-account' } });
        discovery.resolve(Response.json({ sessionIds: ['legacy-offscreen'] }));
        await refreshing;
        if (lifetime === 'retired') {
            expect(patches).toEqual([]);
            return;
        }
        expect(patches).toHaveLength(1);
        expect(patches[0]).toMatchObject({ mode: 'owner_migration', expectedAccountEncryptionMode: 'plain',
            source: { metadata: { version: 3, ciphertext: JSON.stringify(legacyMetadata) } },
            target: { ownerMetadata: { t: 'plain', v: { workspace: { path: '/owner/private', host: 'owner-host' } } } },
        });
        const patch = patches[0] as { target: { sharedMetadata: { ciphertext: string } } };
        expect(patch.target.sharedMetadata.ciphertext).not.toContain('/owner/private');
        await sync.refreshSessions({ awaitSessionListHydration: true });
        expect(patches).toHaveLength(1);
    });
    it.each([
        ['retired', 'applied'], ['retired', 'conflict'], ['retired', 'outcomeUnknown'],
        ['advanced', 'applied'], ['erase-retired', 'applied'], ['erase-retired', 'outcomeUnknown'],
        ['data-retired', 'applied'], ['data-retired', 'outcomeUnknown'],
        ['cancel-before-settings', 'applied'],
        ['cancel-before-post', 'applied'],
        ['advanced-ui', 'applied'],
        ['advanced-projection', 'applied'],
    ] as const)('retains plugin secret settlement after %s Account presentation (%s)', async (presentation, outcome) => {
        const { createDeferred } = await import('@/dev/testkit');
        const isCancellation = presentation === 'cancel-before-settings' || presentation === 'cancel-before-post';
        const { settingsParse } = await import('@/sync/domains/settings/settings');
        const { scopedPluginAccountSecretSettingsAdapter } = await import('@/sync/domains/plugins/settings/scopedPluginSettingsRuntime');
        const { executeAccountPluginDataEraseAction } = await import('@/sync/domains/plugins/settings/accountPluginDataEraseAction');
        const { applyAccountSettingsSavedSecretMutation, PLUGIN_ACCOUNT_DATA_ERASE_HTTP_PATH_V1 } = await import('@happier-dev/protocol');
        const { adoptHomeProfile } = await import('@/sync/domains/server/serverProfiles');
        const { retireActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { loadAccountSettings } = await import('@/sync/domains/state/accountSettingsPersistence');
        const { sync } = await import('./sync');
        const originalSecretKey = Reflect.get(sync, 'settingsSecretsKey');
        const originalSecretReadKeys = Reflect.get(sync, 'settingsSecretsReadKeys');
        onTestFinished(() => {
            Reflect.set(sync, 'settingsSecretsKey', originalSecretKey);
            Reflect.set(sync, 'settingsSecretsReadKeys', originalSecretReadKeys);
        });
        const serverIdentityId = 'srv_secret_settlement';
        const profile = await adoptHomeProfile({ source: 'manual', descriptor: {
            serverUrl: 'https://secret-settlement.example.test', homeServerIdentityId: serverIdentityId,
        } });
        await setActiveServerId(profile.id, { scope: 'device' });
        await applySelectedHomeForSessionListTest();
        const scope = { serverId: serverIdentityId, accountId: 'account-a' };
        const credentials = { token: tokenForSub(scope.accountId) };
        Reflect.set(sync, 'credentials', credentials);
        Reflect.set(sync, 'encryption', null);
        // Plain Accounts have no Account E2EE material, but local Settings
        // persistence still seals SavedSecret values with a device-local key.
        const localSecretKey = new Uint8Array(32).fill(17);
        Reflect.set(sync, 'settingsSecretsKey', localSecretKey);
        Reflect.set(sync, 'settingsSecretsReadKeys', [localSecretKey]);
        Reflect.set(sync, 'pendingSettingsScope', scope);
        Reflect.set(sync, 'pendingSettings', {});
        const baseline = presentation === 'data-retired' ? {} : applyAccountSettingsSavedSecretMutation({}, {
            kind: 'replacePluginSecret', target: { pluginId: 'acme.settings', localId: 'apiToken' },
            expectedSecretId: null, expectedSecretUpdatedAt: null,
            secret: { id: 'existing-plugin-secret', name: 'Existing token', kind: 'other',
                encryptedValue: { _isSecretValue: true, value: 'old-secret-not-for-renderer' }, createdAt: 1, updatedAt: 1 },
        }).settings;
        const { recordAccountStoredContentServerRequirements } = await import('@/sync/http/accountStoredContentCompatibility');
        recordAccountStoredContentServerRequirements({ serverUrl: profile.serverUrl, requirements: {
            v: 1, minimumProtocolVersion: 2, currentProtocolVersion: 3,
            declarationTransport: 'http-header-and-socket-auth-v1',
        } });
        storage.setState({ profileScope: scope, settingsScope: scope, settings: settingsParse(baseline), settingsVersion: 5 });
        const issued = createDeferred<void>();
        const response = createDeferred<Response>();
        const postPaths: string[] = [];
        const cancellation = new AbortController();
        runtimeFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
            const path = new URL(url).pathname;
            if (init?.method === 'POST' && (path === '/v2/account/settings' || path === PLUGIN_ACCOUNT_DATA_ERASE_HTTP_PATH_V1)) postPaths.push(path);
            if (path === '/v1/auth/ping') return Response.json({ success: true });
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v1/account/encryption/currentness') return Response.json({ mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 });
            if (path === PLUGIN_ACCOUNT_DATA_ERASE_HTTP_PATH_V1) {
                expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${credentials.token}`);
                issued.resolve();
                return response.promise.then((result) => result.clone());
            }
            if (path === '/v2/account/settings' && init?.method === 'POST') {
                expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${credentials.token}`);
                if (isCancellation) return Response.json({ success: true, version: 6 });
                issued.resolve();
                return response.promise.then((result) => result.clone());
            }
            if (path === '/v2/account/settings' && presentation === 'cancel-before-settings') {
                issued.resolve();
                return response.promise.then((readResponse) => readResponse.clone());
            }
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: baseline }, version: 5 });
            if (path.includes('push-tokens')) {
                if (presentation === 'cancel-before-post') {
                    issued.resolve();
                    return response.promise.then((readResponse) => readResponse.clone());
                }
                return new Response(null, { status: 404 });
            }
            // A peripheral bootstrap route may be unsupported while this Home
            // is reachable; throwing here would manufacture a network outage.
            return new Response(null, { status: 404 });
        });
        let screen: Awaited<ReturnType<typeof renderScreen>> | null = null;
        let secretProjection: import('./domains/plugins/settings/scopedPluginSettingsProjection').ScopedPluginSettingsProjection | null = null;
        const inputId = 'settings.plugins.detail.acme.settings.settings.secrets.apiToken.input';
        const saveId = 'settings.plugins.detail.acme.settings.settings.secrets.apiToken.save';
        if (presentation === 'advanced-ui') {
            const { PluginDetailGenericSettingsSection } = await import('@/components/settings/plugins/detail/PluginDetailGenericSettingsSection');
            screen = await renderScreen(React.createElement(PluginDetailGenericSettingsSection, {
                pluginId: 'acme.settings', machineId: null, serverId: profile.id,
                accountServerIdentityId: serverIdentityId, daemonOperationsAvailable: false,
                projection: {
                    pluginId: 'acme.settings', immutableGenerationId: 'secret-ui-generation',
                    title: 'Settings', description: null, version: '1.0.0', enabled: true,
                    generation: 1, generationLabel: '1', status: null, provenance: null,
                    diagnostics: [], actions: [], resources: [],
                    editableSettingsGroups: [{
                        id: 'secrets', pluginId: 'acme.settings', version: 1, title: 'Secrets',
                        scope: { kind: 'account' }, target: { kind: 'plugin' },
                        presentation: { sections: [], subagentSections: [] },
                        fields: [{ key: 'apiToken', title: 'API token', control: 'password',
                            valueType: 'string', valueSchema: { type: 'string' },
                            secretCustody: 'account', redaction: 'secret', clearWhenEmpty: 'omit' }],
                    }],
                },
            }));
            await waitForAssertion(() => expect(screen!.findByTestId(inputId)).not.toBeNull());
            await waitForAssertion(() => expect(screen!.findByTestId(inputId)?.props.editable).not.toBe(false));
            await act(async () => { screen!.changeTextByTestId(inputId, 'secret-not-for-renderer'); });
            await waitForAssertion(() => expect(screen!.findByTestId(saveId)?.props.disabled).toBe(false));
        }
        if (presentation === 'advanced-projection') {
            const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
            const { useScopedPluginSettingsProjection } = await import('./domains/plugins/settings/scopedPluginSettingsProjection');
            const params = {
                pluginId: 'acme.settings', scope: { kind: 'account' as const },
                target: { kind: 'account' as const, serverIdentityId },
                accountLifetime: captureActiveServerAccountScopeLifetime(),
                fields: [{ key: 'apiToken', redacted: true }],
                perActiveServerIdentityId: null, enabled: true, adapter: scopedPluginAccountSecretSettingsAdapter,
            };
            await renderHook(() => { secretProjection = useScopedPluginSettingsProjection(params); });
            await waitForAssertion(() => expect(secretProjection?.state.ready).toBe(true));
            await act(async () => { secretProjection!.setDraft('apiToken', 'secret-not-for-renderer'); });
        }
        const write = presentation === 'advanced-ui'
            ? (async () => { await act(async () => { screen!.pressByTestId(saveId); }); return await issued.promise; })()
            : presentation === 'advanced-projection'
            ? secretProjection!.commit({ fieldId: 'apiToken', mutation: { kind: 'set', value: 'secret-not-for-renderer' } })
            : presentation === 'erase-retired' || presentation === 'data-retired' || isCancellation
            ? executeAccountPluginDataEraseAction({ pluginId: 'acme.settings' }, { signal: cancellation.signal })
            : scopedPluginAccountSecretSettingsAdapter.write({
            pluginId: 'acme.settings', scope: { kind: 'account' }, target: { kind: 'account', serverIdentityId },
            fields: [{ key: 'apiToken', redacted: true }], fieldId: 'apiToken',
            mutation: { kind: 'set', value: 'secret-not-for-renderer' },
            expectedRevision: { kind: 'account-secret', value: 5 },
        });
        await Promise.race([
            issued.promise,
            write.then((result) => { throw new Error(`Secret mutation settled before issuing a POST: ${JSON.stringify(result)}; HTTP: ${JSON.stringify(runtimeFetchMock.mock.calls.map(([url]) => url))}`); }),
        ]);
        if (isCancellation) {
            cancellation.abort();
            response.resolve(presentation === 'cancel-before-settings'
                ? Response.json({ content: { t: 'plain', v: baseline }, version: 5 })
                : new Response(null, { status: 404 }));
            const cancelled = await write;
            expect(postPaths).toEqual([]);
            expect(cancelled).toEqual({ status: 'partial',
                settings: { status: 'pending', reason: 'unavailable' },
                data: { status: 'pending', reason: 'unavailable' },
            });
            return;
        }
        const isAdvanced = presentation === 'advanced' || presentation === 'advanced-ui' || presentation === 'advanced-projection';
        const nextScope = !isAdvanced ? { ...scope, accountId: 'account-b' } : scope;
        const nextSettings = settingsParse({ analyticsOptOut: true });
        const publishNewerSettings = () => storage.setState({
            profileScope: nextScope, settingsScope: nextScope, settings: nextSettings, settingsVersion: 20,
        });
        const stopAdvancement = isAdvanced
            ? storage.subscribe((state) => { if (state.settingsVersion === 6) publishNewerSettings(); })
            : () => {};
        onTestFinished(stopAdvancement);
        if (!isAdvanced) {
            storage.setState({ profileScope: nextScope, settingsScope: nextScope });
            storage.getState().applySettingsForScope(nextScope, nextSettings, 20);
            Reflect.set(sync, 'credentials', { token: tokenForSub('account-b') });
            Reflect.set(sync, 'pendingSettingsScope', nextScope);
            retireActiveServerAccountScopeLifetime();
        }
        const persistedAccountB = !isAdvanced ? loadAccountSettings(nextScope) : null;
        if (persistedAccountB) {
            expect(persistedAccountB).toMatchObject({ version: 20, settings: { analyticsOptOut: true } });
        }
        if (outcome === 'outcomeUnknown') response.reject(new Error('acknowledgement lost'));
        else response.resolve(Response.json(presentation === 'data-retired'
            ? { status: 'erased', changed: true }
            : outcome === 'applied'
            ? { success: true, version: 6 }
            : { success: false, error: 'version-mismatch', currentVersion: 6, currentContent: { t: 'plain', v: {} } }));
        const result = await write;
        if (presentation === 'advanced-projection') {
            await waitForAssertion(() => {
                expect(secretProjection!.state.revision).toEqual({ kind: 'account-secret', value: 20 });
                expect(secretProjection!.state.drafts.apiToken).not.toBe('secret-not-for-renderer');
                expect(secretProjection!.state.error).toBeNull();
            });
        }
        if (presentation === 'advanced-ui') {
            await waitForAssertion(() => {
                expect(screen!.findByTestId(inputId)?.props.value).toBe('');
                expect(screen!.findByTestId(saveId)?.props.disabled).toBe(true);
            });
            stopAdvancement();
            expect(postPaths).toEqual(['/v2/account/settings']);
            return;
        }
        stopAdvancement();
        expect(result).toEqual(presentation === 'data-retired'
            ? { status: outcome === 'applied' ? 'completed' : 'partial', settings: { status: 'completed', changed: false },
                data: outcome === 'applied' ? { status: 'completed', changed: true } : { status: 'pending', reason: 'outcome-unknown' } }
            : presentation === 'erase-retired'
            ? { status: 'partial', settings: outcome === 'applied'
                ? { status: 'completed', changed: true } : { status: 'pending', reason: 'outcome-unknown' },
                data: { status: 'pending', reason: 'unavailable' } }
            : outcome === 'applied'
            ? { status: 'applied', revision: { kind: 'account-secret', value: 6 } }
            : { status: outcome });
        expect(postPaths).toEqual([presentation === 'data-retired' ? PLUGIN_ACCOUNT_DATA_ERASE_HTTP_PATH_V1 : '/v2/account/settings']);
        expect(storage.getState().settingsScope).toEqual(nextScope);
        expect(storage.getState().settingsVersion).toBe(20);
        expect(storage.getState().settings).toEqual(nextSettings);
        if (persistedAccountB) expect(loadAccountSettings(nextScope)).toEqual(persistedAccountB);
    });

    it('drops a held hydration response when the captured encryption instance is replaced', async () => {
        const { Encryption } = await import('@/sync/encryption/encryption');
        const { encodeBase64 } = await import('@/encryption/base64');
        const { sealEncryptedDataKeyEnvelopeV1 } = await import('@happier-dev/protocol');
        const { createDeferred } = await import('@/dev/testkit');
        const home = await upsertServerProfile({ serverUrl: 'https://hydration-instance.example.test', name: 'Hydration instance' });
        await setActiveServerId(home.id, { scope: 'device' });
        await applySelectedHomeForSessionListTest({ token: tokenForSub('reader'), secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url') });
        const sessionId = 'hydration-instance';
        const secret = new Uint8Array(32).fill(7);
        const encryption = await Encryption.create(secret);
        const replacement = await Encryption.create(secret);
        const writer = await Encryption.create(secret);
        const sessionKey = new Uint8Array(32).fill(8);
        await writer.initializeSessions(new Map([[sessionId, sessionKey]]));
        const metadata = await writer.getSessionEncryption(sessionId)!.encryptRaw({ path: '/repo', host: 'host' });
        const envelope = sealEncryptedDataKeyEnvelopeV1({
            dataKey: sessionKey, recipientPublicKey: encryption.contentDataKey,
            randomBytes: (length) => new Uint8Array(length).fill(3),
        });
        const requested = createDeferred<void>();
        const response = createDeferred<Response>();
        requestMock.mockImplementation(async () => { requested.resolve(); return response.promise; });
        const { sync } = await import('./sync');
        Reflect.set(sync, 'credentials', { token: tokenForSub('reader'), secret: encodeBase64(secret, 'base64') });
        Reflect.set(sync, 'encryption', encryption);
        const hydration = sync.ensureSessionVisibleForMessageRoute(sessionId, { forceRefresh: true, hydrateMessages: false });
        await requested.promise;
        Reflect.set(sync, 'encryption', replacement);
        response.resolve(Response.json({ session: {
            id: sessionId, seq: 1, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
            encryptionMode: 'e2ee', dataEncryptionKey: encodeBase64(envelope, 'base64'),
            metadata, metadataVersion: 1, agentState: null, agentStateVersion: 0, share: null,
        } }));
        const result = await hydration;
        expect(result.kind).not.toBe('available');
        expect(replacement.getSessionEncryption(sessionId)).toBeNull();
        expect(storage.getState().sessions[sessionId]).toBeUndefined();
    });

    it.each(['current', 'account_changed', 'home_changed', 'generation_changed', 'cipher_replaced'] as const)(
        'applies transcript authentication failure only to its current Account and Session cipher (%s)',
        async (change) => {
            const { Encryption } = await import('@/sync/encryption/encryption');
            const { encodeBase64 } = await import('@/encryption/base64');
            const { createDeferred } = await import('@/dev/testkit');
            const home = await upsertServerProfile({ serverUrl: 'https://content-failure.example.test', name: 'Content failure' });
            await setActiveServerId(home.id, { scope: 'device' });
            await applySelectedHomeForSessionListTest({ token: tokenForSub('reader'), secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url') });
            const scope = { serverId: home.id, accountId: 'reader' };
            storage.setState({ profileScope: scope });
            const sessionId = 'content-failure';
            const secret = new Uint8Array(32).fill(7);
            const { captureServerRequestAuthorityForServerAccountScope } = await import('./runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope');
            const { apiSocket } = await import('./api/session/apiSocket');
            const authority = await captureServerRequestAuthorityForServerAccountScope({
                scope,
                activeRequest: apiSocket.request,
            });
            onTestFinished(authority.release);
            const encryption = authority.context.encryption;
            if (!encryption) throw new Error('Expected the captured Account encryption fixture.');
            const wrongWriter = await Encryption.create(secret);
            await encryption.initializeSessions(new Map([[sessionId, new Uint8Array(32).fill(8)]]));
            await wrongWriter.initializeSessions(new Map([[sessionId, new Uint8Array(32).fill(9)]]));
            const ciphertext = await wrongWriter.getSessionEncryption(sessionId)!.encryptRaw({
                role: 'user', content: { type: 'text', text: 'unreadable' },
            });
            const validCiphertext = await encryption.getSessionEncryption(sessionId)!.encryptRaw({
                role: 'user', content: { type: 'text', text: 'valid row' },
            });
            const credentials = { token: tokenForSub('reader'), secret: encodeBase64(secret, 'base64') };
            const response = createDeferred<Response>();
            const requested = createDeferred<void>();
            const defaultFetch = runtimeFetchMock.getMockImplementation()!;
            runtimeFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
                const requestUrl = new URL(url);
                if (requestUrl.origin === new URL(home.serverUrl).origin && requestUrl.pathname === `/v1/sessions/${sessionId}/messages`) {
                    requested.resolve();
                    return response.promise;
                }
                return defaultFetch(url, init);
            });
            const { sync } = await import('./syncEngine');
            Reflect.set(sync, 'credentials', credentials);
            Reflect.set(sync, 'encryption', encryption);
            storage.getState().applySessions([{
                ...createSession({ sessionId }), serverId: home.id,
                encryptedContentAvailability: 'ready',
            }]);

            const refresh = sync.refreshSessionMessages(sessionId, { authority });
            await requested.promise;
            if (change === 'account_changed') {
                storage.setState({ profileScope: { ...scope, accountId: 'replacement' } });
            } else if (change === 'home_changed') {
                const replacement = await upsertServerProfile({ serverUrl: 'https://replacement.example.test', name: 'Replacement' });
                await setActiveServerId(replacement.id, { scope: 'device' });
                // Selection alone stages a Home. Apply its real Account lifetime
                // and current same-id shell before releasing the old Home's page.
                await applySelectedHomeForSessionListTest({ token: tokenForSub('replacement'), secret: encodeBase64(secret, 'base64url') });
                const replacementEncryption = Reflect.get(sync, 'encryption') as Encryption;
                await replacementEncryption.initializeSessions(new Map([[sessionId, new Uint8Array(32).fill(10)]]));
                storage.getState().applySessions([{
                    ...createSession({ sessionId, serverId: replacement.id }),
                    encryptedContentAvailability: 'ready',
                }]);
            } else if (change === 'generation_changed') {
                Reflect.set(sync, 'serverScopeGeneration', Number(Reflect.get(sync, 'serverScopeGeneration')) + 1);
            } else if (change === 'cipher_replaced') {
                await encryption.initializeSessions(new Map([[sessionId, new Uint8Array(32).fill(10)]]));
            }
            response.resolve(Response.json({ messages: [{
                id: 'unreadable-row', seq: 1, localId: null, createdAt: 1, updatedAt: 1,
                content: { t: 'encrypted', c: ciphertext },
            }, {
                id: 'valid-row', seq: 2, localId: null, createdAt: 2, updatedAt: 2,
                content: { t: 'encrypted', c: validCiphertext },
            }] }));
            if (change === 'current') {
                await expect(refresh).rejects.toMatchObject({ name: 'SessionMessagePageDecryptionError' });
            } else {
                await refresh;
            }

            expect(storage.getState().sessions[sessionId]?.encryptedContentAvailability).toBe(
                change === 'current' ? 'encrypted_content_unavailable' : 'ready',
            );
            expect(Object.values(storage.getState().sessionMessages[sessionId]?.messagesById ?? {})).toHaveLength(change === 'current' ? 1 : 0);
        },
    );

    it('preserves metadata omissions in mixed and empty canonical Home awareness pages without transcript acquisition', async () => {
        const home = await upsertServerProfile({ serverUrl: 'https://awareness.example.test', name: 'Awareness' });
        await setActiveServerId(home.id, { scope: 'device' });
        await applySelectedHomeForSessionListTest();
        const otherHomeId = 'other-awareness-home';
        storage.setState((state) => ({
            ...state,
            sessionListRowsByServerId: {
                [otherHomeId]: {
                    'page-awareness': {
                        id: 'page-awareness', updatedAt: 1, active: true, presence: null,
                        metadata: { summaryText: 'Same Session id on another Home' },
                    },
                },
            },
            ordinarySessionListMembershipByServerId: {
                [home.id]: ['ordinary-member'],
                [otherHomeId]: ['page-awareness'],
            },
            archivedSessionListMembershipByServerId: {
                [home.id]: ['archived-member'],
                [otherHomeId]: [],
            },
            sessionListIndexByServerId: {
                [home.id]: [{ type: 'session', sessionId: 'ordinary-member', serverId: home.id, serverName: 'Awareness' }],
                [otherHomeId]: [{ type: 'session', sessionId: 'page-awareness', serverId: otherHomeId, serverName: 'Other Awareness' }],
            },
        }) as never);
        const membershipBefore = {
            ordinary: storage.getState().ordinarySessionListMembershipByServerId,
            archived: storage.getState().archivedSessionListMembershipByServerId,
            index: storage.getState().sessionListIndexByServerId,
        };
        const { sync } = await import('./sync');
        Reflect.set(sync, 'credentials', { token: tokenForSub('account-a'), secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url') });
        requestMock.mockImplementation(async (_path, init) => {
            const requestBody = JSON.parse(String(init?.body ?? '{}')) as { cursor?: string; attentionCursor?: string };
            return new Response(JSON.stringify({
                sessions: requestBody.cursor || requestBody.attentionCursor ? [] : [{
                id: 'page-awareness', createdAt: 1, updatedAt: 2, seq: 3,
                active: false, activeAt: 2, encryptionMode: 'plain', dataEncryptionKey: null,
                metadataVersion: 0, metadata: JSON.stringify({ path: '/repo', host: 'host' }),
                agentStateVersion: 0, agentState: null, share: null,
                latestTurnStatus: 'failed', latestTurnStatusObservedAt: 2,
                effectiveAccess: {
                    v: 1, level: 'owner', sources: [{ kind: 'owner' }],
                    capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'owner' }),
                },
                viewer: {
                    readState: { state: 'not_started' },
                    relevance: { relevant: true, reasons: ['owned_by_me'] },
                    attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' },
                    follow: { follows: false, notificationLevel: null },
                    notification: { level: 'none', source: 'none' },
                },
                responsibleAccountId: null, responsibleAccount: null,
                }],
                nextCursor: requestBody.cursor || requestBody.attentionCursor ? null : 'cursor-next',
                hasNext: !requestBody.cursor && !requestBody.attentionCursor,
                attentionNextCursor: 'cursor-attention-next', attentionHasNext: true,
                // Only the ordinary page withheld a row. The supplemental family
                // stays incomplete but must not duplicate that fixture observation.
                ...(requestBody.attentionCursor ? {} : { metadataUpgradeRequiredCount: 1 }),
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        });
        const { listSessionsForVoiceTool } = await import('@/voice/tools/actionImpl/sessionList');
        const query = {
            v: 1 as const,
            storage: 'active' as const,
            includeInactive: false,
            scope: 'my_work' as const,
            attention: 'needs_my_attention' as const,
            includeAttention: true,
            audiences: [],
            tagIds: [],
            limit: 7,
        };
        const result = await listSessionsForVoiceTool({ view: 'awareness', serverId: home.id, query });
        const continuedResult = await listSessionsForVoiceTool({
            view: 'awareness', serverId: home.id, query, cursor: 'cursor-next',
        });
        expect(storage.getState().sessionListRowsByServerId).toEqual(expect.objectContaining({
            [home.id]: expect.objectContaining({ 'page-awareness': expect.anything() }),
            [otherHomeId]: expect.objectContaining({
                'page-awareness': expect.objectContaining({
                    metadata: { summaryText: 'Same Session id on another Home' },
                }),
            }),
        }));
        expect({
            ordinary: storage.getState().ordinarySessionListMembershipByServerId,
            archived: storage.getState().archivedSessionListMembershipByServerId,
            index: storage.getState().sessionListIndexByServerId,
        }).toEqual(membershipBefore);
        expect(result).toMatchObject({
            view: 'awareness', projectionVersion: 1, nextCursor: 'cursor-next', hasNext: true,
            attentionNextCursor: 'cursor-attention-next', attentionHasNext: true,
            metadataUpgradeRequiredCount: 1,
            sessions: [{ sessionId: 'page-awareness', lifecycle: 'failed' }],
        });
        expect(continuedResult).toMatchObject({
            view: 'awareness', projectionVersion: 1, nextCursor: null, hasNext: false,
            attentionNextCursor: 'cursor-attention-next', attentionHasNext: true,
            metadataUpgradeRequiredCount: 1,
            sessions: [],
        });
        expect(SessionAwarenessListResultV1Schema.parse(result)).toEqual(result);
        expect(SessionAwarenessListResultV1Schema.parse(continuedResult)).toEqual(continuedResult);
        expect(Object.keys(result).sort()).toEqual([
            'attentionHasNext', 'attentionNextCursor', 'hasNext', 'metadataUpgradeRequiredCount', 'nextCursor', 'projectionVersion', 'sessions', 'view',
        ]);
        expect(requestMock.mock.calls.every(([path]) => !String(path).includes('/messages') && !String(path).includes('/turns'))).toBe(true);
        expect(requestMock).toHaveBeenCalledWith('/v2/sessions/query', expect.objectContaining({
            method: 'POST',
            body: JSON.stringify(query),
        }));
    });

    it('Voice semantic discovery preserves metadata omissions through its marked awareness Action result', async () => {
        const home = await upsertServerProfile({ serverUrl: 'https://voice-awareness.example.test', name: 'Voice Awareness' });
        await setActiveServerId(home.id, { scope: 'device' });
        await applySelectedHomeForSessionListTest({ token: tokenForSub('awareness-account') });
        storage.setState((state) => ({ settings: { ...state.settings, experiments: true, featureToggles: { ...state.settings.featureToggles, voice: true } } }));
        const { sync } = await import('./sync');
        Reflect.set(sync, 'credentials', { token: tokenForSub('awareness-account'), secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url') });
        // Voice dispatches through the shared Action executor, which captures a real Home/Account
        // authority first. Supply that authority rather than relaxing it.
        runtimeFetchMock.mockImplementation(async (url: string) => {
            const path = new URL(url).pathname;
            if (path === '/v1/auth/ping') return Response.json({ success: true });
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (path === '/v1/account/encryption/currentness') return Response.json({ mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 });
            if (path.startsWith('/v2/sessions')) return requestMock(path);
            return new Response(null, { status: 404 });
        });
        requestMock.mockImplementation(async () => new Response(JSON.stringify({
            sessions: [{
                id: 'voice-awareness', createdAt: 1, updatedAt: 2, seq: 3,
                active: false, activeAt: 2, encryptionMode: 'plain', dataEncryptionKey: null,
                metadataVersion: 0, metadata: JSON.stringify({ path: '/repo', host: 'host' }),
                agentStateVersion: 0, agentState: null, share: null,
                latestTurnStatus: 'failed', latestTurnStatusObservedAt: 2,
            }], nextCursor: null, hasNext: false, metadataUpgradeRequiredCount: 1,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        const { createVoiceToolHandlers } = await import('@/voice/tools/handlers');
        const handlers = createVoiceToolHandlers({ resolveSessionId: () => null });
        const result = JSON.parse(await handlers.listSessions({ limit: 7 }));
        expect(result).toMatchObject({
            ok: true,
            view: 'awareness', projectionVersion: 1, nextCursor: null, hasNext: false,
            metadataUpgradeRequiredCount: 1,
            sessions: [{ sessionId: 'voice-awareness', lifecycle: 'failed', address: { serverId: home.id, sessionId: 'voice-awareness' } }],
        });
        storage.setState({ socketStatus: 'connected' });
        const { acquireAdmittedSessionReferenceCorpusOptions } = await import('@/voice/tools/actionImpl/admittedSessionReferenceCorpus');
        const corpus = await acquireAdmittedSessionReferenceCorpusOptions(storage.getState());
        expect(corpus).toMatchObject({
            knownServerIds: [home.id],
            coverage: 'incomplete',
            addresses: [{ serverId: home.id, sessionId: 'voice-awareness' }],
        });
    });

    it('preserves metadata omissions and permitted retained previews for a summary query', async () => {
        const home = await upsertServerProfile({ serverUrl: 'https://summary-query.example.test', name: 'Summary Query' });
        await setActiveServerId(home.id, { scope: 'device' });
        await applySelectedHomeForSessionListTest();
        const { sync } = await import('./sync');
        Reflect.set(sync, 'credentials', { token: tokenForSub('account-a'), secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url') });
        storage.setState((state) => ({
            settings: { ...state.settings, voice: { ...state.settings.voice, privacy: { ...state.settings.voice.privacy, shareRecentMessages: true } } },
            sessionMessages: { ...state.sessionMessages, 'query-summary': { messages: [{ id: 'm1', kind: 'user-text', text: 'Retained preview', createdAt: 10 }] } },
        }) as never);
        requestMock.mockImplementation(async () => new Response(JSON.stringify({
            sessions: [{
                id: 'query-summary', createdAt: 1, updatedAt: 2, seq: 3,
                active: false, activeAt: 2, encryptionMode: 'plain', dataEncryptionKey: null,
                metadataVersion: 0, metadata: JSON.stringify({ path: '/repo', host: 'host' }),
                agentStateVersion: 0, agentState: null, share: null,
                effectiveAccess: {
                    v: 1, level: 'owner', sources: [{ kind: 'owner' }],
                    capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'owner' }),
                },
                viewer: {
                    readState: { state: 'not_started' },
                    relevance: { relevant: true, reasons: ['owned_by_me'] },
                    attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' },
                    follow: { follows: false, notificationLevel: null },
                    notification: { level: 'none', source: 'none' },
                },
                responsibleAccountId: null, responsibleAccount: null,
            }], nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
            metadataUpgradeRequiredCount: 1,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        const { listSessionsForVoiceTool } = await import('@/voice/tools/actionImpl/sessionList');
        const result = await listSessionsForVoiceTool({
            view: 'summary', serverId: home.id, includeLastMessagePreview: true,
            query: { v: 1, storage: 'active', includeInactive: false, scope: 'all_accessible', attention: 'any', audiences: [], tagIds: [] },
        });
        expect(result).toMatchObject({
            ok: true,
            queryVersion: 1,
            nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
            metadataUpgradeRequiredCount: 1,
            sessions: [{ id: 'query-summary', lastMessagePreview: { text: 'Retained preview' } }],
        });
    });

    it('preserves metadata omissions from the ordinary lifecycle in a retained summary and clears them after refresh', async () => {
        const home = await upsertServerProfile({ serverUrl: 'https://retained-summary.example.test', name: 'Retained Summary' });
        await setActiveServerId(home.id, { scope: 'device' });
        await applySelectedHomeForSessionListTest();
        const { sync } = await import('./sync');
        Reflect.set(sync, 'credentials', { token: tokenForSub('account-a') });
        let withheld = true;
        requestMock.mockImplementation(async (path: string) => Response.json({
            sessions: [], nextCursor: null, hasNext: false,
            ...(withheld && !path.startsWith('/v2/sessions/active') ? { metadataUpgradeRequiredCount: 1 } : {}),
        }));
        const { listSessionsForVoiceTool } = await import('@/voice/tools/actionImpl/sessionList');
        await sync.refreshSessions({ awaitSessionListHydration: true });

        const withheldResult = await listSessionsForVoiceTool({});
        expect(withheldResult).toMatchObject({ ok: true, sessions: [], nextCursor: null, metadataUpgradeRequiredCount: 1 });
        expect(sync.readOrdinarySessionListCoverage()).toEqual({ serverId: home.id, coverage: 'incomplete' });

        withheld = false;
        await sync.refreshSessions({ awaitSessionListHydration: true });
        const refreshedResult = await listSessionsForVoiceTool({});
        expect(refreshedResult).toMatchObject({ ok: true, sessions: [], nextCursor: null });
        expect(refreshedResult).not.toHaveProperty('metadataUpgradeRequiredCount');
        expect(sync.readOrdinarySessionListCoverage()).toEqual({ serverId: home.id, coverage: 'complete' });
    });

    it('serves uncached activity through exact Home acquisition without reading turns', async () => {
        const home = await upsertServerProfile({ serverUrl: 'https://awareness.example.test', name: 'Awareness' });
        await setActiveServerId(home.id, { scope: 'device' });
        await applySelectedHomeForSessionListTest();
        const { sync } = await import('./sync');
        Reflect.set(sync, 'credentials', { token: tokenForSub('account-a'), secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url') });
        // Both reads acquire for themselves, so each needs its own response body: one shared
        // `Response` instance is consumed by the first read and fails the second as malformed.
        requestMock.mockImplementation(async () => new Response(JSON.stringify({ session: {
            id: 'uncached-awareness', createdAt: 1, updatedAt: 2, seq: 3,
            active: false, activeAt: 2, encryptionMode: 'plain', dataEncryptionKey: null,
            metadataVersion: 0, metadata: JSON.stringify({ path: '/repo', host: 'host' }),
            agentStateVersion: 0, agentState: null, share: null,
            latestTurnStatus: 'failed', latestTurnStatusObservedAt: 2,
        } }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        const { getSessionActivityForVoiceTool } = await import('@/voice/tools/actionImpl/sessionActivity');
        const result = await getSessionActivityForVoiceTool({ sessionId: 'uncached-awareness', serverId: home.id });
        const explicitSummary = await getSessionActivityForVoiceTool({
            sessionId: 'uncached-awareness', serverId: home.id, view: 'summary',
        });
        expect(result).toMatchObject({ ok: true, sessionId: 'uncached-awareness', working: false });
        expect(explicitSummary).toEqual(result);
        expect(requestMock.mock.calls.map(([path]) => path)).toEqual([
            '/v2/sessions/uncached-awareness',
            '/v2/sessions/uncached-awareness',
        ]);
        expect(result).not.toHaveProperty('messageCounts');
    });

    it('returns the canonical marked awareness projection when activity explicitly requests it', async () => {
        const home = await upsertServerProfile({ serverUrl: 'https://activity-awareness-view.example.test', name: 'Activity Awareness View' });
        await setActiveServerId(home.id, { scope: 'device' });
        await applySelectedHomeForSessionListTest({ token: tokenForSub('awareness-account') });
        const { sync } = await import('./sync');
        Reflect.set(sync, 'credentials', { token: tokenForSub('awareness-account'), secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url') });
        // The shared Action executor captures a real Home/Account authority before it dispatches.
        // Supply that authority instead of relaxing it, so this exercises the production path.
        runtimeFetchMock.mockImplementation(async (url: string) => {
            const path = new URL(url).pathname;
            if (path === '/v1/auth/ping') return Response.json({ success: true });
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (path === '/v1/account/encryption/currentness') return Response.json({ mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 });
            if (path.startsWith('/v2/sessions')) return requestMock(path);
            return new Response(null, { status: 404 });
        });
        requestMock.mockResolvedValue(new Response(JSON.stringify({ session: {
            id: 'activity-awareness-view', createdAt: 1, updatedAt: 2, seq: 3,
            active: false, activeAt: 2, encryptionMode: 'plain', dataEncryptionKey: null,
            metadataVersion: 0, metadata: JSON.stringify({ path: '/repo', host: 'host' }),
            agentStateVersion: 0, agentState: null, share: null,
            latestTurnStatus: 'failed', latestTurnStatusObservedAt: 2,
        } }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');

        const execution = await createDefaultActionExecutor().execute('session.activity.get', {
            sessionId: 'activity-awareness-view', view: 'awareness',
        }, { surface: 'ui', serverId: home.id });

        expect(execution).toMatchObject({
            ok: true,
            result: {
                v: 1,
                sessionId: 'activity-awareness-view',
                lifecycle: 'failed',
            },
        });
        expect(execution.ok && execution.result).not.toHaveProperty('ok');
        expect(execution.ok && execution.result).not.toHaveProperty('messageCounts');
        expect(requestMock.mock.calls.map(([path]) => path)).toEqual(['/v2/sessions/activity-awareness-view']);
    });

    it('refuses an unqualified activity read when the session id exists on more than one known Home', async () => {
        const homeA = await upsertServerProfile({ serverUrl: 'https://activity-home-a.example.test', name: 'Activity Home A' });
        const homeB = await upsertServerProfile({ serverUrl: 'https://activity-home-b.example.test', name: 'Activity Home B' });
        await setActiveServerId(homeA.id, { scope: 'device' });
        await applySelectedHomeForSessionListTest();
        storage.setState(() => ({
            ordinarySessionListMembershipByServerId: {
                [homeA.id]: ['shared-activity'],
                [homeB.id]: ['shared-activity'],
            },
        }) as never);
        const { getSessionActivityForVoiceTool } = await import('@/voice/tools/actionImpl/sessionActivity');

        // Ambiguity is settled before acquisition: the focused Home is never substituted for the
        // Home the caller failed to qualify, and nothing is read from either Home.
        await expect(getSessionActivityForVoiceTool({ sessionId: 'shared-activity' })).resolves.toEqual({
            ok: false, errorCode: 'session_ambiguous', errorMessage: 'session_ambiguous', sessionId: 'shared-activity',
        });
        expect(requestMock).not.toHaveBeenCalled();
    });

    it('omits permission identities when exact-Home activity observes only pending counts', async () => {
        const home = await upsertServerProfile({ serverUrl: 'https://awareness-counts.example.test', name: 'Awareness Counts' });
        await setActiveServerId(home.id, { scope: 'device' });
        await applySelectedHomeForSessionListTest();
        const { sync } = await import('./sync');
        Reflect.set(sync, 'credentials', { token: tokenForSub('account-a'), secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url') });
        storage.setState((state) => ({
            settings: { ...state.settings, voice: { ...state.settings.voice, privacy: {
                ...state.settings.voice.privacy, sharePermissionRequests: true,
            } } },
        }) as never);
        const now = Date.now();
        requestMock.mockResolvedValue(new Response(JSON.stringify({ session: {
            id: 'counts-only-awareness', createdAt: 1, updatedAt: now, seq: 3,
            active: true, activeAt: now, encryptionMode: 'plain', dataEncryptionKey: null,
            metadataVersion: 0, metadata: JSON.stringify({ path: '/repo', host: 'host' }),
            agentStateVersion: 0, agentState: null, share: null,
            pendingPermissionRequestCount: 1, pendingUserActionRequestCount: 0,
            pendingRequestObservedAt: now,
        } }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

        const { getSessionActivityForVoiceTool } = await import('@/voice/tools/actionImpl/sessionActivity');
        const result = await getSessionActivityForVoiceTool({ sessionId: 'counts-only-awareness', serverId: home.id });

        expect(result).toMatchObject({ ok: true, permissionRequired: true, blocked: true });
        expect(result).not.toHaveProperty('permissionRequestIds');
    });

    it('keeps retained-window counts ancillary to acquired activity', async () => {
        const home = await upsertServerProfile({ serverUrl: 'https://retained-awareness.example.test', name: 'Retained Awareness' });
        await setActiveServerId(home.id, { scope: 'device' });
        await applySelectedHomeForSessionListTest();
        const { sync } = await import('./sync');
        Reflect.set(sync, 'credentials', { token: tokenForSub('account-a'), secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url') });
        requestMock.mockImplementation(async () => new Response(JSON.stringify({ session: {
            id: 'retained-awareness', createdAt: 1, updatedAt: 2, seq: 3,
            active: false, activeAt: 2, encryptionMode: 'plain', dataEncryptionKey: null,
            metadataVersion: 0, metadata: JSON.stringify({ path: '/repo', host: 'host' }),
            agentStateVersion: 0, agentState: null, share: null,
            latestTurnStatus: 'failed', latestTurnStatusObservedAt: 2,
        } }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        const { getSessionActivityForVoiceTool } = await import('@/voice/tools/actionImpl/sessionActivity');
        const before = await getSessionActivityForVoiceTool({ sessionId: 'retained-awareness', serverId: home.id });
        expect(before).toMatchObject({ ok: true });
        const messages: Message[] = [
            { id: 'm1', kind: 'user-text', text: 'Hi', localId: null, createdAt: 1 },
            { id: 'm2', kind: 'agent-text', text: 'Hello', localId: null, createdAt: 2 },
        ];
        const messagesById = Object.fromEntries(messages.map((message) => [message.id, message]));
        storage.setState((state) => ({ sessionMessages: { ...state.sessionMessages, 'retained-awareness': {
            messageIdsOldestFirst: messages.map((message) => message.id), messagesById, messagesMap: messagesById,
            reducerState: createReducer(), latestThinkingMessageId: null, latestThinkingMessageActivityAtMs: null,
            messagesVersion: 0, isLoaded: true,
        } } }));
        const retained = await getSessionActivityForVoiceTool({ sessionId: 'retained-awareness', serverId: home.id });
        expect(retained).toMatchObject({ ...before, messageCounts: { total: 2, user: 1, assistant: 1 } });
    });

    it('bounds the retained-window counts by the requested activity window', async () => {
        const home = await upsertServerProfile({ serverUrl: 'https://windowed-awareness.example.test', name: 'Windowed Awareness' });
        await setActiveServerId(home.id, { scope: 'device' });
        await applySelectedHomeForSessionListTest();
        const { sync } = await import('./sync');
        Reflect.set(sync, 'credentials', { token: tokenForSub('account-a'), secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url') });
        requestMock.mockImplementation(async () => new Response(JSON.stringify({ session: {
            id: 'windowed-awareness', createdAt: 1, updatedAt: 2, seq: 3,
            active: false, activeAt: 2, encryptionMode: 'plain', dataEncryptionKey: null,
            metadataVersion: 0, metadata: JSON.stringify({ path: '/repo', host: 'host' }),
            agentStateVersion: 0, agentState: null, share: null,
        } }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        const now = Date.now();
        const messages: Message[] = [
            { id: 'm1', kind: 'user-text', text: 'An hour ago', localId: null, createdAt: now - 3_600_000 },
            { id: 'm2', kind: 'agent-text', text: 'Just now', localId: null, createdAt: now },
        ];
        const messagesById = Object.fromEntries(messages.map((message) => [message.id, message]));
        storage.setState((state) => ({ sessionMessages: { ...state.sessionMessages, 'windowed-awareness': {
            messageIdsOldestFirst: messages.map((message) => message.id), messagesById, messagesMap: messagesById,
            reducerState: createReducer(), latestThinkingMessageId: null, latestThinkingMessageActivityAtMs: null,
            messagesVersion: 0, isLoaded: true,
        } } }));
        const { getSessionActivityForVoiceTool } = await import('@/voice/tools/actionImpl/sessionActivity');

        // The released field counts what this host retains. `windowSeconds` narrows that same
        // retained window rather than being accepted and ignored, and never fetches history.
        const windowed = await getSessionActivityForVoiceTool({
            sessionId: 'windowed-awareness', serverId: home.id, windowSeconds: 60,
        });
        expect(windowed).toMatchObject({ messageCounts: { total: 1, user: 0, assistant: 1 } });

        const unbounded = await getSessionActivityForVoiceTool({ sessionId: 'windowed-awareness', serverId: home.id });
        expect(unbounded).toMatchObject({ messageCounts: { total: 2, user: 1, assistant: 1 } });
    });

    it('preserves malformed acquisition errors in the activity Action', async () => {
        const home = await upsertServerProfile({ serverUrl: 'https://awareness.example.test', name: 'Awareness' });
        await setActiveServerId(home.id, { scope: 'device' });
        await applySelectedHomeForSessionListTest();
        const { sync } = await import('./sync');
        Reflect.set(sync, 'credentials', { token: tokenForSub('account-a'), secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url') });
        requestMock.mockImplementation(async () => new Response('{}', {
            status: 200, headers: { 'Content-Type': 'application/json' },
        }));
        const { getSessionActivityForVoiceTool } = await import('@/voice/tools/actionImpl/sessionActivity');
        await expect(getSessionActivityForVoiceTool({ sessionId: 'malformed-awareness', serverId: home.id }))
            .resolves.toMatchObject({ ok: false, errorCode: 'invalid_response' });
    });

    it('settles caller cancellation while shared activity hydration remains pending', async () => {
        const home = await upsertServerProfile({ serverUrl: 'https://cancel-awareness.example.test', name: 'Cancel Awareness' });
        await setActiveServerId(home.id, { scope: 'device' });
        await applySelectedHomeForSessionListTest();
        const { sync } = await import('./sync');
        Reflect.set(sync, 'credentials', { token: tokenForSub('account-a'), secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url') });
        let finishRequest!: (response: Response) => void;
        requestMock.mockImplementation(() => new Promise<Response>((resolve) => { finishRequest = resolve; }));
        const { getSessionActivityForVoiceTool } = await import('@/voice/tools/actionImpl/sessionActivity');
        const controller = new AbortController();
        const result = getSessionActivityForVoiceTool({ sessionId: 'cancel-awareness', serverId: home.id, signal: controller.signal });
        await waitForAssertion(() => expect(requestMock).toHaveBeenCalled());
        controller.abort();
        try {
            const settlement = await Promise.race([result, new Promise((resolve) => setTimeout(() => resolve('still_pending'), 50))]);
            expect(settlement).toMatchObject({ ok: false, errorCode: 'tool_cancelled' });
        } finally {
            requestMock.mockImplementation(async () => new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }));
            finishRequest(new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }));
            await result;
        }
    });

    beforeEach(async () => {
        storage.setState(initialStorageState, true);
        kvStore.clear();
        appStateAddListener.mockClear();
        requestMock.mockReset();
        runtimeFetchMock.mockReset();
        runtimeFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
            const target = new URL(url);
            if (target.pathname === '/v1/auth/ping') return Response.json({ success: true });
            if (target.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (target.pathname === '/v1/account/encryption/currentness') return Response.json({
                mode: 'plain', version: 1, updatedAt: 0, signingKeyFingerprint: null, contentKeyFingerprint: null,
            });
            if (target.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 0 });
            // The route spy owns Session HTTP; unrelated real restore readers use
            // the same network boundary without contaminating route assertions.
            if (!/^\/v[12]\/sessions(?:\/|$)/.test(target.pathname)) return new Response('{}', { status: 404 });
            const response = await requestMock(target.pathname + target.search, init);
            if (response) return response;
            if (target.pathname === '/v2/sessions' || target.pathname === '/v2/sessions/active') return Response.json({ sessions: [], nextCursor: null, hasNext: false });
            if (target.pathname === '/v2/sessions/metadata-upgrades') return Response.json({ sessionIds: [] });
            return new Response('{}', { status: 404 });
        });
        resetSessionSurfaceVisibilityForTests();

        await loadSyncSingletonForTests();
        const { sync } = await import('./sync');
        sync.disconnectServer();
        await applySelectedHomeForSessionListTest();
    });

    it('keeps a wake reconciliation open until its real message hydration completes', async () => {
        const sessionId = 'await_muted_wake_messages';
        const home = await upsertServerProfile({ serverUrl: 'https://wake.example', name: 'Wake Home' });
        await setActiveServerId(home.id, { scope: 'device' });
        await applySelectedHomeForSessionListTest();
        const { sync } = await import('./sync');
        const { Encryption } = await import('./encryption/encryption');
        Reflect.set(sync, 'credentials', { token: tokenForSub('account-a') });
        Reflect.set(sync, 'encryption', await Encryption.create(new Uint8Array(32).fill(7)));
        Reflect.set(sync, 'messagesSync', new Map());
        let releaseMessages!: (value: Response) => void;
        const messages = new Promise<Response>((resolve) => { releaseMessages = resolve; });
        let messageRequestStarted = false;
        requestMock.mockImplementation(async (path: string) => {
            if (path === `/v2/sessions/${sessionId}`) return new Response(JSON.stringify({ session: {
                id: sessionId, createdAt: 1, updatedAt: 2, seq: 1, active: false, activeAt: 2,
                encryptionMode: 'plain', dataEncryptionKey: null, metadataVersion: 0, metadata: 'null',
                agentStateVersion: 0, agentState: null, share: null,
            } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            messageRequestStarted = true;
            return messages;
        });
        let settled = false;
        const hydration = sync.ensureSessionVisibleForMessageRoute(sessionId, {
            forceRefresh: true, hydrateMessages: true, awaitMessageHydration: true,
        }).then((result) => { settled = true; return result; });
        try {
            await vi.waitFor(() => expect(messageRequestStarted).toBe(true));
            expect(settled).toBe(false);
        } finally {
            releaseMessages(new Response(JSON.stringify({ messages: [], hasMore: false, nextBeforeSeq: null }),
                { status: 200, headers: { 'Content-Type': 'application/json' } }));
            await hydration;
        }
        expect(settled).toBe(true);
        expect(storage.getState().sessionMessages[sessionId]?.isLoaded).toBe(true);
    });

    it('clears server-scoped session-list row/index caches on disconnect', async () => {
        const { upsertAndActivateServer, getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        await upsertAndActivateServer({ serverUrl: 'https://server-a.example.test', scope: 'tab' });
        await applySelectedHomeForSessionListTest();
        const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
        expect(activeServerId).toBeTruthy();

        const cachedSession = createSession({ sessionId: 's_cached_1' });
        storage.getState().applySessions([{ ...cachedSession, serverId: activeServerId }]);
        const { buildSessionListRenderableFromSession } = await import('@/sync/domains/session/listing/sessionListRenderable');
        storage.getState().applyServerScopedSessionListRows(activeServerId, [
            buildSessionListRenderableFromSession({ ...cachedSession, serverId: activeServerId }),
        ], { source: 'ordinary', mode: 'append' });
        expect(storage.getState().sessionListRowsByServerId?.[activeServerId]).toBeDefined();
        expect(storage.getState().sessionListIndexByServerId?.[activeServerId]).toBeDefined();

        const { sync } = await import('./sync');
        sync.disconnectServer();

        expect(storage.getState().sessionListRowsByServerId?.[activeServerId]).toBeUndefined();
        expect(storage.getState().sessionListIndexByServerId?.[activeServerId]).toBeUndefined();
    });

    it('clears stale transcript array caches on disconnect', async () => {
        const { useSessionMessages } = await import('./domains/state/storage');
        const sessionId = 'cached_transcript_session';
        const messagesById = {
            'm-old': { id: 'm-old', kind: 'user-text', localId: null, createdAt: 1, text: 'cached' } as any,
        };
        storage.setState((state) => ({
            ...state,
            sessionMessages: {
                ...state.sessionMessages,
                [sessionId]: {
                    messageIdsOldestFirst: ['m-old'],
                    messagesById,
                    messagesMap: messagesById,
                    reducerState: {} as any,
                    latestThinkingMessageId: null,
                    latestThinkingMessageActivityAtMs: null,
                    messagesVersion: 1,
                    isLoaded: true,
                },
            },
        }));
        const hook = await renderHook(() => useSessionMessages(sessionId), {
            flushOptions: { cycles: 1, turns: 4 },
        });
        const cached = hook.getCurrent().messages;
        expect(cached).toHaveLength(1);

        const { sync } = await import('./sync');
        await act(async () => {
            sync.disconnectServer();
            storage.getState().resetSessionMessages(sessionId);
        });

        const afterDisconnectReset = (await hook.rerender()).messages;
        expect(hook.getCurrent().isLoaded).toBe(false);
        expect(afterDisconnectReset).toEqual([]);

        await hook.unmount();
    });

    it('keeps the current transcript visible while pinned catch-up refreshes in the background', async () => {
        const sessionId = 'pinned_tail_reset_session';
        storage.getState().applySessions([{ ...createSession({ sessionId }), seq: 100 }]);
        storage.getState().resetSessionMessages(sessionId);

        const transcriptMessagesById = {
            'm-old': { id: 'm-old', kind: 'user-text', localId: null, createdAt: 1, text: 'cached' } as any,
        };
        storage.setState((state) => ({
            ...state,
            sessionMessages: {
                ...state.sessionMessages,
                [sessionId]: {
                    ...(state.sessionMessages[sessionId] as any),
                    messageIdsOldestFirst: ['m-old'],
                    messagesById: transcriptMessagesById,
                    messagesMap: transcriptMessagesById,
                    latestThinkingMessageId: null,
                    latestThinkingMessageActivityAtMs: null,
                    messagesVersion: 1,
                    isLoaded: true,
                },
            },
        }));


        const { sync } = await import('./sync');
        (sync as any).credentials = { token: tokenForSub('account-a') };
        (sync as any).isForeground = true;
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;
        (sync as any).activeServerSessionIds = new Set<string>([sessionId]);
        (sync as any).sessionMaterializedMaxSeqById = { [sessionId]: 1 };
        (sync as any).syncTuning = {
            ...(sync as any).syncTuning,
            messageLargeGapSeq: 1,
            messageMaxIncrementalPagesOnResume: 1,
            messageForceSnapshotOfflineMs: 30 * 60 * 1000,
        };
        const fixture = await createEncryptedSessionFixture(sessionId);
        await fixture.encryption.initializeSessions(new Map([[sessionId, fixture.dataKey]]));
        Reflect.set(sync, 'encryption', fixture.encryption);
        const freshCiphertext = await fixture.encryption.getSessionEncryption(sessionId)!.encryptRaw({
            role: 'agent', content: { type: 'output', data: {
                type: 'user', uuid: 'uuid_fresh_1', parentUuid: null, isSidechain: false,
                message: { role: 'user', content: 'fresh' },
            } }, meta: { source: 'cli' },
        });
        let resolveRequest!: (response: Response) => void;
        const requestPromise = new Promise<Response>((resolve) => {
            resolveRequest = resolve;
        });
        requestMock.mockReturnValueOnce(requestPromise);

        markSessionSurfaceVisible(sessionId);
        const fetchPromise = (sync as any).fetchMessages(sessionId);

        expect(storage.getState().sessionMessages[sessionId]?.messageIdsOldestFirst).toEqual(['m-old']);

        resolveRequest(
            new Response(
                JSON.stringify({
                    messages: [
                        {
                            id: 'm-new',
                            seq: 125,
                            localId: null,
                            content: { t: 'encrypted', c: freshCiphertext },
                            createdAt: 2,
                            updatedAt: 2,
                        },
                    ],
                    hasMore: false,
                    nextBeforeSeq: null,
                    nextAfterSeq: null,
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        );

        try {
            await fetchPromise;

            expect(storage.getState().sessionMessages[sessionId]?.messageIdsOldestFirst).toHaveLength(2);
            expect(storage.getState().sessionMessages[sessionId]?.messageIdsOldestFirst?.[0]).toBe('m-old');
        } finally {
            markSessionSurfaceHidden(sessionId);
        }
    });

    it('persists session materialization progress in the active account/server scope', async () => {
        const scope: AccountSettingsScope = { serverId: 'server-a', accountId: 'account-a' };
        const { sync } = await import('./sync');
        const syncInternals = sync as any;

        syncInternals.pendingSettingsScope = scope;
        syncInternals.sessionMaterializedMaxSeqById = {};
        syncInternals.sessionMaterializedMaxSeqDirty = false;

        syncInternals.markSessionMaterializedMaxSeq('session-a', 7);
        syncInternals.flushSessionMaterializedMaxSeq();

        expect(loadSessionMaterializedMaxSeqById(scope)).toEqual({ 'session-a': 7 });
        expect(loadSessionMaterializedMaxSeqById()).toEqual({});
    });

    it('flushes pending session materialization progress before clearing the account/server scope', async () => {
        const scope: AccountSettingsScope = { serverId: 'server-a', accountId: 'account-a' };
        const { sync } = await import('./sync');
        const syncInternals = sync as any;

        syncInternals.pendingSettingsScope = scope;
        syncInternals.sessionMaterializedMaxSeqById = {};
        syncInternals.sessionMaterializedMaxSeqDirty = false;

        syncInternals.markSessionMaterializedMaxSeq('session-a', 9);
        syncInternals.clearActiveAccountSettingsScope();

        expect(loadSessionMaterializedMaxSeqById(scope)).toEqual({ 'session-a': 9 });
        expect(loadSessionMaterializedMaxSeqById()).toEqual({});
        expect(syncInternals.sessionMaterializedMaxSeqById).toEqual({});
        expect(syncInternals.sessionMaterializedMaxSeqFlushTimer).toBeNull();
    });

    it('resets account settings sync status when clearing the account/server scope', async () => {
        const { sync } = await import('./sync');
        const syncInternals = sync as any;

        storage.getState().setAccountSettingsSyncStatus({
            state: 'failed',
            message: 'stale settings sync failure',
            retryable: true,
            kind: 'network',
            at: 123,
        });

        syncInternals.clearActiveAccountSettingsScope();

        expect(storage.getState().accountSettingsSyncStatus).toEqual({ state: 'idle', lastSyncedAt: null });
    });

    it('flushes old session materialization progress before activating a new account/server scope', async () => {
        const { upsertAndActivateServer, getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        await upsertAndActivateServer({ serverUrl: 'https://server-a.example.test', scope: 'tab' });
        await applySelectedHomeForSessionListTest();
        const serverId = String(getActiveServerSnapshot().serverId ?? '').trim();
        expect(serverId).toBeTruthy();

        const oldScope: AccountSettingsScope = { serverId, accountId: 'account-a' };
        const { sync } = await import('./sync');
        const syncInternals = sync as any;

        syncInternals.pendingSettingsScope = oldScope;
        syncInternals.sessionMaterializedMaxSeqById = {};
        syncInternals.sessionMaterializedMaxSeqDirty = false;

        syncInternals.markSessionMaterializedMaxSeq('session-a', 11);
        await syncInternals.activateAccountSettingsScope('account-b');

        expect(loadSessionMaterializedMaxSeqById(oldScope)).toEqual({ 'session-a': 11 });
        expect(syncInternals.pendingSettingsScope).toEqual({ serverId, accountId: 'account-b' });
        expect(syncInternals.sessionMaterializedMaxSeqById).toEqual({});
        expect(syncInternals.sessionMaterializedMaxSeqFlushTimer).toBeNull();
    });

    it('resets stale account settings sync status when activating a new account/server scope', async () => {
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        await upsertAndActivateServer({ serverUrl: 'https://server-a.example.test', scope: 'tab' });
        await applySelectedHomeForSessionListTest();
        const { sync } = await import('./sync');
        const syncInternals = sync as any;

        storage.getState().setAccountSettingsSyncStatus({
            state: 'retrying',
            message: 'previous scope retry',
            retryable: true,
            kind: 'server',
            at: 123,
            failuresCount: 2,
            nextRetryAt: 456,
        });

        await syncInternals.activateAccountSettingsScope('account-b');

        expect(storage.getState().accountSettingsSyncStatus).toEqual({ state: 'idle', lastSyncedAt: null });
    });

    it('refuses an immutable account-settings mutation when the account changes during preflush', async () => {
        const { sync } = await import('./sync');
        const scope = { serverId: getActiveServerSnapshot().serverId, accountId: 'account-a' };
        const requested = createDeferred<void>();
        const response = createDeferred<Response>();
        Reflect.set(sync, 'pendingSettingsScope', scope);
        runtimeFetchMock.mockImplementation(async (url: string) => {
            const path = new URL(url).pathname;
            if (path === '/v1/auth/ping') return Response.json({ success: true });
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v2/account/settings') { requested.resolve(); return response.promise; }
            return new Response('{}', { status: 404 });
        });
        const operation = sync.applyAccountSettingsMutation({
            operations: [{ op: 'set', key: 'analyticsOptOut', value: true }],
        }, scope);
        await requested.promise;
        await (sync as any).activateAccountSettingsScope('account-b');
        response.resolve(Response.json({ content: { t: 'plain', v: {} }, version: 7 }));
        await expect(operation).rejects.toThrow('Account settings scope changed while mutating settings');
        expect(runtimeFetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    });

    it('refuses a retained one-shot mutation before preflush when its rendered Account scope retired', async () => {
        const { sync } = await import('./sync');
        const serverId = getActiveServerSnapshot().serverId;
        await (sync as any).activateAccountSettingsScope('account-b');
        runtimeFetchMock.mockClear();
        await expect(sync.mutateAccountSettingsOnce({
            expectedSettingsScope: { serverId, accountId: 'account-a' },
            expectedSettingsVersion: 7,
            mutate: (raw) => ({ settings: { ...raw, analyticsOptOut: true }, value: undefined }),
        })).rejects.toThrow('Account settings scope changed before mutating settings');
        expect(runtimeFetchMock).not.toHaveBeenCalled();
    });

    it('hydrates e2ee session encryption on deep link before sessions snapshot fetch', async () => {
        const sessionId = 'deep_link_session';
        storage.getState().applySessions([createSession({ sessionId })]);
        storage.getState().resetSessionMessages(sessionId);

        const { sync } = await import('./sync');

        (sync as any).credentials = { token: tokenForSub('account-a') };
        (sync as any).activeServerSessionIds = new Set<string>();
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = false;


        const encryptedFixture = await createEncryptedSessionFixture(sessionId);
        (sync as any).encryption = encryptedFixture.encryption;
        (sync as any).credentials = encryptedFixture.credentials;

        requestMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    session: {
                        id: sessionId,
                        createdAt: 1,
                        updatedAt: 2,
                        seq: 3,
                        active: true,
                        activeAt: 2,
                        encryptionMode: 'e2ee',
                        dataEncryptionKey: encryptedFixture.row.dataEncryptionKey,
                        metadataVersion: 1,
                        metadata: encryptedFixture.row.metadata,
                        agentStateVersion: 1,
                        agentState: encryptedFixture.row.agentState,
                        share: null,
                    },
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        );

        await expect(sync.ensureSessionVisibleForMessageRoute(sessionId)).resolves.toMatchObject({
            kind: 'available',
            sessionId,
        });

        const sessionByIdCalls = requestMock.mock.calls.filter(
            (call) => call?.[0] === `/v2/sessions/${sessionId}`,
        );
        expect(sessionByIdCalls).toHaveLength(1);
        expect((sync as any).activeServerSessionIds.has(sessionId)).toBe(true);
    });

    it('keeps a recipient with a missing envelope locked after exact-route hydration', async () => {
        const sessionId = 'recipient_missing_envelope_route';
        const { Encryption } = await import('@/sync/encryption/encryption');
        const { encodeBase64 } = await import('@/encryption/base64');
        const { sync } = await import('./sync');
        const secret = new Uint8Array(32).fill(7);
        const encryption = await Encryption.create(secret);
        await encryption.initializeSessions(new Map([[sessionId, new Uint8Array(32).fill(9)]]));
        Reflect.set(sync, 'credentials', { token: tokenForSub('account-a'), secret: encodeBase64(secret, 'base64url') });
        Reflect.set(sync, 'encryption', encryption);
        Reflect.set(sync, 'activeServerSessionIds', new Set<string>());
        requestMock.mockImplementation(async (path: string) => new Response(JSON.stringify(
            path === '/v1/account/encryption/currentness'
                ? {
                    mode: 'e2ee', version: 1, updatedAt: 1,
                    signingKeyFingerprint: 'signing-current', contentKeyFingerprint: 'content-current',
                    recipientEnvelopeReadiness: { status: 'available' },
                }
                : {
                    session: {
                        id: sessionId, createdAt: 1, updatedAt: 2, seq: 3,
                        active: true, activeAt: 2, encryptionMode: 'e2ee', dataEncryptionKey: null,
                        metadataLayoutVersion: 0, metadataVersion: 1, metadata: 'encrypted-metadata',
                        agentStateVersion: 1, agentState: null,
                        share: { accessLevel: 'view', canApprovePermissions: false },
                    },
                },
        ), { status: 200, headers: { 'Content-Type': 'application/json' } }));

        await expect(sync.ensureSessionVisibleForMessageRoute(sessionId)).resolves.toMatchObject({
            kind: 'available', sessionId,
        });
        expect(storage.getState().sessions[sessionId]).toMatchObject({
            encryptedContentAvailability: 'encrypted_access_pending', metadata: null,
        });
        expect(encryption.getSessionEncryption(sessionId)).toBeNull();
    });

    it('settles a known locked recipient route and hook without a content cipher', async () => {
        const sessionId = 'settled_locked_recipient_route';
        const { Encryption } = await import('@/sync/encryption/encryption');
        const { sync } = await import('./sync');
        const { useHydrateSessionForRoute } = await import('@/hooks/session/useHydrateSessionForRoute');
        Reflect.set(sync, 'encryption', await Encryption.create(new Uint8Array(32).fill(7)));
        Reflect.set(sync, 'credentials', { token: tokenForSub('account-a') });
        Reflect.set(sync, 'activeServerSessionIds', new Set([sessionId]));
        storage.getState().applySessions([{
            ...createSession({ sessionId }),
            metadataLayoutVersion: 0,
            accessLevel: 'view',
            encryptedContentAvailability: 'encrypted_access_pending',
        }]);

        const hook = await renderHook(() => useHydrateSessionForRoute(sessionId, 'locked-route'));
        try {
            expect(hook.getCurrent()).toMatchObject({ kind: 'available', sessionId });
            await expect(sync.ensureSessionVisibleForMessageRoute(sessionId)).resolves.toMatchObject({
                kind: 'available', sessionId,
            });
            expect(requestMock).not.toHaveBeenCalled();
        } finally {
            await hook.unmount();
        }
    });

    it('returns a retryable result when credentials are not yet available', async () => {
        const sessionId = 'deep_link_missing_creds';
        storage.getState().applySessions([createSession({ sessionId })]);
        storage.getState().resetSessionMessages(sessionId);

        const { sync } = await import('./sync');
        (sync as any).credentials = null;
        (sync as any).activeServerSessionIds = new Set<string>();
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = false;
        (sync as any).encryption = null;

        await expect(sync.ensureSessionVisibleForMessageRoute(sessionId)).resolves.toMatchObject({
            kind: 'retryable_failure',
            sessionId,
            cause: 'unknown',
        });
        expect(requestMock).not.toHaveBeenCalled();
    });

    it('falls back to a session-list snapshot when socket new-session hydration cannot prove active-list visibility', async () => {
        const sessionId = 'socket_new_session_needs_snapshot_reconcile';
        const { upsertAndActivateServer, getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        await upsertAndActivateServer({ serverUrl: 'https://active.example.test', scope: 'tab' });
        await applySelectedHomeForSessionListTest();
        const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
        expect(activeServerId).toBeTruthy();

        const { sync } = await import('./sync');
        const syncInternals = sync as any;

        syncInternals.credentials = { token: tokenForSub('account-a'), secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url') };
        syncInternals.activeServerSessionIds = new Set<string>(['older-session']);
        syncInternals.hasFetchedSessionsSnapshotForActiveServer = true;
        syncInternals.encryption = await Encryption.create(new Uint8Array(32).fill(7));

        requestMock.mockImplementation(async (path: string) => /^\/v2\/sessions(?:\/active)?(?:\?|$)/.test(path)
            ? Response.json({ sessions: [], nextCursor: null, hasNext: false })
            : new Response('temporary session hydrate failure', { status: 503 }));

        await syncInternals.handleUpdate({
            id: 'u_socket_new_session_reconcile',
            seq: 10,
            createdAt: 100,
            body: {
                t: 'new-session',
                id: sessionId,
                seq: 1,
                metadata: 'encrypted-metadata',
                metadataVersion: 2,
                agentState: 'encrypted-agent-state',
                agentStateVersion: 3,
                dataEncryptionKey: 'encrypted-data-key',
                encryptionMode: 'e2ee',
                active: true,
                activeAt: 100,
                createdAt: 90,
                updatedAt: 100,
            },
        });

        await waitForAssertion(() => {
            expect(requestMock).toHaveBeenCalledWith(
                `/v2/sessions/${sessionId}`,
                expect.objectContaining({ method: 'GET' }),
            );
        });
        await waitForAssertion(() => {
            expect(requestMock.mock.calls.some(([path]) => /^\/v2\/sessions(?:\/active)?(?:\?|$)/.test(String(path)))).toBe(true);
        });
    });

    it('refreshes the active session-list snapshot after socket new-session hydration even when the by-id row is locally indexed', async () => {
        const sessionId = 'socket_new_session_indexed_but_visible_list_stale';
        const { upsertAndActivateServer, getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        await upsertAndActivateServer({ serverUrl: 'https://active.example.test', scope: 'tab' });
        await applySelectedHomeForSessionListTest();
        const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
        expect(activeServerId).toBeTruthy();

        storage.getState().applySessions([
            {
                ...createSession({ sessionId }),
                encryptionMode: 'plain',
                serverId: activeServerId,
            } as Session & { serverId: string },
        ]);
        const { buildSessionListRenderableFromSession } = await import('@/sync/domains/session/listing/sessionListRenderable');
        const indexedSession = storage.getState().sessions[sessionId];
        if (!indexedSession) throw new Error('Expected indexed session fixture.');
        storage.getState().applyServerScopedSessionListRows(activeServerId, [
            buildSessionListRenderableFromSession(indexedSession),
        ], { source: 'ordinary', mode: 'append' });
        expect(
            storage.getState().sessionListIndexByServerId?.[activeServerId]?.some((item) => (
                item.type === 'session' && item.sessionId === sessionId
            )),
        ).toBe(true);

        const { sync } = await import('./sync');
        const syncInternals = sync as any;

        syncInternals.credentials = { token: tokenForSub('account-a'), secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url') };
        syncInternals.activeServerSessionIds = new Set<string>(['older-session']);
        syncInternals.hasFetchedSessionsSnapshotForActiveServer = true;
        syncInternals.encryption = await Encryption.create(new Uint8Array(32).fill(7));

        requestMock.mockImplementation(async (path: string) => {
            if (path === `/v2/sessions/${sessionId}`) {
                return new Response(JSON.stringify({ session: {
                    id: sessionId,
                    seq: 2,
                    encryptionMode: 'plain',
                    dataEncryptionKey: null,
                    share: null,
                    metadata: JSON.stringify({ path: '/tmp/socket-indexed', host: 'local' }),
                    metadataVersion: 1,
                    agentState: null,
                    agentStateVersion: 1,
                    active: true,
                    activeAt: 120,
                    createdAt: 100,
                    updatedAt: 120,
                } }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            if (/^\/v2\/sessions(?:\/active)?(?:\?|$)/.test(path)) return Response.json({
                sessions: [], nextCursor: null, hasNext: false,
            });
            return new Response('unexpected request', { status: 404 });
        });

        await syncInternals.hydrateSessionFromSocketUpdate(
            sessionId,
            'socket-new-session-reconcile',
            activeServerId,
        );

        expect(requestMock).toHaveBeenCalledWith(
            `/v2/sessions/${sessionId}`,
            expect.objectContaining({ method: 'GET' }),
        );
        expect(requestMock.mock.calls.some(([path]) => /^\/v2\/sessions(?:\/active)?(?:\?|$)/.test(String(path)))).toBe(true);
    });

    it('keeps the exact socket-created active row visible when the reconcile list refresh omits it', async () => {
        const sessionId = 'socket_new_session_exact_row_retained_after_stale_refresh';
        const olderSessionId = 'socket_new_session_stale_refresh_older_row';
        const { upsertAndActivateServer, getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        await upsertAndActivateServer({ serverUrl: 'https://active.example.test', scope: 'tab' });
        await applySelectedHomeForSessionListTest();
        const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
        expect(activeServerId).toBeTruthy();

        storage.getState().applySessions([
            {
                ...createSession({ sessionId: olderSessionId }),
                encryptionMode: 'plain',
                serverId: activeServerId,
                metadata: { path: '/tmp/older-row', host: 'local' },
                metadataVersion: 1,
            } as Session & { serverId: string },
        ]);

        const { sync } = await import('./sync');
        const syncInternals = sync as any;

        syncInternals.credentials = { token: tokenForSub('account-a'), secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url') };
        syncInternals.activeServerSessionIds = new Set<string>([olderSessionId]);
        syncInternals.hasFetchedSessionsSnapshotForActiveServer = true;
        syncInternals.encryption = await Encryption.create(new Uint8Array(32).fill(7));

        requestMock.mockImplementation(async (path: string) => {
            if (path === `/v2/sessions/${sessionId}`) {
                return new Response(JSON.stringify({
                    session: {
                        id: sessionId,
                        seq: 2,
                        encryptionMode: 'plain',
                        metadata: JSON.stringify({ path: '/tmp/exact-socket-row', host: 'local' }),
                        metadataVersion: 1,
                        agentState: null,
                        agentStateVersion: 1,
                        active: true,
                        activeAt: 140,
                        archivedAt: null,
                        createdAt: 130,
                        updatedAt: 140,
                    },
                }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            if (/^\/v2\/sessions(?:\/active)?(?:\?|$)/.test(path)) return Response.json({
                sessions: [{
                    id: olderSessionId, seq: 1, createdAt: 100, updatedAt: 100, active: true, activeAt: 100,
                    archivedAt: null, encryptionMode: 'plain', dataEncryptionKey: null,
                    metadata: JSON.stringify({ path: '/tmp/older-row', host: 'local' }), metadataVersion: 1,
                    agentState: null, agentStateVersion: 0, share: null,
                }], nextCursor: null, hasNext: false,
            });
            return new Response('unexpected request', { status: 404 });
        });

        await syncInternals.hydrateSessionFromSocketUpdate(
            sessionId,
            'socket-new-session-reconcile',
            activeServerId,
        );

        expect(requestMock.mock.calls.some(([path]) => /^\/v2\/sessions(?:\/active)?(?:\?|$)/.test(String(path)))).toBe(true);
        expect(Object.values(storage.getState().sessionListRowsByServerId).map((rows) => rows[sessionId]).find(Boolean)?.metadata?.path).toBe('/tmp/exact-socket-row');
        expect(
            storage.getState().sessionListIndexByServerId?.[activeServerId]?.some((item) => (
                item.type === 'session' && item.sessionId === sessionId
            )),
        ).toBe(true);
    });

    it('keeps visible cached socket update hydration targeted instead of refreshing the active session-list snapshot', async () => {
        const sessionId = 'socket_visible_cached_update_targeted_hydration';
        const { upsertAndActivateServer, getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        await upsertAndActivateServer({ serverUrl: 'https://active.example.test', scope: 'tab' });
        await applySelectedHomeForSessionListTest();
        const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
        expect(activeServerId).toBeTruthy();

        storage.getState().applyServerScopedSessionListRows(activeServerId, [
            {
                id: sessionId,
                seq: 1,
                createdAt: 100,
                updatedAt: 100,
                active: true,
                activeAt: 100,
                archivedAt: null,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: { path: '/tmp/visible-cached-update', host: 'local' },
                thinking: true,
                thinkingAt: 100,
                presence: 'online',
                hasUnreadMessages: false,
            },
        ], { source: 'ordinary', mode: 'replace' });
        markSessionSurfaceVisible(sessionId, activeServerId);

        const { sync } = await import('./sync');
        const syncInternals = sync as any;

        syncInternals.credentials = { token: tokenForSub('account-a'), secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url') };
        syncInternals.activeServerSessionIds = new Set<string>(['older-session']);
        syncInternals.hasFetchedSessionsSnapshotForActiveServer = true;
        syncInternals.encryption = await Encryption.create(new Uint8Array(32).fill(7));

        requestMock.mockImplementation(async (path: string) => {
            if (path === `/v2/sessions/${sessionId}`) {
                return new Response(JSON.stringify({ session: {
                    id: sessionId,
                    seq: 2,
                    encryptionMode: 'plain',
                    dataEncryptionKey: null,
                    share: null,
                    metadata: JSON.stringify({ path: '/tmp/visible-cached-update', host: 'local' }),
                    metadataVersion: 2,
                    agentState: null,
                    agentStateVersion: 1,
                    active: false,
                    activeAt: 120,
                    createdAt: 100,
                    updatedAt: 120,
                } }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            if (/^\/v2\/sessions(?:\/active)?(?:\?|$)/.test(path)) return Response.json({
                sessions: [], nextCursor: null, hasNext: false,
            });
            return new Response('unexpected request', { status: 404 });
        });

        try {
            await syncInternals.hydrateSessionFromSocketUpdate(
                sessionId,
                'socket-update-missing-session',
                activeServerId,
            );

            expect(requestMock).toHaveBeenCalledWith(
                `/v2/sessions/${sessionId}`,
                expect.objectContaining({ method: 'GET' }),
            );
            expect(requestMock.mock.calls.some(([path]) => /^\/v2\/sessions(?:\/active)?(?:\?|$)/.test(String(path)))).toBe(false);
        } finally {
            markSessionSurfaceHidden(sessionId);
        }
    });

    it('keeps shared-session visibility hydration targeted instead of refreshing the active session-list snapshot', async () => {
        const sessionId = 'share_visibility_targeted_hydration_only';
        const { upsertAndActivateServer, getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        await upsertAndActivateServer({ serverUrl: 'https://active.example.test', scope: 'tab' });
        await applySelectedHomeForSessionListTest();
        const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
        expect(activeServerId).toBeTruthy();

        const { sync } = await import('./sync');
        const syncInternals = sync as any;

        syncInternals.credentials = { token: tokenForSub('account-a'), secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url') };
        syncInternals.activeServerSessionIds = new Set<string>();
        syncInternals.hasFetchedSessionsSnapshotForActiveServer = true;
        syncInternals.encryption = await Encryption.create(new Uint8Array(32).fill(7));

        requestMock.mockResolvedValue(new Response(JSON.stringify({
            session: {
                id: sessionId,
                seq: 2,
                encryptionMode: 'plain',
                metadata: { path: '/tmp/share-targeted', host: 'local' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 1,
                active: true,
                activeAt: 120,
                createdAt: 100,
                updatedAt: 120,
                share: { id: 'share-targeted', accessLevel: 'edit' },
            },
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }));

        await syncInternals.hydrateSessionFromSocketUpdate(
            sessionId,
            'share-visibility-change',
            activeServerId,
        );

        expect(requestMock).toHaveBeenCalledWith(
            `/v2/sessions/${sessionId}`,
            expect.objectContaining({ method: 'GET' }),
        );
        expect(requestMock.mock.calls.some(([path]) => /^\/v2\/sessions(?:\/active)?(?:\?|$)/.test(String(path)))).toBe(false);
    });

    it('does not refresh the active session-list snapshot after hydrating a non-active source-server socket update', async () => {
        const sessionId = 'socket_foreign_server_targeted_hydration';
        const scopedToken = tokenForSub('scoped-account');
        const activeServer = await upsertServerProfile({ serverUrl: 'https://active.example', name: 'Active' });
        const ownerServer = await upsertServerProfile({ serverUrl: 'https://scoped.example', name: 'Owner' });
        await setActiveServerId(activeServer.id, { scope: 'device' });
        await applySelectedHomeForSessionListTest();

        const { sync } = await import('./sync');
        const syncInternals = sync as any;

        syncInternals.credentials = { token: tokenForSub('account-a'), secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url') };
        syncInternals.activeServerSessionIds = new Set<string>();
        syncInternals.hasFetchedSessionsSnapshotForActiveServer = true;
        syncInternals.encryption = await Encryption.create(new Uint8Array(32).fill(7));

        requestMock.mockRejectedValue(new Error('active request should not be used'));
        await TokenStorage.setCredentialsForServerUrl(ownerServer.serverUrl, { serverId: ownerServer.id }, { token: scopedToken, secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url') });
        runtimeFetchMock.mockImplementation(async () => new Response(JSON.stringify({
            session: {
                id: sessionId,
                seq: 2,
                encryptionMode: 'plain',
                metadata: { path: '/tmp/foreign-targeted', host: 'owner' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 1,
                active: true,
                activeAt: 120,
                createdAt: 100,
                updatedAt: 120,
                share: null,
            },
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }));

        await syncInternals.hydrateSessionFromSocketUpdate(
            sessionId,
            'socket-new-session-reconcile',
            ownerServer.id,
        );

        expect(requestMock).not.toHaveBeenCalled();
        expectRuntimeFetchWithBearer(
            `https://scoped.example/v2/sessions/${sessionId}`,
            scopedToken,
        );
        expect(requestMock.mock.calls.some(([path]) => /^\/v2\/sessions(?:\/active)?(?:\?|$)/.test(String(path)))).toBe(false);
    });

    it('fast-paths a known encrypted session with metadata, encryption, and null agent state', async () => {
        const sessionId = 'known_session_null_agent_state';
        storage.getState().applySessions([
            {
                ...createSession({ sessionId }),
                metadata: { path: '/tmp/demo', host: 'local' },
                agentState: null,
            },
        ]);
        storage.getState().resetSessionMessages(sessionId);

        const { sync } = await import('./sync');
        (sync as any).credentials = { token: tokenForSub('account-a') };
        (sync as any).activeServerSessionIds = new Set<string>([sessionId]);
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;
        (sync as any).encryption = await Encryption.create(new Uint8Array(32).fill(7));
        await (sync as any).encryption.initializeSessions(new Map([[sessionId, new Uint8Array(32).fill(8)]]));

        await expect(sync.ensureSessionVisibleForMessageRoute(sessionId)).resolves.toMatchObject({
            kind: 'available',
            sessionId,
        });
        expect(requestMock).not.toHaveBeenCalled();
    });

    it('keeps a layout-v1 owner list row retryable when its by-id 404 is unparseable', async () => {
        const sessionId = 'layout1_owner_list_shell';
        storage.getState().applySessions([{
            ...createSession({ sessionId }),
            encryptionMode: 'plain',
            metadataLayoutVersion: 1,
            metadata: {
                v: 1,
                summary: { text: 'Shared title', updatedAt: 1 },
            } as unknown as Session['metadata'],
            ownerMetadataView: null,
        }]);

        const { sync } = await import('./sync');
        (sync as any).credentials = { token: tokenForSub('account-a') };
        (sync as any).activeServerSessionIds = new Set<string>([sessionId]);
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;
        (sync as any).encryption = null;
        requestMock.mockResolvedValue(new Response('missing', { status: 404 }));

        await expect(sync.ensureSessionVisibleForMessageRoute(sessionId)).resolves.toMatchObject({
            kind: 'retryable_failure',
            sessionId,
            cause: 'unknown',
        });
        expect(storage.getState().sessions[sessionId]).toBeDefined();
        expect(requestMock).toHaveBeenCalledWith(
            `/v2/sessions/${sessionId}`,
            expect.objectContaining({ method: 'GET' }),
        );
    });

    it('fast-paths a layout-v1 participant from strict shared metadata without owner data', async () => {
        const sessionId = 'layout1_shared_participant';
        storage.getState().applySessions([{
            ...createSession({ sessionId }),
            encryptionMode: 'plain',
            accessLevel: 'view',
            metadataLayoutVersion: 1,
            metadata: {
                v: 1,
                summary: { text: 'Shared title', updatedAt: 1 },
            } as unknown as Session['metadata'],
            ownerMetadataView: null,
        }]);

        const { sync } = await import('./sync');
        (sync as any).credentials = { token: tokenForSub('account-a') };
        (sync as any).activeServerSessionIds = new Set<string>([sessionId]);
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;
        (sync as any).encryption = null;

        await expect(sync.ensureSessionVisibleForMessageRoute(sessionId)).resolves.toMatchObject({
            kind: 'available',
            sessionId,
        });
        expect(requestMock).not.toHaveBeenCalled();
    });

    it('classifies session-by-id reachability failures as server unavailable retry results', async () => {
        const sessionId = 'deep_link_server_unavailable';
        storage.getState().resetSessionMessages(sessionId);

        const { sync } = await import('./sync');
        (sync as any).credentials = { token: tokenForSub('account-a') };
        (sync as any).activeServerSessionIds = new Set<string>();
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = false;
        (sync as any).encryption = await Encryption.create(new Uint8Array(32).fill(7));

        const connectivityError = new Error('active server request timed out');
        connectivityError.name = 'ServerFetchConnectivityTimeoutError';
        requestMock.mockRejectedValue(connectivityError);

        await expect(sync.ensureSessionVisibleForMessageRoute(sessionId)).resolves.toMatchObject({
            kind: 'retryable_failure',
            sessionId,
            cause: 'server_unavailable',
        });
    });

    it('returns a retryable result for an unparseable not-found body so deep links can recover', async () => {
        const sessionId = 'deep_link_missing_session';

        const { sync } = await import('./sync');

        (sync as any).credentials = { token: tokenForSub('account-a') };
        (sync as any).activeServerSessionIds = new Set<string>();
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = false;
        (sync as any).encryption = await Encryption.create(new Uint8Array(32).fill(7));

        requestMock.mockResolvedValue(new Response('not found', { status: 404 }));

        await expect(sync.ensureSessionVisibleForMessageRoute(sessionId)).resolves.toMatchObject({
            kind: 'retryable_failure',
            sessionId,
            cause: 'unknown',
        });
    });

    it.each(['plain', 'e2ee'] as const)(
        'does not restore a cross-device-deleted %s session from an older in-flight by-id hydration',
        async (encryptionMode) => {
            const sessionId = `voice_history_deleted_during_${encryptionMode}_hydration`;
            const fixture = await createEncryptedSessionFixture(sessionId);
            const { sync } = await import('./sync');
            Reflect.set(sync, 'credentials', fixture.credentials);
            Reflect.set(sync, 'encryption', fixture.encryption);
            Reflect.set(sync, 'activeServerSessionIds', new Set([sessionId]));
            await fixture.encryption.initializeSessions(new Map([[sessionId, fixture.dataKey]]));
            Reflect.set(sync, 'sessionDataKeys', new Map([[sessionId, fixture.dataKey]]));
            Reflect.set(sync, 'sessionDataKeyEnvelopes', new Map([[sessionId, fixture.row.dataEncryptionKey]]));
            storage.getState().applySessions([{ ...createSession({ sessionId }), encryptionMode }]);
            const requested = createDeferred<void>();
            const response = createDeferred<Response>();
            const decrypting = createDeferred<void>();
            const decryptRelease = createDeferred<void>();
            if (encryptionMode === 'e2ee') {
                const crypto = await import('rn-encryption');
                const decrypt = crypto.decryptAsyncAES;
                const boundary = vi.spyOn(crypto, 'decryptAsyncAES').mockImplementation(async (...args) => {
                    decrypting.resolve();
                    await decryptRelease.promise;
                    return decrypt(...args);
                });
                onTestFinished(() => boundary.mockRestore());
            }
            requestMock.mockImplementation(async () => { requested.resolve(); return response.promise; });
            const hydration = sync.ensureSessionVisibleForMessageRoute(sessionId, { forceRefresh: true });
            await requested.promise;
            const staleResponse = Response.json({ session: encryptionMode === 'e2ee' ? fixture.row : {
                ...fixture.row, encryptionMode: 'plain', dataEncryptionKey: null,
                metadata: JSON.stringify({ path: '/repo', host: 'host' }), agentState: JSON.stringify({ controlledByUser: true }),
            } });
            if (encryptionMode === 'e2ee') {
                response.resolve(staleResponse);
                await decrypting.promise;
            }
            await (sync as any).handleUpdate({
                id: `delete-${encryptionMode}`, seq: 10, createdAt: 10,
                body: { t: 'delete-session', sid: sessionId },
            });
            expect(storage.getState().sessions[sessionId]).toBeUndefined();
            expect(fixture.encryption.getSessionEncryption(sessionId)).toBeNull();
            if (encryptionMode === 'plain') response.resolve(staleResponse);
            else decryptRelease.resolve();
            await expect(hydration).resolves.toMatchObject({ kind: 'retryable_failure', sessionId });
            expect(storage.getState().sessions[sessionId]).toBeUndefined();
            expect((sync as any).sessionDataKeys.has(sessionId)).toBe(false);
            expect((sync as any).sessionDataKeyEnvelopes.has(sessionId)).toBe(false);
            expect(fixture.encryption.getSessionEncryption(sessionId)).toBeNull();
        },
    );

    it('requires fresh hydration when encryption changes during metadata decryption', async () => {
        const sessionId = 'deep_link_session_swap';
        const fixture = await createEncryptedSessionFixture(sessionId);
        const replacement = await Encryption.create(new Uint8Array(32).fill(7));
        const { sync } = await import('./sync');
        Reflect.set(sync, 'credentials', fixture.credentials);
        Reflect.set(sync, 'encryption', fixture.encryption);
        Reflect.set(sync, 'activeServerSessionIds', new Set<string>());
        storage.getState().applySessions([createSession({ sessionId })]);
        requestMock.mockImplementation(async () => Response.json({ session: fixture.row }));
        // The third-party native crypto adapter is the asynchronous boundary.
        // Keep its actual AES implementation while replacing Account presentation.
        const crypto = await import('rn-encryption');
        const decrypt = crypto.decryptAsyncAES;
        const boundary = vi.spyOn(crypto, 'decryptAsyncAES').mockImplementation(async (...args) => {
            Reflect.set(sync, 'encryption', replacement);
            return decrypt(...args);
        });
        onTestFinished(() => boundary.mockRestore());
        await expect(sync.ensureSessionVisibleForMessageRoute(sessionId)).resolves.toMatchObject({
            kind: 'retryable_failure', sessionId,
        });
        expect(Reflect.get(sync, 'encryption')).toBe(replacement);
        expect(replacement.getSessionEncryption(sessionId)).toBeNull();
    });

    it('re-fetches a known session when forceRefresh is requested', async () => {
        const sessionId = 'known_session_force_refresh';
        storage.getState().applySessions([createSession({ sessionId })]);
        storage.getState().resetSessionMessages(sessionId);

        const { sync } = await import('./sync');

        (sync as any).credentials = { token: tokenForSub('account-a') };
        (sync as any).activeServerSessionIds = new Set<string>([sessionId]);
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;
        const encryptedFixture = await createEncryptedSessionFixture(sessionId);
        (sync as any).encryption = encryptedFixture.encryption;
        (sync as any).credentials = encryptedFixture.credentials;

        requestMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    session: {
                        id: sessionId,
                        createdAt: 1,
                        updatedAt: 2,
                        seq: 3,
                        active: true,
                        activeAt: 2,
                        encryptionMode: 'e2ee',
                        dataEncryptionKey: encryptedFixture.row.dataEncryptionKey,
                        metadataVersion: 1,
                        metadata: encryptedFixture.row.metadata,
                        agentStateVersion: 1,
                        agentState: encryptedFixture.row.agentState,
                        share: null,
                    },
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        );

        await expect(sync.ensureSessionVisibleForMessageRoute(sessionId, { forceRefresh: true })).resolves.toMatchObject({
            kind: 'available',
            sessionId,
        });

        const sessionByIdCalls = requestMock.mock.calls.filter(
            (call) => call?.[0] === `/v2/sessions/${sessionId}`,
        );
        expect(sessionByIdCalls).toHaveLength(1);
    });

    it('uses its applied Home rather than staged selection for unqualified message-route hydration', async () => {
        const sessionId = 'unqualified_applied_route';
        const appliedCredentials = {
            token: tokenForSub('applied-account'),
            secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url'),
        };
        const appliedSession = {
            id: sessionId,
            createdAt: 1,
            updatedAt: 2,
            seq: 3,
            active: true,
            activeAt: 2,
            archivedAt: null,
            encryptionMode: 'plain' as const,
            dataEncryptionKey: null,
            metadataVersion: 1,
            metadata: JSON.stringify({ readStateV1: null }),
            agentStateVersion: 1,
            agentState: JSON.stringify({ controlledByUser: true }),
            share: null,
        };
        const appliedHome = await upsertServerProfile({
            serverUrl: 'https://applied-route.example.test',
            name: 'Applied route',
        });
        const stagedHome = await upsertServerProfile({
            serverUrl: 'https://staged-route.example.test',
            name: 'Staged route',
        });
        await setActiveServerId(appliedHome.id, { scope: 'device' });
        await applySelectedHomeForSessionListTest(appliedCredentials);
        await setActiveServerId(stagedHome.id, { scope: 'device' });

        const { sync } = await import('./sync');
        (sync as any).credentials = appliedCredentials;
        (sync as any).activeServerSessionIds = new Set<string>();
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = false;
        (sync as any).encryption = null;
        requestMock.mockRejectedValue(new Error('the unavailable singleton must not be used'));
        runtimeFetchMock.mockImplementation(async (url: string) => {
            const path = new URL(url).pathname;
            if (path === '/v1/auth/ping') {
                return Response.json({ success: true });
            }
            if (path === '/v1/account/encryption/currentness') {
                return Response.json({
                    mode: 'plain',
                    version: 1,
                    signingKeyFingerprint: null,
                    contentKeyFingerprint: null,
                    updatedAt: 1,
                });
            }
            if (path === '/v2/sessions') {
                return Response.json({ sessions: [appliedSession], nextCursor: null, hasNext: false });
            }
            if (path !== `/v2/sessions/${sessionId}`) {
                return new Response(null, { status: 404 });
            }
            return Response.json({
                session: appliedSession,
            });
        });
        const {
            resetServerReachabilitySupervisors,
            startServerReachabilitySupervisor,
            waitForServerReachable,
        } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
        await resetServerReachabilitySupervisors();
        onTestFinished(async () => {
            await resetServerReachabilitySupervisors();
        });
        await startServerReachabilitySupervisor({
            serverUrl: appliedHome.serverUrl,
            token: appliedCredentials.token,
        });
        await waitForServerReachable({
            serverUrl: appliedHome.serverUrl,
            token: appliedCredentials.token,
            timeoutMs: 1_000,
        });

        const result = await sync.ensureSessionVisibleForMessageRoute(sessionId, {
            forceRefresh: true,
            scopeCurrentness: () => true,
        });
        expect(result).toMatchObject({
            kind: 'available',
            sessionId,
            serverId: appliedHome.id,
        });
        expect(requestMock).not.toHaveBeenCalled();
        expectRuntimeFetchWithBearer(
            `https://applied-route.example.test/v2/sessions/${sessionId}`,
            appliedCredentials.token,
        );
        expect(runtimeFetchMock.mock.calls.some(([url]) => (
            String(url).startsWith(stagedHome.serverUrl)
        ))).toBe(false);
    });

    it('re-fetches a known encrypted session when the stored record is still partially hydrated', async () => {
        const sessionId = 'known_session_partial_refresh';
        storage.getState().applySessions([createSession({ sessionId })]);
        storage.getState().resetSessionMessages(sessionId);

        const { sync } = await import('./sync');


        (sync as any).credentials = { token: tokenForSub('account-a') };
        (sync as any).activeServerSessionIds = new Set<string>([sessionId]);
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;
        const encryptedFixture = await createEncryptedSessionFixture(sessionId);
        (sync as any).encryption = encryptedFixture.encryption;
        (sync as any).credentials = encryptedFixture.credentials;

        requestMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    session: {
                        id: sessionId,
                        createdAt: 1,
                        updatedAt: 2,
                        seq: 3,
                        active: true,
                        activeAt: 2,
                        encryptionMode: 'e2ee',
                        dataEncryptionKey: encryptedFixture.row.dataEncryptionKey,
                        metadataVersion: 1,
                        metadata: encryptedFixture.row.metadata,
                        agentStateVersion: 1,
                        agentState: encryptedFixture.row.agentState,
                        share: null,
                    },
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        );

        await expect(sync.ensureSessionVisibleForMessageRoute(sessionId)).resolves.toMatchObject({
            kind: 'available',
            sessionId,
        });

        expect(requestMock).toHaveBeenCalledWith(
            `/v2/sessions/${sessionId}`,
            expect.objectContaining({ method: 'GET' }),
        );
        const request = requestMock.mock.calls.find(([path]) => path === `/v2/sessions/${sessionId}`);
        expect(new Headers(request?.[1]?.headers).get('Authorization')).toBe(`Bearer ${tokenForSub('account-a')}`);
        expect(storage.getState().sessions[sessionId]?.metadata).toMatchObject({ path: '/repo', host: 'host' });
        expect(encryptedFixture.encryption.getSessionEncryption(sessionId)).not.toBeNull();
    });

    it('keeps a fully hydrated known encrypted session on the fast path', async () => {
        const sessionId = 'known_session_fast_path';
        storage.getState().applySessions([
            {
                ...createSession({ sessionId }),
                metadataVersion: 1,
                metadata: {
                    path: '/repo',
                    host: 'host',
                    machineId: 'machine-1',
                },
                agentStateVersion: 1,
                agentState: {
                    controlledByUser: true,
                    requests: {},
                    completedRequests: {},
                },
            } as Session,
        ]);
        storage.getState().resetSessionMessages(sessionId);

        const { sync } = await import('./sync');

        (sync as any).credentials = { token: tokenForSub('account-a') };
        (sync as any).activeServerSessionIds = new Set<string>([sessionId]);
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;
        (sync as any).encryption = await Encryption.create(new Uint8Array(32).fill(7));
        await (sync as any).encryption.initializeSessions(new Map([[sessionId, new Uint8Array(32).fill(8)]]));

        await expect(sync.ensureSessionVisibleForMessageRoute(sessionId)).resolves.toMatchObject({
            kind: 'available',
            sessionId,
        });
        expect(requestMock).not.toHaveBeenCalled();
    });

    it('keeps a fully hydrated known plaintext session on the fast path without an encryption lookup', async () => {
        const sessionId = 'known_plain_session_fast_path';
        storage.getState().applySessions([
            {
                ...createSession({ sessionId }),
                encryptionMode: 'plain',
                metadataVersion: 1,
                metadata: {
                    path: '/repo',
                    host: 'host',
                    machineId: 'machine-1',
                },
                agentStateVersion: 1,
                agentState: {
                    controlledByUser: true,
                    requests: {},
                    completedRequests: {},
                },
            } as Session,
        ]);
        storage.getState().resetSessionMessages(sessionId);

        const { sync } = await import('./sync');

        (sync as any).credentials = { token: tokenForSub('account-a') };
        (sync as any).activeServerSessionIds = new Set<string>([sessionId]);
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;
        (sync as any).encryption = null;

        await expect(sync.ensureSessionVisibleForMessageRoute(sessionId)).resolves.toMatchObject({
            kind: 'available',
            sessionId,
        });
        expect(requestMock).not.toHaveBeenCalled();
        expect((sync as any).encryption).toBeNull();
    });

    it('hydrates through the preferred owner server when local cache maps the session to a non-active server', async () => {
        const sessionId = 'deep_link_scoped_owner';
        const scopedToken = tokenForSub('scoped-account');
        const activeServer = await upsertServerProfile({ serverUrl: 'https://active.example', name: 'Active' });
        const ownerServer = await upsertServerProfile({ serverUrl: 'https://scoped.example', name: 'Owner' });
        await setActiveServerId(activeServer.id, { scope: 'device' });
        await applySelectedHomeForSessionListTest();

        storage.getState().applySessions([
            {
                ...createSession({ sessionId, serverId: ownerServer.id }),
                encryptionMode: 'plain',
            },
        ]);
        storage.getState().resetSessionMessages(sessionId);
        const { buildSessionListRenderableFromSession } = await import('@/sync/domains/session/listing/sessionListRenderable');
        const renderable = buildSessionListRenderableFromSession(storage.getState().sessions[sessionId] as Session);
        storage.getState().applyServerScopedSessionListRows(ownerServer.id, [renderable], {
            source: 'query',
            mode: 'append',
        });

        const { sync } = await import('./sync');

        (sync as any).credentials = { token: tokenForSub('account-a'), secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url') };
        (sync as any).activeServerSessionIds = new Set<string>();
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = false;
        (sync as any).encryption = await Encryption.create(new Uint8Array(32).fill(7));

        requestMock.mockRejectedValue(new Error('active request should not be used'));
        await TokenStorage.setCredentialsForServerUrl(ownerServer.serverUrl, { serverId: ownerServer.id }, { token: scopedToken, secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url') });
        runtimeFetchMock.mockImplementation(async () =>
            new Response(
                JSON.stringify({
                    session: {
                        id: sessionId,
                        createdAt: 1,
                        updatedAt: 2,
                        seq: 3,
                        active: true,
                        activeAt: 2,
                        encryptionMode: 'plain',
                        dataEncryptionKey: null,
                        metadataVersion: 0,
                        metadata: 'null',
                        agentStateVersion: 1,
                        agentState: null,
                        share: null,
                    },
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        );

        await expect(sync.ensureSessionVisibleForMessageRoute(sessionId, { forceRefresh: true })).resolves.toMatchObject({
            kind: 'available',
            sessionId,
            serverId: ownerServer.id,
        });

        expect(requestMock).not.toHaveBeenCalled();
        expectRuntimeFetchWithBearer(
            `https://scoped.example/v2/sessions/${sessionId}`,
            scopedToken,
        );
        expect(storage.getState().sessions[sessionId]?.serverId).toBe(ownerServer.id);
        expect(storage.getState().sessionListRowsByServerId?.[activeServer.id]?.[sessionId]).toBeUndefined();
        expect(
            storage.getState().sessionListIndexByServerId?.[activeServer.id]?.some(
                (item) => item.type === 'session' && item.sessionId === sessionId,
            ) ?? false,
        ).toBe(false);
        expect(storage.getState().sessionListRowsByServerId?.[ownerServer.id]?.[sessionId]).toBeDefined();
        expect(storage.getState().ordinarySessionListMembershipByServerId?.[ownerServer.id] ?? []).not.toContain(sessionId);
        expect((sync as any).activeServerSessionIds.has(sessionId)).toBe(false);
        expect((sync as any).encryption.getSessionEncryption(sessionId)).toBeNull();
    });

    it('hydrates through an explicit serverId override even when the active server differs', async () => {
        const sessionId = 'deep_link_explicit_server';
        const scopedToken = tokenForSub('scoped-account');
        const activeServer = await upsertServerProfile({ serverUrl: 'https://active.example', name: 'Active' });
        const ownerServer = await upsertServerProfile({ serverUrl: 'https://scoped.example', name: 'Owner' });
        await setActiveServerId(activeServer.id, { scope: 'device' });
        await applySelectedHomeForSessionListTest();

        storage.getState().applySessions([
            {
                // The deep link names the owner Home, so the local row this case seeds
                // belongs to that Home and must not appear in the active Home's lists.
                ...createSession({ sessionId, serverId: ownerServer.id }),
                encryptionMode: 'plain',
            },
        ]);
        storage.getState().resetSessionMessages(sessionId);

        const { sync } = await import('./sync');

        (sync as any).credentials = { token: tokenForSub('account-a'), secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url') };
        (sync as any).activeServerSessionIds = new Set<string>();
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = false;
        (sync as any).encryption = await Encryption.create(new Uint8Array(32).fill(7));

        requestMock.mockRejectedValue(new Error('active request should not be used'));
        await TokenStorage.setCredentialsForServerUrl(ownerServer.serverUrl, { serverId: ownerServer.id }, { token: scopedToken, secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url') });
        runtimeFetchMock.mockImplementation(async () =>
            new Response(
                JSON.stringify({
                    session: {
                        id: sessionId,
                        createdAt: 1,
                        updatedAt: 2,
                        seq: 3,
                        active: true,
                        activeAt: 2,
                        encryptionMode: 'plain',
                        dataEncryptionKey: null,
                        metadataVersion: 0,
                        metadata: 'null',
                        agentStateVersion: 1,
                        agentState: null,
                        share: null,
                    },
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        );

        await expect(sync.ensureSessionVisibleForMessageRoute(sessionId, { forceRefresh: true, serverId: ownerServer.id })).resolves.toMatchObject({
            kind: 'available',
            sessionId,
            serverId: ownerServer.id,
        });

        expect(requestMock).not.toHaveBeenCalled();
        expectRuntimeFetchWithBearer(
            `https://scoped.example/v2/sessions/${sessionId}`,
            scopedToken,
        );
        expect(storage.getState().sessions[sessionId]?.serverId).toBe(ownerServer.id);
        expect(storage.getState().sessionListRowsByServerId?.[activeServer.id]?.[sessionId]).toBeUndefined();
        expect(
            storage.getState().sessionListIndexByServerId?.[activeServer.id]?.some(
                (item) => item.type === 'session' && item.sessionId === sessionId,
            ) ?? false,
        ).toBe(false);
        expect(storage.getState().sessionListRowsByServerId?.[ownerServer.id]?.[sessionId]).toBeDefined();
        expect(storage.getState().ordinarySessionListMembershipByServerId?.[ownerServer.id] ?? []).not.toContain(sessionId);
        expect((sync as any).activeServerSessionIds.has(sessionId)).toBe(false);
        expect((sync as any).encryption.getSessionEncryption(sessionId)).toBeNull();
    });

    it('keeps exact-Home System Record runtime authority independent from focus and reuses its hydrated Session', async () => {
        const sessionId = 'system_record_scoped_owner';
        const scopedToken = tokenForSub('scoped-account');
        const activeServer = await upsertServerProfile({ serverUrl: 'https://active-system-record.example', name: 'Active' });
        const ownerServer = await upsertServerProfile({ serverUrl: 'https://scoped-system-record.example', name: 'Owner' });
        await setActiveServerId(activeServer.id, { scope: 'device' });
        await applySelectedHomeForSessionListTest({ token: tokenForSub('active-account') });
        storage.setState({ profileScope: { serverId: activeServer.id, accountId: 'active-account' } });

        const { sync } = await import('./sync');
        (sync as any).credentials = { token: tokenForSub('active-account'), secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url') };
        (sync as any).activeServerSessionIds = new Set<string>();
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = false;
        (sync as any).encryption = null;

        requestMock.mockRejectedValue(new Error('active request should not be used'));
        await TokenStorage.setCredentialsForServerUrl(ownerServer.serverUrl, { serverId: ownerServer.id }, { token: scopedToken });
        runtimeFetchMock.mockImplementation(async (url: string) => {
            if (new URL(url).pathname === '/v1/auth/ping') {
                return Response.json({ success: true });
            }
            if (url !== `https://scoped-system-record.example/v2/sessions/${sessionId}`) {
                return new Response(null, { status: 404 });
            }
            return new Response(JSON.stringify({
                session: {
                    id: sessionId,
                    createdAt: 1,
                    updatedAt: 2,
                    seq: 3,
                    active: true,
                    activeAt: 2,
                    encryptionMode: 'plain',
                    dataEncryptionKey: null,
                    metadataVersion: 0,
                    metadata: JSON.stringify({ path: '/repo', host: 'owner' }),
                    agentStateVersion: 1,
                    agentState: null,
                    share: null,
                },
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        });

        const address = { serverId: ownerServer.id, sessionId };
        await expect(sync.withSessionSystemRecordRuntime(address, async (runtime) => ({
            accountId: runtime.scope.accountId,
            serverId: runtime.session.serverId,
            contentContext: runtime.readContentContext(),
        }))).resolves.toEqual({
            status: 'ok',
            value: {
                accountId: 'scoped-account',
                serverId: ownerServer.id,
                contentContext: { mode: 'plain' },
            },
        });
        await expect(sync.withSessionSystemRecordRuntime(address, async (runtime) => runtime.session.id)).resolves.toEqual({
            status: 'ok',
            value: sessionId,
        });

        expect(requestMock).not.toHaveBeenCalled();
        expect(runtimeFetchMock.mock.calls.filter(([url]) => url === `https://scoped-system-record.example/v2/sessions/${sessionId}`)).toHaveLength(1);

        const { createDeferred } = await import('@/dev/testkit');
        const refresh = createDeferred<Response>();
        runtimeFetchMock.mockImplementation(async (url: string) => {
            if (new URL(url).pathname === '/v1/auth/ping') {
                return Response.json({ success: true });
            }
            if (url !== `https://scoped-system-record.example/v2/sessions/${sessionId}`) {
                return new Response(null, { status: 404 });
            }
            return await refresh.promise.then((response) => response.clone());
        });

        const firstRefresh = sync.withSessionSystemRecordRuntime(
            address,
            async (runtime) => runtime.session.id,
            { forceSessionRefresh: true },
        );
        const secondRefresh = sync.withSessionSystemRecordRuntime(
            address,
            async (runtime) => runtime.session.id,
            { forceSessionRefresh: true },
        );
        await waitForAssertion(() => expect(runtimeFetchMock.mock.calls.filter(
            ([url]) => url === `https://scoped-system-record.example/v2/sessions/${sessionId}`,
        )).toHaveLength(2));
        refresh.resolve(new Response(JSON.stringify({
            session: {
                id: sessionId,
                createdAt: 1,
                updatedAt: 4,
                seq: 4,
                active: true,
                activeAt: 4,
                encryptionMode: 'plain',
                dataEncryptionKey: null,
                metadataVersion: 0,
                metadata: 'null',
                agentStateVersion: 1,
                agentState: null,
                share: null,
            },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

        await expect(Promise.all([firstRefresh, secondRefresh])).resolves.toEqual([
            { status: 'ok', value: sessionId },
            { status: 'ok', value: sessionId },
        ]);
        expect(runtimeFetchMock.mock.calls.filter(
            ([url]) => url === `https://scoped-system-record.example/v2/sessions/${sessionId}`,
        )).toHaveLength(2);
    });

    it('keeps an in-flight non-active Home System Record acquisition current when focus switches to that Home', async () => {
        const { createDeferred } = await import('@/dev/testkit');
        const sessionId = 'system_record_scoped_during_active_reset';
        const scopedToken = tokenForSub('scoped-account');
        const activeServer = await upsertServerProfile({ serverUrl: 'https://active-reset.example', name: 'Active' });
        const ownerServer = await upsertServerProfile({ serverUrl: 'https://scoped-reset.example', name: 'Owner' });
        await setActiveServerId(activeServer.id, { scope: 'device' });
        await applySelectedHomeForSessionListTest({ token: tokenForSub('active-account') });
        storage.setState({ profileScope: { serverId: activeServer.id, accountId: 'active-account' } });

        const { sync } = await import('./sync');
        (sync as any).credentials = { token: tokenForSub('active-account'), secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url') };
        (sync as any).activeServerSessionIds = new Set<string>();
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = false;
        (sync as any).encryption = null;

        requestMock.mockRejectedValue(new Error('active request should not be used'));
        await TokenStorage.setCredentialsForServerUrl(ownerServer.serverUrl, { serverId: ownerServer.id }, { token: scopedToken });
        const response = createDeferred<Response>();
        runtimeFetchMock.mockImplementation(async (url: string) => {
            if (new URL(url).pathname === '/v1/auth/ping') {
                return Response.json({ success: true });
            }
            if (url === `https://scoped-reset.example/v2/sessions/${sessionId}`) return await response.promise;
            return new Response(null, { status: 404 });
        });

        const address = { serverId: ownerServer.id, sessionId };
        const acquisition = sync.withSessionSystemRecordRuntime(address, async (runtime) => runtime.scope.accountId);
        await waitForAssertion(() => expect(runtimeFetchMock.mock.calls.some(
            ([url]) => url === `https://scoped-reset.example/v2/sessions/${sessionId}`,
        )).toBe(true));

        // Switching focus is presentation. The already captured exact-Home
        // credential remains the operation authority while Sync replaces the
        // focused Account runtime around it.
        await setActiveServerId(ownerServer.id, { scope: 'device' });
        (sync as any).resetServerScopedRuntimeState();
        response.resolve(new Response(JSON.stringify({
            session: {
                id: sessionId,
                createdAt: 1,
                updatedAt: 2,
                seq: 3,
                active: true,
                activeAt: 2,
                encryptionMode: 'plain',
                dataEncryptionKey: null,
                metadataVersion: 0,
                metadata: 'null',
                agentStateVersion: 1,
                agentState: null,
                share: null,
            },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

        await expect(acquisition).resolves.toEqual({ status: 'ok', value: 'scoped-account' });
        expect(requestMock).not.toHaveBeenCalled();
    });

    it('retains an observed exact-Home System Record repository across an active-Home switch', async () => {
        const sessionId = 'system_record_repository_across_active_reset';
        const scopedToken = tokenForSub('scoped-account');
        const activeServer = await upsertServerProfile({ serverUrl: 'https://active-repository-reset.example', name: 'Active' });
        const ownerServer = await upsertServerProfile({ serverUrl: 'https://scoped-repository-reset.example', name: 'Owner' });
        await setActiveServerId(activeServer.id, { scope: 'device' });
        await applySelectedHomeForSessionListTest({ token: tokenForSub('active-account') });
        storage.setState({ profileScope: { serverId: activeServer.id, accountId: 'active-account' } });

        const { sync } = await import('./sync');
        (sync as any).credentials = { token: tokenForSub('active-account'), secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url') };
        (sync as any).activeServerSessionIds = new Set<string>();
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = false;
        (sync as any).encryption = null;

        requestMock.mockRejectedValue(new Error('active request should not be used'));
        await TokenStorage.setCredentialsForServerUrl(ownerServer.serverUrl, { serverId: ownerServer.id }, { token: scopedToken });
        runtimeFetchMock.mockImplementation(async (url: string) => {
            if (new URL(url).pathname === '/v1/auth/ping') {
                return Response.json({ success: true });
            }
            if (url !== `https://scoped-repository-reset.example/v2/sessions/${sessionId}`) {
                return new Response(null, { status: 404 });
            }
            return new Response(JSON.stringify({
                session: {
                    id: sessionId,
                    createdAt: 1,
                    updatedAt: 2,
                    seq: 3,
                    active: true,
                    activeAt: 2,
                    encryptionMode: 'plain',
                    dataEncryptionKey: null,
                    metadataVersion: 0,
                    metadata: 'null',
                    agentStateVersion: 1,
                    agentState: null,
                    share: null,
                },
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        });

        const address = { serverId: ownerServer.id, sessionId };
        let firstRepository: unknown;
        let firstCurrentness: (() => boolean) | undefined;
        await expect(sync.withSessionSystemRecordRuntime(address, async (runtime) => {
            firstRepository = runtime.repository;
            firstCurrentness = runtime.isCurrent;
            return runtime.scope.accountId;
        })).resolves.toEqual({ status: 'ok', value: 'scoped-account' });

        await setActiveServerId(ownerServer.id, { scope: 'device' });
        (sync as any).resetServerScopedRuntimeState();

        expect(firstCurrentness?.()).toBe(true);
        await expect(sync.withSessionSystemRecordRuntime(address, async (runtime) => runtime.repository === firstRepository)).resolves.toEqual({
            status: 'ok',
            value: true,
        });
    });

    it('does not recreate active message synchronization after captured-authority hydration completes following a reset', async () => {
        const sessionId = 'captured_authority_after_reset';
        const activeServer = await upsertServerProfile({
            serverUrl: 'https://same-server.example',
            name: 'Same server',
        });
        await setActiveServerId(activeServer.id, { scope: 'device' });
        const { disconnectActiveServerConnection } = await import('./runtime/orchestration/connectionManager');
        await disconnectActiveServerConnection();
        const scope = {
            serverId: activeServer.id,
            accountId: 'account-a',
        };
        storage.setState({ profileScope: scope });
        const credentials = { token: tokenForSub(scope.accountId) };
        await TokenStorage.setCredentialsForServerUrl(activeServer.serverUrl, { serverId: activeServer.id }, credentials);
        const { subscribeHomeCredentialChange } = await import('./runtime/orchestration/homeAccountChange');
        let credentialCurrent = true;
        const unsubscribe = subscribeHomeCredentialChange(({ serverId }) => {
            if (serverId === activeServer.id) credentialCurrent = false;
        });
        onTestFinished(unsubscribe);
        const { captureServerRequestAuthorityForServerAccountScope } = await import('./runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope');
        const { apiSocket } = await import('./api/session/apiSocket');
        const authority = await captureServerRequestAuthorityForServerAccountScope({
            scope,
            activeRequest: apiSocket.request,
        });
        onTestFinished(authority.release);
        const hydrationResponse = createDeferred<Response>();
        const requested = createDeferred<void>();
        const defaultFetch = runtimeFetchMock.getMockImplementation()!;
        runtimeFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
            const path = new URL(url).pathname;
            if (path === `/v2/sessions/${sessionId}`) {
                requested.resolve();
                return hydrationResponse.promise;
            }
            return defaultFetch(url, init);
        });

        const { sync } = await import('./sync');

        const hydration = sync.ensureSessionVisibleForMessageRoute(sessionId, {
            forceRefresh: true,
            serverId: activeServer.id,
            authority,
            scopeCurrentness: () => credentialCurrent,
        });
        await requested.promise;

        (sync as any).messagesSync.clear();
        storage.getState().resetSessionMessages(sessionId);
        hydrationResponse.resolve(new Response(JSON.stringify({
            session: {
                id: sessionId,
                createdAt: 1,
                updatedAt: 2,
                seq: 3,
                active: false,
                activeAt: 2,
                encryptionMode: 'plain',
                dataEncryptionKey: null,
                metadataVersion: 0,
                metadata: 'null',
                agentStateVersion: 0,
                agentState: null,
                share: null,
            },
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }));

        await expect(hydration).resolves.toMatchObject({
            kind: 'available',
            sessionId,
        });
        expect((sync as any).messagesSync.has(sessionId)).toBe(false);
        expect(requestMock).not.toHaveBeenCalled();
        expect(storage.getState().sessionMessages[sessionId]).toBeUndefined();
        expectRuntimeFetchWithBearer(`${activeServer.serverUrl}/v2/sessions/${sessionId}`, credentials.token);

        const ordinarySessionId = 'ordinary_hydration_after_reset';
        runtimeFetchMock.mockImplementation(defaultFetch);
        await applySelectedHomeForSessionListTest(credentials);
        requestMock.mockImplementation(async (path: string) => {
            if (path === `/v2/sessions/${ordinarySessionId}`) {
                return new Response(JSON.stringify({
                    session: {
                        id: ordinarySessionId,
                        createdAt: 1,
                        updatedAt: 2,
                        seq: 3,
                        active: false,
                        activeAt: 2,
                        encryptionMode: 'plain',
                        dataEncryptionKey: null,
                        metadataVersion: 0,
                        metadata: 'null',
                        agentStateVersion: 0,
                        agentState: null,
                        share: null,
                    },
                }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            return new Response(JSON.stringify({
                messages: [],
                hasMore: false,
                nextBeforeSeq: null,
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        });

        await expect(sync.ensureSessionVisibleForMessageRoute(ordinarySessionId, {
            forceRefresh: true,
        })).resolves.toMatchObject({
            kind: 'available',
            sessionId: ordinarySessionId,
        });
        expect((sync as any).messagesSync.has(ordinarySessionId)).toBe(true);
    });

    it('initializes encrypted explicit-server route hydration with the owner server scope', async () => {
        const sessionId = 'deep_link_explicit_server_encrypted';
        const activeServer = await upsertServerProfile({ serverUrl: 'https://active.example', name: 'Active' });
        const ownerServer = await upsertServerProfile({ serverUrl: 'https://scoped.example', name: 'Owner' });
        await setActiveServerId(activeServer.id, { scope: 'device' });
        await applySelectedHomeForSessionListTest();
        const fixture = await createEncryptedSessionFixture(sessionId);
        const scopedCredentials = { ...fixture.credentials, token: tokenForSub('scoped-account') };
        await TokenStorage.setCredentialsForServerUrl(ownerServer.serverUrl, { serverId: ownerServer.id }, scopedCredentials);
        const { sync } = await import('./sync');
        const activeEncryption = await Encryption.create(new Uint8Array(32).fill(9));
        Reflect.set(sync, 'encryption', activeEncryption);
        requestMock.mockRejectedValue(new Error('active request should not be used'));
        runtimeFetchMock.mockImplementation(async (url: string) => {
            if (new URL(url).pathname === '/v1/auth/ping') return Response.json({ success: true });
            return Response.json({ session: fixture.row });
        });
        await expect(sync.ensureSessionVisibleForMessageRoute(sessionId, {
            forceRefresh: true, serverId: ownerServer.id,
        })).resolves.toMatchObject({ kind: 'available', sessionId, serverId: ownerServer.id });
        expectRuntimeFetchWithBearer(`https://scoped.example/v2/sessions/${sessionId}`, scopedCredentials.token);
        expect(storage.getState().sessions[sessionId]).toMatchObject({
            serverId: ownerServer.id, metadata: { path: '/repo', host: 'host' }, agentState: { controlledByUser: true },
        });
        expect(activeEncryption.getSessionEncryption(sessionId)).toBeNull();
        expect(requestMock.mock.calls.filter(([path]) => String(path).startsWith(`/v2/sessions/${sessionId}`) || String(path).startsWith(`/v1/sessions/${sessionId}/`))).toEqual([]);
    });

    it('fails closed on an unknown explicit route Home without requesting the active Home', async () => {
        const sessionId = 'deep_link_stale_route_server_id';
        const activeServer = await upsertServerProfile({ serverUrl: 'http://localhost:52753', name: 'Active' });
        await setActiveServerId(activeServer.id, { scope: 'device' });
        await applySelectedHomeForSessionListTest();
        storage.getState().resetSessionMessages(sessionId);

        const { sync } = await import('./sync');

        (sync as any).credentials = { token: tokenForSub('account-a'), secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url') };
        (sync as any).activeServerSessionIds = new Set<string>();
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = false;
        (sync as any).encryption = await Encryption.create(new Uint8Array(32).fill(7));

        requestMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    session: {
                        id: sessionId,
                        createdAt: 1,
                        updatedAt: 2,
                        seq: 3,
                        active: true,
                        activeAt: 2,
                        encryptionMode: 'plain',
                        dataEncryptionKey: null,
                        metadataVersion: 0,
                        metadata: 'null',
                        agentStateVersion: 0,
                        agentState: null,
                        share: null,
                    },
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        );

        await expect(sync.ensureSessionVisibleForMessageRoute(sessionId, {
            forceRefresh: true,
            serverId: '127.0.0.1-52753',
        })).resolves.toMatchObject({
            kind: 'missing',
            sessionId,
            serverId: '127.0.0.1-52753',
            cause: 'not_found',
        });

        expect(runtimeFetchMock).not.toHaveBeenCalled();
        expect(requestMock).not.toHaveBeenCalled();
        expect((sync as any).activeServerSessionIds.has(sessionId)).toBe(false);
    });

    it('keeps an explicit route Home through missing credentials despite a hydrated same-ID Session on the active Home', async () => {
        const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
        const { useHydrateSessionForRoute } = await import('@/hooks/session/useHydrateSessionForRoute');
        const requested = await upsertServerProfile({ serverUrl: 'https://route-a.example.test', name: 'A' });
        const active = await upsertServerProfile({ serverUrl: 'https://route-b.example.test', name: 'B' });
        await setActiveServerId(active.id, { scope: 'device' });
        await applySelectedHomeForSessionListTest();
        const { sync } = await import('./sync');
        Reflect.set(sync, 'credentials', null);
        const session = createSessionFixture({ id: 'duplicate-route', serverId: active.id, encryptionMode: 'plain' });
        storage.setState({ sessions: { [session.id]: session } });

        const hook = await renderHook(() => useHydrateSessionForRoute(session.id, 'exact-home', { serverId: requested.id }));

        await waitForAssertion(() => expect(hook.getCurrent()).toMatchObject({
            kind: 'retrying', sessionId: session.id, serverId: requested.id,
        }));
        expect(storage.getState().sessions[session.id].serverId).toBe(active.id);
        expect(requestMock).not.toHaveBeenCalled();
        expect(runtimeFetchMock.mock.calls.filter(([url]) => /^\/v[12]\/sessions(?:\/|$)/.test(new URL(String(url)).pathname))).toEqual([]);
    });

    it('accepts a profile-proven canonical alias for an already hydrated route Home', async () => {
        const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
        const { useHydrateSessionForRoute } = await import('@/hooks/session/useHydrateSessionForRoute');
        const { adoptHomeProfile, areServerProfileIdentifiersEquivalent } = await import('@/sync/domains/server/serverProfiles');
        const legacy = await upsertServerProfile({ serverUrl: 'https://route-alias.example.test', name: 'Alias' });
        const canonical = await adoptHomeProfile({ source: 'manual', descriptor: {
            serverUrl: legacy.serverUrl, homeServerIdentityId: 'srv_route_alias',
        } });
        await setActiveServerId(canonical.id, { scope: 'device' });
        await applySelectedHomeForSessionListTest();
        expect(areServerProfileIdentifiersEquivalent(legacy.id, canonical.id)).toBe(true);
        const session = createSessionFixture({ id: 'alias-route', serverId: canonical.id, encryptionMode: 'plain' });
        storage.setState({ sessions: { [session.id]: session } });

        const hook = await renderHook(() => useHydrateSessionForRoute(session.id, 'alias-home', { serverId: legacy.id }));

        expect(hook.getCurrent()).toMatchObject({ kind: 'available', sessionId: session.id, serverId: legacy.id });
        expect(requestMock).not.toHaveBeenCalled();
    });

    it('ignores localStorage read errors while evaluating debug hydration logging', async () => {
        const sessionId = 'deep_link_local_storage_error';
        storage.getState().applySessions([
            {
                ...createSession({ sessionId }),
                metadataVersion: 1,
                metadata: {
                    path: '/repo',
                    host: 'host',
                    machineId: 'machine-1',
                },
                agentStateVersion: 1,
                agentState: {
                    controlledByUser: true,
                    requests: {},
                    completedRequests: {},
                },
            } as Session,
        ]);

        const localStorageMock = {
            getItem: vi.fn(() => {
                throw new Error('storage blocked');
            }),
        };
        vi.stubGlobal('localStorage', localStorageMock as unknown as Storage);
        onTestFinished(() => {
            vi.unstubAllGlobals();
        });

        const { sync } = await import('./sync');
        (sync as any).credentials = { token: tokenForSub('account-a') };
        (sync as any).activeServerSessionIds = new Set<string>([sessionId]);
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;
        (sync as any).encryption = await Encryption.create(new Uint8Array(32).fill(7));
        await (sync as any).encryption.initializeSessions(new Map([[sessionId, new Uint8Array(32).fill(8)]]));

        await expect(sync.ensureSessionVisibleForMessageRoute(sessionId)).resolves.toMatchObject({
            kind: 'available',
            sessionId,
        });
        expect(localStorageMock.getItem).toHaveBeenCalledWith('happier.debug.sessionHydrate');
    });

    it('records terminal auth and stops route hydration when session-by-id returns 401', async () => {
        const sessionId = 'deep_link_auth_failed';
        storage.getState().resetSessionMessages(sessionId);
        const home = getActiveServerSnapshot();
        const { disconnectActiveServerConnection } = await import('./runtime/orchestration/connectionManager');
        await disconnectActiveServerConnection();
        const credentials = { token: tokenForSub('deep-link-account') };
        await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.serverId }, credentials);
        const { subscribeHomeCredentialChange } = await import('./runtime/orchestration/homeAccountChange');
        let credentialCurrent = true;
        const unsubscribe = subscribeHomeCredentialChange(({ serverId }) => {
            if (serverId === home.serverId) credentialCurrent = false;
        });
        onTestFinished(unsubscribe);
        const { captureServerRequestAuthorityForServerAccountScope } = await import('./runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope');
        const { apiSocket } = await import('./api/session/apiSocket');
        const authority = await captureServerRequestAuthorityForServerAccountScope({
            serverId: home.serverId,
            activeRequest: apiSocket.request,
        });
        onTestFinished(authority.release);
        const { sync } = await import('./sync');
        runtimeFetchMock.mockImplementation(async (url: string) => {
            if (new URL(url).pathname === '/v1/auth/ping') return Response.json({ success: true });
            return Response.json({ error: 'auth failed' }, { status: 401 });
        });
        await expect(sync.ensureSessionVisibleForMessageRoute(sessionId, {
            serverId: home.serverId,
            authority,
            scopeCurrentness: () => credentialCurrent,
        })).resolves.toMatchObject({
            kind: 'missing',
            sessionId,
            cause: 'unauthorized',
        });

        expect(storage.getState().syncError).toMatchObject({
            kind: 'auth',
            retryable: false,
            message: 'Authentication required',
        });
        expectRuntimeFetchWithBearer(`${home.serverUrl}/v2/sessions/${sessionId}`, credentials.token);
        expect(requestMock).not.toHaveBeenCalled();
    });
});
