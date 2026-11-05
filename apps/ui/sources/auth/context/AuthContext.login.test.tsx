import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import * as SecureStore from 'expo-secure-store';
import { AUTHORING_MEMORY_ROUTE_V1, AuthoringMemoryListResponseV1Schema } from '@happier-dev/protocol';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { createDeferred, renderScreen, standardCleanup } from '@/dev/testkit';
import { initializeAuthRouteRuntimeForTests } from '@/dev/testkit/harness/authRouteRuntimeHarness';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import tweetnacl from 'tweetnacl';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { encodeBase64 } from '@/encryption/base64';

// Analytics is an external service boundary; the logout ordering contract observes it.
vi.mock('@/track', () => ({
    trackLogout: vi.fn(),
    initializeTracking: vi.fn(),
    tracking: null,
}));

const desktopEvents = new Map<string, Set<(event: { payload: unknown }) => void>>();

// Exercise the real native SDK through the OS invoke/callback boundary. Dynamic
// imports in the real Auth/Sync graph can execute outside Vitest's module mocks.
function installDesktopBoundary(handle: (command: string, args?: Record<string, unknown>) => unknown = () => undefined) {
    const callbacks = new Map<number, (event: { payload: unknown }) => void>();
    const subscriptions = new Map<number, { event: string; callback: (event: { payload: unknown }) => void }>();
    let nextId = 0;
    const unregisterListener = (_event: string, id: number) => {
        const subscription = subscriptions.get(id);
        if (subscription) desktopEvents.get(subscription.event)?.delete(subscription.callback);
        subscriptions.delete(id);
    };
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
        if (command === 'plugin:event|listen') {
            const event = String(args?.event);
            const callback = callbacks.get(Number(args?.handler));
            if (!callback) throw new Error('Native callback is missing');
            const id = ++nextId;
            const listeners = desktopEvents.get(event) ?? new Set();
            listeners.add(callback);
            desktopEvents.set(event, listeners);
            subscriptions.set(id, { event, callback });
            return id;
        }
        if (command === 'plugin:event|unlisten') {
            unregisterListener(String(args?.event), Number(args?.eventId));
            return;
        }
        return await handle(command, args);
    });
    const internals = {
        invoke, metadata: { currentWindow: { label: 'main' } },
        transformCallback: (callback: (event: { payload: unknown }) => void) => {
            const id = ++nextId;
            callbacks.set(id, callback);
            return id;
        },
    };
    const primaryWindow = {
        location: { href: 'tauri://localhost/' },
        __TAURI_INTERNALS__: internals,
        __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener },
    };
    vi.stubGlobal('__TAURI_INTERNALS__', internals);
    vi.stubGlobal('window', primaryWindow);
    return { invoke, internals, primaryWindow };
}

// Real Auth, Home profile, connection and Sync owners over the harness network/socket boundaries.
await initializeAuthRouteRuntimeForTests();
const { AuthProvider, getCurrentAuth, setCurrentAuth } = await import('./AuthContext');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const profiles = await import('@/sync/domains/server/serverProfiles');
const connection = await import('@/sync/runtime/orchestration/connectionManager');
const { sync } = await import('@/sync/sync');
const { getStorage } = await import('@/sync/domains/state/storageStore');
const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
const { trackLogout } = await import('@/track');
const { settingsParse } = await import('@/sync/domains/settings/settings');
const { saveExpoPushTokenGeneration } = await import('@/sync/domains/state/pushTokenRegistration');
const { accountDirectoryCredentialStorage } = await import('@/auth/accountDirectory/accountDirectoryCredentialStorage');
const storage = getStorage();

const LEGACY_SECRET = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const contentKeyPair = tweetnacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(7));

function buildTokenWithSub(sub: string): string {
    return `hdr.${Buffer.from(JSON.stringify({ sub })).toString('base64')}.sig`;
}

/** The Homes' network: Sync bootstrap answers for a Plain Account, push cleanup DELETEs recorded. */
const network = {
    deletes: [] as string[],
    beforeDelete: null as ((url: URL) => Promise<void>) | null,
    beforeAccountMode: null as (() => Promise<void>) | null,
};

