// Restore/Sync also uses device record persistence; browser storage is a system boundary.
import 'fake-indexeddb/auto';
import { vi } from 'vitest';
import { loadVitestModuleForNodeRequire } from '@/dev/vitestRnShim';
import { getVitestNodeBuiltin } from '@/dev/vitestNodeBuiltins';
import type { AuthCredentials, HomeCredentialWriteRollback } from '@/auth/storage/tokenStorage';
import type { AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol';
import { AuthTokenProvenanceSchema } from '@happier-dev/protocol/auth/authToken';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import {
    AccountSettingsV2GetResponseSchema,
    AccountSettingsV2UpdateRequestAdmissionSchema,
    AccountSettingsV2UpdateRequestSchema,
    AccountSettingsV2UpdateResponseSchema,
    type AccountSettingsV2GetResponse,
} from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';

// File identities belong to Node, not Vite's client asset URL transform.
const { URL: NodeURL } = getVitestNodeBuiltin<typeof import('node:url')>('node:url');

// A generated third-party WebView asset is not part of an HTTP Action journey. Its multi-MB
// source otherwise enters the default executor's presentation import graph during collection.
vi.mock('@/components/markdown/mermaidWebViewBundle.generated', () => ({
    MERMAID_WEBVIEW_BUNDLE_JS: '', MERMAID_WEBVIEW_BUNDLE_BYTES: 0,
}));

export type ServedHomeRequest = Readonly<{
    home: string;
    method: string;
    path: string;
    url: URL;
    /** The Account the request authenticated as (the bearer token's subject). */
    accountId: string | null;
    headers: Headers;
    body: unknown;
    signal: AbortSignal | null | undefined;
}>;

type HomeSpec = Readonly<{
    key: string; serverUrl: string; accountId: string; serverIdentityId?: string;
    /** Actual Home HTTP profile fields; its identity always comes from the authenticated bearer. */
    profile?: Partial<Omit<ReturnType<typeof AccountProfileSchema.parse>, 'id'>>;
    /** Actual initial settings document served before Account bootstrap starts. */
    settings?: Readonly<Record<string, unknown>>;
    accountMode?: 'plain' | 'e2ee';
    /** Current Account wire fact, including mutable Settings revisions during maintenance tests. */
    encryptionCurrentness?: () => AccountEncryptionCurrentnessResponse;
    credentials?: AuthCredentials;
    currentAccount?: boolean;
}>;

export function createServedHomeAccountToken(accountId: string, currentAccount = false): string {
    return `header.${Buffer.from(JSON.stringify({ sub: accountId, ...(currentAccount ? {
        provenance: AuthTokenProvenanceSchema.parse({ v: 1, kind: 'account', authority: 'present_user' }), tokenEpoch: 0,
    } : {}) })).toString('base64url')}.signature`;
}

function accountOf(init: RequestInit | undefined): string | null {
    const header = new Headers(init?.headers).get('Authorization');
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
    const payload = token?.split('.')[1];
    if (!payload) return null;
    try {
        const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        if (!parsed || typeof parsed !== 'object') return null;
        const subject = Reflect.get(parsed, 'sub');
        return typeof subject === 'string' ? subject : null;
    } catch {
        return null;
    }
}

/**
 * One Home's external Settings server. It owns only wire snapshots and CAS;
 * creating it does not activate a Home, write credentials, or publish UI state.
 */
export function createAccountSettingsHttpBoundary(params: Readonly<{
    serverUrl: string;
    initialAccounts: readonly Readonly<{ accountId: string; snapshot: AccountSettingsV2GetResponse }>[];
}>) {
    const origin = new URL(params.serverUrl).origin;
    const settingsByAccount = new Map<string, AccountSettingsV2GetResponse>();
    function replaceAccountSettings(accountId: string, snapshot: AccountSettingsV2GetResponse) {
        // JSON copies the external server fact, never a live client projection.
        settingsByAccount.set(accountId, AccountSettingsV2GetResponseSchema.parse(JSON.parse(JSON.stringify(snapshot))));
    }
    for (const account of params.initialAccounts) replaceAccountSettings(account.accountId, account.snapshot);
    return {
        replaceAccountSettings,
        handle(url: RequestInfo | URL, init?: RequestInit): Response | undefined {
            const target = new URL(String(url));
            if (target.origin !== origin || target.pathname !== '/v2/account/settings') return undefined;
            const accountId = accountOf(init);
            if (!accountId) {
                const error = new Headers(init?.headers).has('Authorization') ? 'invalid_token' : 'Missing authorization header';
                return Response.json({ error }, { status: 401 });
            }
            const current = settingsByAccount.get(accountId) ?? { content: null, version: 0 };
            if ((init?.method ?? 'GET') === 'GET') {
                return Response.json(AccountSettingsV2GetResponseSchema.parse(current));
            }
            if (init?.method !== 'POST') return undefined;
            let body: unknown;
            try {
                body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
            } catch {
                return Response.json({ error: 'invalid-params' }, { status: 400 });
            }
            if (!AccountSettingsV2UpdateRequestAdmissionSchema.safeParse(body).success) {
                return Response.json({ error: 'invalid-params' }, { status: 400 });
            }
            const parsed = AccountSettingsV2UpdateRequestSchema.safeParse(body);
            if (!parsed.success) {
                return Response.json(AccountSettingsV2UpdateResponseSchema.parse({ success: false, error: 'invalid', reason: 'tooLarge' }));
            }
            const currentVersion = current.version;
            if (parsed.data.expectedVersion !== currentVersion) {
                return Response.json(AccountSettingsV2UpdateResponseSchema.parse({
                    success: false, error: 'version-mismatch', currentVersion, currentContent: current.content,
                }));
            }
            const version = currentVersion + 1;
            settingsByAccount.set(accountId, { content: parsed.data.content, version });
            return Response.json(AccountSettingsV2UpdateResponseSchema.parse({ success: true, version }));
        },
    };
}

/** Bridges Metro's call-time require to the real Vitest executor; substitutes no Action logic. */
export async function installRealActionExecutorModuleLoader(): Promise<() => void> {
    const bridge = await loadVitestModuleForNodeRequire(
        new NodeURL('../../../sync/ops/actions/defaultActionExecutor.ts', import.meta.url),
        () => import('@/sync/ops/actions/defaultActionExecutor'),
    );
    return bridge.dispose;
}

/**
 * Real Homes behind a fake network: every Home is a real server profile and every account
 * context, scoped transport and credential reader runs for real. HTTP and native/browser storage
 * are the external boundaries; synthetic credentials are persisted by the real TokenStorage
 * owner. The last Home listed is the focused one.
 */
export async function serveAccountHomes(params: Readonly<{
    homes: readonly HomeSpec[];
    route: (request: ServedHomeRequest) => Response | Promise<Response | undefined> | undefined;
}>) {
    if (params.homes.length === 0) throw new Error('An Action journey requires a Home');
    const webLocks = typeof globalThis.navigator?.locks?.request === 'function' ? null : installWebLockManagerMock();
    const { loadSyncSingletonForTests } = await import('./syncSingletonLoader');
    await loadSyncSingletonForTests();
    const [{ upsertServerProfileOnly, setActiveServer, getActiveServerSnapshot }, { TokenStorage, areCredentialsEqual }, { setRuntimeFetch, resetRuntimeFetch },
        { restoreConnectionToActiveServer, disconnectActiveServerConnection }, { resolveServerProfileScopeIdForIdentifier, setServerProfileIdentityForUrl }] = await Promise.all([
        import('@/sync/domains/server/serverRuntime'),
        import('@/auth/storage/tokenStorage'),
        import('@/utils/system/runtimeFetch'),
        import('@/sync/runtime/orchestration/connectionManager'),
        import('@/sync/domains/server/serverProfiles'),
    ]);
    await disconnectActiveServerConnection();
    const accounts = new Map<string, string>();
    const byOrigin = new Map<string, string>();
    // Store authenticated wire snapshots through one Settings CAS boundary.
    // Empty E2EE Accounts start at null/version 0, as the real HTTP owner does.
    const settingsByHome = new Map(params.homes.map(home => {
        const emptyEncryptedAccount = home.accountMode === 'e2ee' && home.settings === undefined;
        const snapshot = AccountSettingsV2GetResponseSchema.parse(JSON.parse(JSON.stringify({
            content: emptyEncryptedAccount ? null : { t: 'plain', v: home.settings ?? {} },
            version: emptyEncryptedAccount ? 0 : 1,
        })));
        return [home.key, createAccountSettingsHttpBoundary({
            serverUrl: home.serverUrl, initialAccounts: [{ accountId: home.accountId, snapshot }],
        })] as const;
    }));
    const specsByHome = new Map(params.homes.map(home => [home.key, home]));
    const homes: Record<string, Readonly<{ id: string; profileId: string; serverUrl: string }>> = {};
    const credentialWrites: Array<Readonly<{
        write: HomeCredentialWriteRollback;
        credentials: AuthCredentials;
        previousCredentials: AuthCredentials | null;
        profileId: string;
        scopeId: string;
    }>> = [];
    const focused = params.homes.at(-1)!;
    const requests: ServedHomeRequest[] = [];
    const httpRequests: ServedHomeRequest[] = [];
    async function writeCredentials(key: string, accountId: string) {
        const home = homes[key];
        if (!home) throw new Error(`Unknown served Home: ${key}`);
        const spec = specsByHome.get(key);
        const credentials = {
            ...(spec?.accountId === accountId ? spec.credentials : undefined),
            token: spec?.accountId === accountId && spec.credentials
                ? spec.credentials.token
                : createServedHomeAccountToken(accountId, spec?.accountId === accountId && spec.currentAccount === true),
        };
        const scopeId = resolveServerProfileScopeIdForIdentifier(home.profileId);
        const previousCredentials = await TokenStorage.getCredentialsForServerUrl(home.serverUrl,
            { serverId: scopeId, storageReadFailure: 'surface' });
        const rollback = await TokenStorage.setCredentialsForServerUrlWithRollback(home.serverUrl, { serverId: scopeId }, credentials);
        if (!rollback) throw new Error(`Served Home credentials could not be stored: ${key}`);
        credentialWrites.push({ write: rollback, credentials, previousCredentials, profileId: home.profileId, scopeId });
        accounts.set(key, accountId);
        return credentials;
    }
    // Install all transport answers before activation can trigger real restoration.
    const homeFetch = async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const target = new URL(String(url));
        const home = byOrigin.get(target.origin);
        if (!home) throw new Error(`Request to an unknown Home: ${target.origin}`);
        const authenticatedAccountId = accountOf(init);
        const request: ServedHomeRequest = {
            home, method: init?.method ?? 'GET', path: target.pathname, url: target,
            accountId: authenticatedAccountId, headers: new Headers(init?.headers),
            body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
            signal: init?.signal,
        };
        httpRequests.push(request);
        if (target.pathname === '/health' || target.pathname === '/v1/auth/ping') return Response.json({});
        if (target.pathname === '/v1/account/encryption') {
            const spec = specsByHome.get(home);
            return Response.json({ mode: authenticatedAccountId === spec?.accountId ? spec?.accountMode ?? 'plain' : 'plain', updatedAt: 0 });
        }
        if (target.pathname === '/v1/account/encryption/currentness') {
            const spec = specsByHome.get(home);
            if (authenticatedAccountId === spec?.accountId && spec.encryptionCurrentness) {
                return Response.json(spec.encryptionCurrentness());
            }
            const mode = authenticatedAccountId === spec?.accountId ? spec?.accountMode ?? 'plain' : 'plain';
            if (mode === 'plain') return Response.json(createPlainAccountEncryptionCurrentnessFixture({ version: 0, updatedAt: 0 }));
        }
        if (target.pathname === '/v1/account/profile') {
            return authenticatedAccountId
                ? Response.json(AccountProfileSchema.parse({ ...specsByHome.get(home)?.profile, id: authenticatedAccountId }))
                : Response.json({ error: 'Not authenticated' }, { status: 401 });
        }
        const settingsResponse = settingsByHome.get(home)!.handle(url, init);
        if (settingsResponse) return settingsResponse;
        requests.push(request);
        return await params.route(request) ?? Response.json({ error: 'not_found' }, { status: 404 });
    };
    setRuntimeFetch(homeFetch);
    let disposed = false;
    const dispose = async () => {
        if (disposed) return;
        disposed = true;
        try {
            await disconnectActiveServerConnection();
            const { stopAllEndpointSupervisorsForTests } = await import('@/sync/runtime/connectivity/endpointSupervisorPool');
            await stopAllEndpointSupervisorsForTests();
        } finally {
            resetRuntimeFetch();
            try {
                for (const { write, credentials, previousCredentials, profileId, scopeId } of credentialWrites.splice(0).reverse()) {
                    const currentScopeId = resolveServerProfileScopeIdForIdentifier(profileId);
                    const current = await TokenStorage.getCredentialsForServerUrl(write.serverUrl,
                        { serverId: currentScopeId, storageReadFailure: 'surface' });
                    // Logout and Account replacement belong to the exercised flow. Only undo
                    // installation while this fixture still owns the stored credential material.
                    if (!areCredentialsEqual(current, credentials)) continue;
                    // An exercised identity adoption owns the new key layout. Its old
                    // exact-key receipt cannot undo that transition; restore only the
                    // fixture's logical material through the guarded canonical writer.
                    const restored = currentScopeId === scopeId ? await write.rollback()
                        : previousCredentials
                            ? await TokenStorage.setCredentialsForServerUrl(write.serverUrl,
                                { serverId: currentScopeId, expectedCredentials: credentials }, previousCredentials)
                            : await TokenStorage.removeCredentialsForServerUrl(write.serverUrl,
                                { serverId: currentScopeId, expectedCredentials: credentials });
                    if (!restored) throw new Error('Served Home credential rollback failed');
                }
            } finally {
                webLocks?.restore();
            }
        }
    };
    try {
        for (const spec of params.homes) {
            let profile = await upsertServerProfileOnly({ serverUrl: spec.serverUrl });
            if (spec.serverIdentityId) {
                const identified = await setServerProfileIdentityForUrl(profile.serverUrl, spec.serverIdentityId);
                if (!identified) throw new Error(`Home identity could not be established: ${spec.key}`);
                profile = identified;
            }
            const id = resolveServerProfileScopeIdForIdentifier(profile.id);
            homes[spec.key] = { id, profileId: profile.id, serverUrl: profile.serverUrl };
            byOrigin.set(new URL(profile.serverUrl).origin, spec.key);
            await writeCredentials(spec.key, spec.accountId);
        }
        await setActiveServer({ serverId: homes[focused.key]!.profileId });
        const credentials = await TokenStorage.getCredentialsForServerUrl(homes[focused.key]!.serverUrl);
        if (!credentials) throw new Error('Served Home Account is unavailable');
        await restoreConnectionToActiveServer(credentials);
    } catch (error) {
        await dispose();
        throw error;
    }
    return {
        homes, requests, httpRequests,
        /** Compose another real network boundary without replacing the Home transport. */
        fetch: homeFetch,
        replaceAccountSettings(key: string, snapshot: Readonly<{ settings: Readonly<Record<string, unknown>>; version: number }>) {
            const boundary = settingsByHome.get(key);
            const accountId = accounts.get(key);
            if (!boundary || !accountId) throw new Error(`Unknown served Home: ${key}`);
            boundary.replaceAccountSettings(accountId, AccountSettingsV2GetResponseSchema.parse(JSON.parse(JSON.stringify({
                content: { t: 'plain', v: snapshot.settings }, version: snapshot.version,
            }))));
        },
        async restoreActiveConnection() {
            const credential = await TokenStorage.getCredentialsForServerUrl(homes[focused.key]!.serverUrl);
            if (!credential) throw new Error('Served Home Account is unavailable');
            await restoreConnectionToActiveServer(credential);
            return disconnectActiveServerConnection;
        },
        async switchAccount(key: string, accountId: string) {
            if (disposed) throw new Error('The Action Homes have been disposed');
            const home = homes[key];
            if (!home) throw new Error(`Unknown served Home: ${key}`);
            const isFocused = getActiveServerSnapshot().serverId === home.id;
            if (isFocused) await disconnectActiveServerConnection();
            const credentials = await writeCredentials(key, accountId);
            if (isFocused) await restoreConnectionToActiveServer(credentials);
        },
        dispose,
    };
}

/** Domain-compatible name retained for Action compositions. */
export const serveActionHomes = serveAccountHomes;