function installHomesNetwork() {
    setRuntimeFetch(async (input, init) => {
        const url = new URL(String(input));
        const method = String(init?.method ?? 'GET').toUpperCase();
        if (method === 'DELETE' && url.pathname.startsWith('/v1/push-tokens/')) {
            network.deletes.push(url.href);
            await network.beforeDelete?.(url);
            return Response.json({ success: true });
        }
        if (url.pathname === '/health' || url.pathname === '/v1/auth/ping') return Response.json({ ok: true });
        if (url.pathname === '/v1/account/encryption') {
            await network.beforeAccountMode?.();
            return Response.json({ mode: 'plain', updatedAt: 1 });
        }
        if (url.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
        if (url.pathname === '/v1/machines') return Response.json([]);
        if (url.pathname === '/v2/account/settings') return Response.json({ content: null, version: 0 });
        if (url.pathname === AUTHORING_MEMORY_ROUTE_V1) return Response.json(AuthoringMemoryListResponseV1Schema.parse({ rows: [] }));
        if (url.pathname === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`) return Response.json(createPlainProjectAccountRowListFixture());
        if (url.pathname === '/v1/features') return Response.json(createRootLayoutFeaturesResponse({ features: {
            encryption: { plaintextStorage: { enabled: true } }, e2ee: { keylessAccounts: { enabled: true } },
        } }));
        return new Response('{}', { status: 404 });
    });
}

let homeSequence = 0;

/** Saved Homes with stable identities; each test gets its own so device caches never carry over. */
async function prepareHomes<const Name extends string>(...names: Name[]) {
    const sequence = homeSequence++;
    const homes = {} as Record<Name, { serverId: string; serverUrl: string }>;
    for (const name of names) {
        const profile = await profiles.upsertServerProfile({ serverUrl: `https://home-${name}-${sequence}.example.test`, name: `Home ${name}` });
        const serverId = `srv_login_home_${name}_${sequence}`;
        await profiles.setServerProfileIdentityForUrl(profile.serverUrl, serverId);
        homes[name] = { serverId, serverUrl: profile.serverUrl };
    }
    return homes;
}

async function focusHome(home: Readonly<{ serverId: string }>) {
    await profiles.setActiveServerId(home.serverId);
}

async function storeCredentials(home: Readonly<{ serverId: string; serverUrl: string }>, credentials: AuthCredentials) {
    expect(await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.serverId }, credentials)).toBe(true);
}

async function readCredentials(home: Readonly<{ serverId: string; serverUrl: string }>) {
    return await TokenStorage.getCredentialsForServerUrl(home.serverUrl, { serverId: home.serverId });
}

async function markFirstKeyCustody(home: Readonly<{ serverId: string; serverUrl: string }>, accountId: string) {
    await expect(TokenStorage.setPendingExternalAuth({
        provider: 'github',
        proof: 'proof',
        secret: 'secret',
        serverId: home.serverId,
        serverUrl: home.serverUrl,
        accountEncryptionFirstKey: {
            accountId,
            requestDigest: `aemrb1_${'A'.repeat(43)}`,
            requestJson: '{}',
            pending: 'pending',
            createdAt: Date.now(),
            expiresAt: Date.now() + 60_000,
            migrationSubmissionAttempted: true,
        },
    }, { serverUrl: home.serverUrl, serverId: home.serverId })).resolves.toBe(true);
}

function pushTokenDeletes(...homes: ReadonlyArray<Readonly<{ serverUrl: string }>>): string[] {
    const origins = homes.map(home => new URL(home.serverUrl).origin);
    return network.deletes.filter(url => origins.includes(new URL(url).origin)).sort();
}

function pushTokenDeleteUrls(home: Readonly<{ serverUrl: string }>, tokens: readonly string[]): string[] {
    return tokens.map(token => `${home.serverUrl}/v1/push-tokens/${encodeURIComponent(token)}`);
}

async function mountAuth(initialCredentials: AuthCredentials | null) {
    return await renderScreen(<AuthProvider initialCredentials={initialCredentials}><></></AuthProvider>);
}

describe('AuthContext.login', () => {
    beforeEach(async () => {
        await connection.disconnectActiveServerConnection();
        network.deletes = [];
        network.beforeDelete = null;
        network.beforeAccountMode = null;
        installHomesNetwork();
        setCurrentAuth(null);
        vi.mocked(trackLogout).mockClear();
    });

    afterEach(async () => {
        await standardCleanup();
        await connection.disconnectActiveServerConnection();
        vi.restoreAllMocks();
        setCurrentAuth(null);
        vi.unstubAllGlobals();
        desktopEvents.clear();
    });

    it('closes outgoing Account windows after logout guards and before removing only the addressed Home credential', async () => {
        const { a, b } = await prepareHomes('a', 'b');
        const outgoing = { token: buildTokenWithSub('desktop-outgoing') };
        const other = { token: buildTokenWithSub('desktop-outgoing') };
        await storeCredentials(a, outgoing);
        await storeCredentials(b, other);
        await focusHome(a);
        const directoryTarget = { endpoint: 'https://desktop-accounts.example.test', serverIdentityId: 'desktop-directory' };
        await accountDirectoryCredentialStorage.set(directoryTarget, { token: buildTokenWithSub('directory-owner') });
        const order: string[] = [];
        const { invoke } = installDesktopBoundary(async (command, args) => {
            if (command !== 'desktop_app_windows_teardown') return;
            expect(args).toEqual({ scopes: [{ serverId: a.serverId, accountId: 'desktop-outgoing' }] });
            order.push('teardown');
        });
        const screen = await mountAuth(outgoing);
        try {
            await act(async () => {
                await getCurrentAuth()!.logout({
                    target: a, expectedCredentials: outgoing,
                    beforeMutation: () => { order.push('guarded-effect'); },
                });
            });
            expect(order).toEqual(['guarded-effect', 'teardown']);
            expect(invoke.mock.calls.filter(([command]) => command === 'desktop_app_windows_teardown')).toHaveLength(1);
            expect(await readCredentials(a)).toBeNull();
            expect(await readCredentials(b)).toEqual(other);
            expect(await accountDirectoryCredentialStorage.get(directoryTarget)).toEqual({ token: buildTokenWithSub('directory-owner') });
        } finally { await screen.unmount(); }
    });

    it('closes replaced Account windows once before publishing the new credential, with no teardown for token refresh or Home navigation', async () => {
        const { a, b } = await prepareHomes('a', 'b');
        const outgoing = { token: buildTokenWithSub('desktop-account-a') };
        const incoming = { token: buildTokenWithSub('desktop-account-b') };
        await storeCredentials(a, outgoing);
        await storeCredentials(b, { token: buildTokenWithSub('desktop-home-b') });
        await focusHome(a);
        const { invoke } = installDesktopBoundary(async (command, args) => {
            if (command !== 'desktop_app_windows_teardown') return;
            expect(args).toEqual({ scopes: [{ serverId: a.serverId, accountId: 'desktop-account-a' }] });
            expect(getCurrentAuth()?.credentials).toEqual(outgoing);
        });
        const screen = await mountAuth(outgoing);
        try {
            await act(async () => { await getCurrentAuth()!.loginWithCredentials(incoming); });
            expect(invoke.mock.calls.filter(([command]) => command === 'desktop_app_windows_teardown')).toHaveLength(1);
            expect(await readCredentials(a)).toEqual(incoming);
            invoke.mockClear();
            await act(async () => { await getCurrentAuth()!.loginWithCredentials({ token: `${incoming.token}-refreshed` }); });
            await act(async () => { await focusHome(b); await getCurrentAuth()!.refreshFromActiveServer(); });
            expect(invoke.mock.calls.filter(([command]) => command === 'desktop_app_windows_teardown')).toHaveLength(0);
        } finally { await screen.unmount(); }
    });

    it('leaves Account windows interactive when the pre-mutation logout guard cancels', async () => {
        const { home } = await prepareHomes('home');
        const credentials = { token: buildTokenWithSub('desktop-cancelled') };
        await storeCredentials(home, credentials);
        await focusHome(home);
        const { invoke } = installDesktopBoundary();
        const screen = await mountAuth(credentials);
        try {
            await expect(getCurrentAuth()!.logout({ beforeMutation: () => { throw new Error('cancelled'); } })).rejects.toThrow('cancelled');
            expect(invoke.mock.calls.filter(([command]) => command === 'desktop_app_windows_teardown')).toHaveLength(0);
            expect(await readCredentials(home)).toEqual(credentials);
        } finally { await screen.unmount(); }
    });

    it('retires every forgotten Account once in one native lifecycle operation for all-credentials logout', async () => {
        const { a, b, c } = await prepareHomes('a', 'b', 'c');
        const outgoing = { token: buildTokenWithSub('desktop-forget-all-a') };
        await storeCredentials(a, outgoing);
        await storeCredentials(b, { token: buildTokenWithSub('desktop-forget-all-b') });
        await storeCredentials(c, outgoing);
        await focusHome(a);
        const { invoke } = installDesktopBoundary();
        const screen = await mountAuth(outgoing);
        try {
            await act(async () => { await getCurrentAuth()!.logout({ scope: 'all-credentials' }); });
            const teardownCalls = invoke.mock.calls.filter(([command]) => command === 'desktop_app_windows_teardown');
            expect(teardownCalls).toHaveLength(1);
            expect(teardownCalls[0]?.[1]?.scopes).toEqual(expect.arrayContaining([
                { serverId: a.serverId, accountId: 'desktop-forget-all-a' },
                { serverId: b.serverId, accountId: 'desktop-forget-all-b' },
                { serverId: c.serverId, accountId: 'desktop-forget-all-a' },
            ]));
            expect(await readCredentials(a)).toBeNull();
            expect(await readCredentials(b)).toBeNull();
            expect(await readCredentials(c)).toBeNull();
        } finally { await screen.unmount(); }
    });

    it('refreshes stale primary auth from persisted credentials when native completes an Account teardown', async () => {
        const { home } = await prepareHomes('home');
        const outgoing = { token: buildTokenWithSub('desktop-stale-primary') };
        await storeCredentials(home, outgoing);
        await focusHome(home);
        await connection.switchConnectionToActiveServer();
        // Another realm completed the persisted mutation while main retained its in-memory auth.
        await TokenStorage.removeCredentialsForServerUrl(home.serverUrl, { serverId: home.serverId });
        installDesktopBoundary();
        const screen = await mountAuth(outgoing);
        try {
            expect(getCurrentAuth()?.credentials).toEqual(outgoing);
            expect(sync.getCredentials()).toEqual(outgoing);
            await vi.waitFor(() => expect(desktopEvents.get('desktopAppWindow://account-teardown')?.size).toBe(1));
            await act(async () => {
                for (const listener of desktopEvents.get('desktopAppWindow://account-teardown') ?? []) {
                    listener({ payload: { sourceWindowLabel: 'destination_other', mutations: [
                        { kind: 'credentials_removed', serverId: home.serverId, serverUrl: home.serverUrl },
                    ] } });
                }
                await vi.waitFor(() => expect(sync.getCredentials()).toBeNull());
            });
            expect(getCurrentAuth()?.credentials).toBeNull();
        } finally { await screen.unmount(); }
    });

    it('routes secondary logout to the primary admitted mutation without sending a bearer or losing its guard ordering', async () => {
        const { home } = await prepareHomes('home');
        const outgoing = { token: buildTokenWithSub('desktop-secondary-account') };
        await storeCredentials(home, outgoing);
        await focusHome(home);
        await connection.switchConnectionToActiveServer();
        const order: string[] = [];
        const { invoke, internals, primaryWindow } = installDesktopBoundary(async (command, args) => {
            if (command === 'desktop_app_windows_teardown') order.push('teardown');
            if (command === 'desktop_app_windows_auth_changed') {
                // Native emit returns without awaiting renderer credential readers.
                // The committed persisted outcome is asserted after logout settles below.
                order.push('committed');
                for (const listener of desktopEvents.get('desktopAppWindow://account-teardown') ?? []) {
                    listener({ payload: { sourceWindowLabel: 'main', mutations: args?.mutations } });
                }
            }
            const event = command === 'desktop_window_emit_action' ? 'desktopWindow://action'
                : command === 'desktop_window_emit_action_result' ? 'desktopWindow://action-result' : null;
            if (event) {
                expect(JSON.stringify(args?.payload)).not.toContain(outgoing.token);
                for (const listener of desktopEvents.get(event) ?? []) listener({ payload: args?.payload });
            }
        });
        const primary = await mountAuth(outgoing);
        let secondary: Awaited<ReturnType<typeof mountAuth>> | undefined;
        try {
            await vi.waitFor(() => expect(desktopEvents.get('desktopWindow://action')?.size).toBe(1));
            internals.metadata.currentWindow.label = 'destination_test';
            vi.stubGlobal('window', { ...primaryWindow, location: { href: 'tauri://localhost/desktop/window?id=test' } });
            secondary = await mountAuth(outgoing);
            await act(async () => {
                await getCurrentAuth()!.logout({ beforeMutation: () => { order.push('guarded-effect'); } });
            });
            expect(order).toEqual(['guarded-effect', 'teardown', 'committed']);
            expect(invoke.mock.calls.filter(([command]) => command === 'desktop_window_emit_action')).toHaveLength(1);
            expect(invoke.mock.calls.filter(([command]) => command === 'desktop_app_windows_teardown')).toHaveLength(1);
            expect(await readCredentials(home)).toBeNull();
            // The primary owner, rather than only the originating secondary, retired its auth.
            expect(getCurrentAuth()?.credentials).toBeNull();
            internals.metadata.currentWindow.label = 'main';
            vi.stubGlobal('window', primaryWindow);
            await secondary.unmount();
            secondary = undefined;
            expect(sync.getCredentials()).toBeNull();
        } finally { await secondary?.unmount(); await primary.unmount(); }
    });

    it('keeps the session authenticated while a login-triggered server refresh is still rebinding credentials', async () => {
        const { home } = await prepareHomes('home');
        await focusHome(home);
        const previousState = storage.getState();
        storage.getState().applyLocalSettings({ hasCompletedAuthOnce: false }, { source: 'test' });
        storage.setState(state => ({ settings: settingsParse({ ...state.settings,
            actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } } }) }));
        // Hold the login-triggered rebind inside its Sync bootstrap.
        const rebindStarted = createDeferred<void>();
        const releaseRebind = createDeferred<void>();
        network.beforeAccountMode = async () => {
            rebindStarted.resolve();
            await releaseRebind.promise;
        };
        const credentials = { token: buildTokenWithSub('server-test'), secret: LEGACY_SECRET };
        const screen = await mountAuth(null);
        let refresh: Promise<void> | undefined;
        try {
            const auth = getCurrentAuth()!;
            await act(async () => {
                await expect(auth.login(credentials.token, credentials.secret)).resolves.toEqual({ kind: 'completed' });
                await rebindStarted.promise;
            });
            expect(getCurrentAuth()).toMatchObject({ isAuthenticated: true, credentials });
            // The device remembers a completed sign-in even when the UI settings Action surface is disabled.
            expect(storage.getState().localSettings.hasCompletedAuthOnce).toBe(true);

            // A refresh issued while the rebind is in flight settles with it and keeps the session.
            refresh = auth.refreshFromActiveServer();
            expect(getCurrentAuth()?.isAuthenticated).toBe(true);
            await act(async () => {
                releaseRebind.resolve();
                await refresh;
            });
            expect(getCurrentAuth()).toMatchObject({ isAuthenticated: true, credentials });
        } finally {
            releaseRebind.resolve();
            await act(async () => { await refresh?.catch(() => undefined); });
            await screen.unmount();
            storage.setState(previousState, true);
        }
    });

    it('stores an exact-target Home credential without replacing the newly focused Home auth projection', async () => {
        const { a: homeA, b: homeB } = await prepareHomes('a', 'b');
        const homeACredentials = { token: buildTokenWithSub('home-a') };
        const homeBCredentials = { token: buildTokenWithSub('home-b') };
        await storeCredentials(homeB, homeBCredentials);
        await focusHome(homeB);
        await connection.switchConnectionToActiveServer();
        const screen = await mountAuth(homeBCredentials);

        try {
            await act(async () => {
                await expect(getCurrentAuth()!.loginWithCredentials(homeACredentials, { target: homeA }))
                    .resolves.toEqual({ kind: 'completed' });
            });

            await expect(readCredentials(homeA)).resolves.toEqual(homeACredentials);
            expect(getCurrentAuth()).toMatchObject({ isAuthenticated: true, credentials: homeBCredentials });
            // The focused connection still runs Home B's Account.
            expect(connection.getAppliedActiveServerId()).toBe(homeB.serverId);
            expect(sync.getCredentials()).toEqual(homeBCredentials);
        } finally {
            await screen.unmount();
        }
    });

    it('does not publish exact-target credentials after focus changes while suppression clears', async () => {
        const { a: homeA, b: homeB } = await prepareHomes('a', 'b');
        const homeACredentials = { token: buildTokenWithSub('home-a') };
        await focusHome(homeA);
        const screen = await mountAuth(null);
        const writeStarted = createDeferred<void>();
        const releaseWrite = createDeferred<void>();
        const writeSecureStore = SecureStore.setItemAsync;
        let held = false;
        // Hold the suppression clear at the native store: focus moves to Home B during that await.
        vi.spyOn(SecureStore, 'setItemAsync').mockImplementation(async (key, value) => {
            if (!held && key.includes('auth_auto_redirect_suppressed_until')) {
                held = true;
                writeStarted.resolve();
                await releaseWrite.promise;
            }
            return await writeSecureStore(key, value);
        });
        let login: Promise<unknown> | undefined;
        try {
            await act(async () => {
                login = getCurrentAuth()!.loginWithCredentials(homeACredentials, { target: homeA });
                void login.catch(() => undefined);
                await writeStarted.promise;
                await focusHome(homeB);
                await connection.switchConnectionToActiveServer();
            });
            await act(async () => {
                releaseWrite.resolve();
                await expect(login).resolves.toEqual({ kind: 'completed' });
            });

            await expect(readCredentials(homeA)).resolves.toEqual(homeACredentials);
            expect(getCurrentAuth()).toMatchObject({ isAuthenticated: false, credentials: null });
            expect(connection.getAppliedActiveServerId()).toBe(homeB.serverId);
            expect(sync.getCredentials()).toBeNull();
        } finally {
            releaseWrite.resolve();
            await act(async () => { await login?.catch(() => undefined); });
            await screen.unmount();
        }
    });

    it('clears stale auth state when the active server changes during a login-triggered rebind', async () => {
        const { first, second } = await prepareHomes('first', 'second');
        await focusHome(first);
        const screen = await mountAuth(null);

        try {
            const auth = getCurrentAuth()!;
            await act(async () => {
                await auth.login(buildTokenWithSub('server-test'), LEGACY_SECRET);
            });
            expect(getCurrentAuth()?.isAuthenticated).toBe(true);

            await focusHome(second);
            await act(async () => {
                await auth.refreshFromActiveServer();
            });

            expect(getCurrentAuth()?.isAuthenticated).toBe(false);
            expect(getCurrentAuth()?.credentials).toBeNull();
        } finally {
            await screen.unmount();
        }
    });

    it.each([
        { name: 'a legacy secret', historical: { secret: encodeBase64(new Uint8Array(32).fill(8), 'base64url') } },
        { name: 'an E2EE content key pair', historical: { encryption: {
            publicKey: encodeBase64(contentKeyPair.publicKey),
            machineKey: encodeBase64(contentKeyPair.secretKey),
        } } },
    ])('retains historical keys ($name) during same-Account refresh until confirmed Forget discards them', async ({ historical }) => {
        const { home } = await prepareHomes('home');
        await focusHome(home);
        const token = buildTokenWithSub('server-test');
        const initialCredentials = { token, ...historical } as AuthCredentials;
        await storeCredentials(home, initialCredentials);
        const screen = await mountAuth(initialCredentials);

        try {
            const auth = getCurrentAuth()!;
            await act(async () => {
                await expect(auth.loginWithCredentials({ token })).resolves.toEqual({ kind: 'completed' });
            });
            await expect(readCredentials(home)).resolves.toEqual(initialCredentials);
            expect(getCurrentAuth()).toMatchObject({ isAuthenticated: true, credentials: initialCredentials });

            await act(async () => {
                await expect(auth.loginWithCredentials({ token }, { discardHistoricalEncryption: true }))
                    .resolves.toEqual({ kind: 'completed' });
            });
            await expect(readCredentials(home)).resolves.toEqual({ token });
            expect(getCurrentAuth()).toMatchObject({ isAuthenticated: true, credentials: { token } });
        } finally {
            await screen.unmount();
        }
    });

    it('keeps the mobile brand hero dismissed after logout', async () => {
        const seenAt = 1_789_222_000_000;
        const { localSettingsDefaults } = await import('@/sync/domains/settings/localSettings');
        const { clearPersistence, loadLocalSettings, saveLocalSettings } = await import('@/sync/domains/state/persistence');
        await clearPersistence();
        saveLocalSettings({ ...localSettingsDefaults, brandHeroSeenAt: seenAt });
        const { home } = await prepareHomes('home');
        await focusHome(home);
        const credentials = { token: buildTokenWithSub('server-test'), secret: LEGACY_SECRET };
        await storeCredentials(home, credentials);
        const screen = await mountAuth(credentials);

        try {
            await act(async () => {
                await getCurrentAuth()!.logout();
            });

            expect(loadLocalSettings().brandHeroSeenAt).toBe(seenAt);
            expect(getCurrentAuth()).toMatchObject({ isAuthenticated: false, credentials: null });
        } finally {
            await screen.unmount();
            await clearPersistence();
        }
    });

    it('blocks logout before any auth mutation while marked first-key custody is active', async () => {
        const { home } = await prepareHomes('home');
        await focusHome(home);
        const token = buildTokenWithSub('server-test');
        await storeCredentials(home, { token });
        await connection.switchConnectionToActiveServer();
        await markFirstKeyCustody(home, 'account-test');
        await expect(TokenStorage.readPendingExternalAuthState()).resolves.toMatchObject({
            serverMismatch: false,
            value: { accountEncryptionFirstKey: { migrationSubmissionAttempted: true } },
        });
        const { abandonAccountEncryptionFirstKeyExternalAuth } = await import(
            '@/sync/ops/account/accountEncryptionFirstKeyExternalAuth'
        );
        let recovery: Parameters<typeof abandonAccountEncryptionFirstKeyExternalAuth>[0] | null = null;
        const screen = await mountAuth({ token });

        try {
            const beforeMutation = vi.fn();
            const result = await getCurrentAuth()!.logout({ beforeMutation });

            expect(result).toMatchObject({ kind: 'finish_encryption_setup' });
            expect(beforeMutation).not.toHaveBeenCalled();
            expect(trackLogout).not.toHaveBeenCalled();
            await expect(readCredentials(home)).resolves.toEqual({ token });
            expect(getCurrentAuth()?.isAuthenticated).toBe(true);
            // The focused connection was not retired either.
            expect(connection.isAppliedActiveServerRuntimeAvailable()).toBe(true);
            expect(sync.getCredentials()).toEqual({ token });
            if (result.kind !== 'finish_encryption_setup') throw new Error('Expected first-key custody recovery');
            recovery = result.recovery;
        } finally {
            if (recovery) {
                await expect(abandonAccountEncryptionFirstKeyExternalAuth(recovery)).resolves.toEqual({ kind: 'abandoned' });
                await expect(TokenStorage.readPendingExternalAuthState()).resolves.toEqual({ value: null, serverMismatch: false });
            }
            await screen.unmount();
        }
    });

    it('does not mutate auth state when the authorized pre-mutation callback fails', async () => {
        const { home } = await prepareHomes('home');
        await focusHome(home);
        const token = buildTokenWithSub('server-test');
        await storeCredentials(home, { token });
        await connection.switchConnectionToActiveServer();
        const screen = await mountAuth({ token });

        try {
            await expect(getCurrentAuth()!.logout({
                beforeMutation: () => {
                    throw new Error('navigation failed');
                },
            })).rejects.toThrow('navigation failed');

            expect(trackLogout).not.toHaveBeenCalled();
            await expect(readCredentials(home)).resolves.toEqual({ token });
            expect(getCurrentAuth()?.isAuthenticated).toBe(true);
            expect(connection.isAppliedActiveServerRuntimeAvailable()).toBe(true);
            expect(sync.getCredentials()).toEqual({ token });
        } finally {
            await screen.unmount();
        }
    });

    it('awaits an authorized asynchronous pre-mutation callback immediately before deleting local credentials', async () => {
        const { home } = await prepareHomes('home');
        await focusHome(home);
        const token = buildTokenWithSub('server-test');
        await storeCredentials(home, { token });
        const release = createDeferred<void>();
        const beforeMutation = vi.fn(async () => await release.promise);
        const screen = await mountAuth({ token });

        try {
            let result: unknown;
            const logout = getCurrentAuth()!.logout({ beforeMutation }).then(value => { result = value; });
            await vi.waitFor(() => expect(beforeMutation).toHaveBeenCalledTimes(1));

            await expect(readCredentials(home)).resolves.toEqual({ token });
            expect(getCurrentAuth()?.isAuthenticated).toBe(true);
            expect(trackLogout).not.toHaveBeenCalled();

            await act(async () => {
                release.resolve();
                await logout;
            });
            expect(result).toEqual({ kind: 'completed' });
            expect(beforeMutation).toHaveBeenCalledTimes(1);
            expect(trackLogout).toHaveBeenCalledTimes(1);
            await expect(readCredentials(home)).resolves.toBeNull();
            expect(getCurrentAuth()?.isAuthenticated).toBe(false);
        } finally {
            release.resolve();
            await screen.unmount();
        }
    });

    it('removes focused Home credentials and updates local auth before push cleanup settles', async () => {
        const { home } = await prepareHomes('home');
        await focusHome(home);
        const homeCredentials = { token: buildTokenWithSub('home-a') };
        await storeCredentials(home, homeCredentials);
        saveExpoPushTokenGeneration({ current: 'ExponentPushToken[current]', cleanupPending: null });
        const cleanup = createDeferred<void>();
        network.beforeDelete = async () => await cleanup.promise;
        const screen = await mountAuth(homeCredentials);
        let logoutPromise: Promise<unknown> | undefined;
        let logoutSettled = false;
        try {
            await act(async () => {
                logoutPromise = getCurrentAuth()!.logout().then((result) => {
                    logoutSettled = true;
                    return result;
                });
                await vi.waitFor(() => expect(pushTokenDeletes(home)).not.toEqual([]));
            });

            await expect(readCredentials(home)).resolves.toBeNull();
            await vi.waitFor(() => expect(getCurrentAuth()).toMatchObject({ isAuthenticated: false, credentials: null }));
            await vi.waitFor(() => expect(logoutSettled).toBe(true));
        } finally {
            cleanup.resolve();
            await act(async () => { await logoutPromise; });
            await screen.unmount();
        }
    });

    it('retires the focused Sync identity before logout resolves', async () => {
        const { home } = await prepareHomes('home');
        await focusHome(home);
        const homeCredentials = { token: buildTokenWithSub('home-a') };
        await storeCredentials(home, homeCredentials);
        await connection.switchConnectionToActiveServer();
        expect(sync.getCredentials()).toEqual(homeCredentials);
        const screen = await mountAuth(homeCredentials);
        let syncCredentialsWhenLogoutResolved: unknown = 'unobserved';
        try {
            await act(async () => {
                await getCurrentAuth()!.logout();
                syncCredentialsWhenLogoutResolved = sync.getCredentials();
            });
            expect(syncCredentialsWhenLogoutResolved).toBeNull();
        } finally {
            await screen.unmount();
        }
    });

    it('keeps the newly focused Home and Account Service credentials when an earlier Home logout resumes', async () => {
        const { a: homeA, b: homeB } = await prepareHomes('a', 'b');
        const homeACredentials = { token: buildTokenWithSub('home-a') };
        const homeBCredentials = { token: buildTokenWithSub('home-b') };
        await focusHome(homeA);
        await expect(TokenStorage.clearPendingExternalAuth()).resolves.toBe(true);
        await storeCredentials(homeA, homeACredentials);
        await storeCredentials(homeB, homeBCredentials);
        saveExpoPushTokenGeneration({ current: 'ExponentPushToken[current]', cleanupPending: 'ExponentPushToken[last]' });
        const directoryTarget = { endpoint: 'https://accounts.example.test', serverIdentityId: 'account-service-a' };
        await accountDirectoryCredentialStorage.set(directoryTarget, { token: 'account-service-token' });
        // Home A's best-effort push cleanup is unavailable; that must not fail its logout.
        network.beforeDelete = async (url) => {
            if (url.origin === new URL(homeA.serverUrl).origin) throw new Error('home a cleanup unavailable');
        };

        const resumeLogout = createDeferred<void>();
        const beforeMutation = vi.fn(async () => await resumeLogout.promise);
        const screen = await mountAuth(homeACredentials);
        try {
            const homeALogout = getCurrentAuth()!.logout({ beforeMutation });
            await vi.waitFor(() => expect(beforeMutation).toHaveBeenCalledTimes(1));

            await focusHome(homeB);
            await act(async () => {
                await getCurrentAuth()!.refreshFromActiveServer();
            });
            expect(getCurrentAuth()).toMatchObject({ isAuthenticated: true, credentials: homeBCredentials });

            await act(async () => {
                resumeLogout.resolve();
                await expect(homeALogout).resolves.toEqual({ kind: 'completed' });
            });

            expect(getCurrentAuth()).toMatchObject({ isAuthenticated: true, credentials: homeBCredentials });
            // The resumed Home A logout did not retire Home B's focused connection.
            expect(connection.getAppliedActiveServerId()).toBe(homeB.serverId);
            expect(sync.getCredentials()).toEqual(homeBCredentials);
            await expect(readCredentials(homeA)).resolves.toBeNull();
            await expect(readCredentials(homeB)).resolves.toEqual(homeBCredentials);
            await expect(accountDirectoryCredentialStorage.get(directoryTarget)).resolves.toMatchObject({ token: 'account-service-token' });
            await vi.waitFor(() => expect(pushTokenDeletes(homeA, homeB)).toEqual(
                pushTokenDeleteUrls(homeA, ['ExponentPushToken[current]', 'ExponentPushToken[last]']).sort(),
            ));
        } finally {
            resumeLogout.resolve();
            await screen.unmount();
        }
    });

    it('explicitly forgets all Home and Account Service credentials without removing Home profiles', async () => {
        const { a: homeA, b: homeB } = await prepareHomes('a', 'b');
        await focusHome(homeA);
        const homeACredentials = { token: buildTokenWithSub('home-a') };
        await storeCredentials(homeA, homeACredentials);
        await storeCredentials(homeB, { token: buildTokenWithSub('home-b') });
        saveExpoPushTokenGeneration({ current: 'ExponentPushToken[current]', cleanupPending: 'ExponentPushToken[last]' });
        const directoryTarget = { endpoint: 'https://accounts.example.test', serverIdentityId: 'account-service-a' };
        await accountDirectoryCredentialStorage.set(directoryTarget, { token: 'account-service-token' });
        await TokenStorage.setPendingAccountDirectoryAuth({
            credentialTarget: 'account_directory',
            entryIntent: { kind: 'enter', target: { kind: 'automatic' } },
            ...directoryTarget,
            canonicalServerUrl: directoryTarget.endpoint,
            provider: 'github',
            purpose: 'account_directory',
            pending: 'pending-account-service-auth',
            createdAt: Date.now() - 100,
            expiresAt: Date.now() + 10_000,
        });

        const screen = await mountAuth(homeACredentials);
        try {
            await act(async () => {
                await getCurrentAuth()!.logout({ scope: 'all-credentials' });
            });

            await expect(readCredentials(homeA)).resolves.toBeNull();
            await expect(readCredentials(homeB)).resolves.toBeNull();
            await expect(accountDirectoryCredentialStorage.get(directoryTarget)).resolves.toBeNull();
            await expect(TokenStorage.getPendingAccountDirectoryAuth(directoryTarget)).resolves.toBeNull();
            expect(getCurrentAuth()).toMatchObject({ isAuthenticated: false, credentials: null });
            expect(profiles.listServerProfiles().map(profile => profile.serverUrl)).toEqual(
                expect.arrayContaining([homeA.serverUrl, homeB.serverUrl]),
            );
            const tokens = ['ExponentPushToken[current]', 'ExponentPushToken[last]'];
            await vi.waitFor(() => expect(pushTokenDeletes(homeA, homeB)).toEqual(
                [...pushTokenDeleteUrls(homeA, tokens), ...pushTokenDeleteUrls(homeB, tokens)].sort(),
            ));
        } finally {
            await screen.unmount();
        }
    });

    it('forgets local credentials before concurrently isolating per-Home push cleanup failures', async () => {
        const { a: homeA, b: homeB } = await prepareHomes('a', 'b');
        await focusHome(homeA);
        const homeACredentials = { token: buildTokenWithSub('home-a') };
        await storeCredentials(homeA, homeACredentials);
        await storeCredentials(homeB, { token: buildTokenWithSub('home-b') });
        saveExpoPushTokenGeneration({ current: 'ExponentPushToken[current]', cleanupPending: null });
        const cleanup = createDeferred<void>();
        network.beforeDelete = async (url) => {
            await cleanup.promise;
            if (url.origin === new URL(homeA.serverUrl).origin) throw new Error('Home A is offline');
        };

        const screen = await mountAuth(homeACredentials);
        let logoutPromise: Promise<unknown> | undefined;
        let logoutSettled = false;
        try {
            await act(async () => {
                logoutPromise = getCurrentAuth()!.logout({ scope: 'all-credentials' }).then((result) => {
                    logoutSettled = true;
                    return result;
                });
                await vi.waitFor(() => expect(pushTokenDeletes(homeA, homeB)).toEqual([
                    ...pushTokenDeleteUrls(homeA, ['ExponentPushToken[current]']),
                    ...pushTokenDeleteUrls(homeB, ['ExponentPushToken[current]']),
                ].sort()));
            });

            await expect(readCredentials(homeA)).resolves.toBeNull();
            await expect(readCredentials(homeB)).resolves.toBeNull();
            await vi.waitFor(() => expect(getCurrentAuth()).toMatchObject({ isAuthenticated: false, credentials: null }));
            await vi.waitFor(() => expect(logoutSettled).toBe(true));
        } finally {
            cleanup.resolve();
            await act(async () => { await logoutPromise; });
            await screen.unmount();
        }
    });

    it('blocks different-token replacement and unproven same-token keyed replacement', async () => {
        const { home } = await prepareHomes('home');
        await focusHome(home);
        const token = buildTokenWithSub('server-test');
        await storeCredentials(home, { token });
        await markFirstKeyCustody(home, 'account-test');
        await expect(TokenStorage.readPendingExternalAuthState()).resolves.toMatchObject({
            serverMismatch: false,
            value: { accountEncryptionFirstKey: { migrationSubmissionAttempted: true } },
        });
        const screen = await mountAuth({ token });

        try {
            const auth = getCurrentAuth()!;
            await expect(auth.loginWithCredentials({ token: 'different-token' }))
                .resolves.toMatchObject({ kind: 'finish_encryption_setup' });
            await expect(readCredentials(home)).resolves.toEqual({ token });

            await expect(auth.loginWithCredentials({ token, secret: 'recovered-secret' }))
                .resolves.toMatchObject({ kind: 'finish_encryption_setup' });
            await expect(readCredentials(home)).resolves.toEqual({ token });
        } finally {
            await screen.unmount();
        }
    });

    it('scopes the first-key custody guard to the Homes a logout actually mutates', async () => {
        const { a: homeA, b: homeB } = await prepareHomes('a', 'b');
        await focusHome(homeB);
        const homeACredentials = { token: buildTokenWithSub('home-a') };
        const homeBCredentials = { token: buildTokenWithSub('home-b') };
        await storeCredentials(homeA, homeACredentials);
        await storeCredentials(homeB, homeBCredentials);
        // First-key setup was attempted, and is retained, on Home A only; Home B is focused.
        await markFirstKeyCustody(homeA, 'account-home-a');
        const screen = await mountAuth(homeBCredentials);
        try {
            // Forgetting every credential would delete Home A's: it is guarded and mutates nothing.
            await expect(getCurrentAuth()!.logout({ scope: 'all-credentials' }))
                .resolves.toMatchObject({ kind: 'finish_encryption_setup' });
            await expect(readCredentials(homeB)).resolves.toEqual(homeBCredentials);
            await expect(readCredentials(homeA)).resolves.toEqual(homeACredentials);

            // Logging out of focused Home B deletes nothing on Home A.
            await act(async () => {
                await expect(getCurrentAuth()!.logout()).resolves.toEqual({ kind: 'completed' });
            });
            await expect(readCredentials(homeB)).resolves.toBeNull();
            await expect(readCredentials(homeA)).resolves.toEqual(homeACredentials);
            await expect(TokenStorage.readPendingExternalAuthStateForServerUrl(homeA.serverUrl, { serverId: homeA.serverId }))
                .resolves.toMatchObject({ value: { accountEncryptionFirstKey: { migrationSubmissionAttempted: true } } });

            // Home A's custody still guards an all-credentials logout afterwards.
            await expect(getCurrentAuth()!.logout({ scope: 'all-credentials' }))
                .resolves.toMatchObject({ kind: 'finish_encryption_setup' });
            await expect(readCredentials(homeA)).resolves.toEqual(homeACredentials);
        } finally {
            await screen.unmount();
        }
    });
});
