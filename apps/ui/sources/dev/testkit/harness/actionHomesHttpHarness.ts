import { vi } from 'vitest';
import { loadVitestModuleForNodeRequire } from '@/dev/vitestRnShim';
import { getVitestNodeBuiltin } from '@/dev/vitestNodeBuiltins';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createPlainAccountEncryptionCurrentnessFixture } from '../fixtures/accountEncryptionCurrentness';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { AccountSettingsStoredContentEnvelopeSchema, AccountSettingsV2UpdateResponseSchema } from '@happier-dev/protocol';
import type { Settings } from '@/sync/domains/settings/settings';

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
    body: unknown;
    signal: AbortSignal | null | undefined;
}>;

type HomeSpec = Readonly<{
    key: string; serverUrl: string; accountId: string; serverIdentityId?: string;
    /** Actual Home HTTP profile fields; its identity always comes from the authenticated bearer. */
    profile?: Partial<Omit<ReturnType<typeof AccountProfileSchema.parse>, 'id'>>;
    /** Actual initial settings document served before Account bootstrap starts. */
    settings?: Partial<Settings>;
    accountMode?: 'plain' | 'e2ee';
    credentials?: AuthCredentials;
}>;

function tokenFor(accountId: string): string {
    return `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
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
 * context, scoped transport and credential reader runs for real. Only the HTTP boundary (one
 * `runtimeFetch`) is replaced. Plain-mode credentials persist through their actual device owner,
 * and the last Home listed has a genuinely restored focused Account.
 */
export async function serveAccountHomes(params: Readonly<{
    homes: readonly HomeSpec[];
    route: (request: ServedHomeRequest) => Response | Promise<Response | undefined> | undefined;
}>) {
    if (params.homes.length === 0) throw new Error('An Action journey requires a Home');
    const webLocks = typeof globalThis.navigator?.locks?.request === 'function' ? null : installWebLockManagerMock();
    const { loadSyncSingletonForTests } = await import('./syncSingletonLoader');
    await loadSyncSingletonForTests();
    const [{ upsertServerProfileOnly, setActiveServer, getActiveServerSnapshot }, { TokenStorage }, { setRuntimeFetch, resetRuntimeFetch },
        { restoreConnectionToActiveServer, disconnectActiveServerConnection }, { resolveServerProfileScopeIdForIdentifier, setServerProfileIdentityForUrl }] = await Promise.all([
        import('@/sync/domains/server/serverRuntime'),
        import('@/auth/storage/tokenStorage'),
        import('@/utils/system/runtimeFetch'),
        import('@/sync/runtime/orchestration/connectionManager'),
        import('@/sync/domains/server/serverProfiles'),
    ]);
    await disconnectActiveServerConnection();
    const settingsByAccount = new Map<string, { content: ReturnType<typeof AccountSettingsStoredContentEnvelopeSchema.parse>; version: number }>();
    const byOrigin = new Map<string, string>();
    const specsByHome = new Map(params.homes.map(home => [home.key, home]));
    const homes: Record<string, Readonly<{ id: string; profileId: string; serverUrl: string }>> = {};
    const writes: Array<NonNullable<Awaited<ReturnType<typeof TokenStorage.setCredentialsForServerUrlWithRollback>>>> = [];
    const focused = params.homes.at(-1)!;
    const requests: ServedHomeRequest[] = [];
    const httpRequests: ServedHomeRequest[] = [];
    // Activation can start readiness and Account restoration immediately. All
    // transport answers and genuine credentials must exist before that event.
    setRuntimeFetch(async (url, init) => {
        const target = new URL(String(url));
        const home = byOrigin.get(target.origin);
        if (!home) throw new Error(`Request to an unknown Home: ${target.origin}`);
        const request: ServedHomeRequest = {
            home,
            method: init?.method ?? 'GET',
            path: target.pathname,
            url: target,
            accountId: accountOf(init),
            body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
            signal: init?.signal,
        };
        httpRequests.push(request);
        if (target.pathname === '/health' || target.pathname === '/v1/auth/ping') return Response.json({});
        if (target.pathname === '/v1/account/encryption') {
            const spec = specsByHome.get(home);
            return Response.json({ mode: accountOf(init) === spec?.accountId ? spec?.accountMode ?? 'plain' : 'plain', updatedAt: 0 });
        }
        if (target.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
        if (target.pathname === '/v1/account/profile') {
            const accountId = accountOf(init);
            return accountId ? Response.json(AccountProfileSchema.parse({ ...params.homes.find(spec => spec.key === home)?.profile, id: accountId }))
                : Response.json({ error: 'Not authenticated' }, { status: 401 });
        }
        if (target.pathname === '/v2/account/settings') {
            const accountId = accountOf(init);
            if (!accountId) return Response.json({ error: 'Not authenticated' }, { status: 401 });
            const settingsKey = JSON.stringify([home, accountId]);
            let settings = settingsByAccount.get(settingsKey);
            if (!settings) {
                settings = { content: AccountSettingsStoredContentEnvelopeSchema.parse({
                    t: 'plain', v: params.homes.find(spec => spec.key === home)?.settings ?? {},
                }), version: 1 };
                settingsByAccount.set(settingsKey, settings);
            }
            if (init?.method !== 'POST') return Response.json(settings);
            const input: unknown = JSON.parse(String(init.body));
            if (!input || typeof input !== 'object' || !('expectedVersion' in input) || !('content' in input)) {
                return Response.json({ error: 'settings_invalid' }, { status: 400 });
            }
            if (input.expectedVersion !== settings.version) return Response.json(AccountSettingsV2UpdateResponseSchema.parse({
                success: false, error: 'version-mismatch', currentVersion: settings.version, currentContent: settings.content,
            }));
            const content = AccountSettingsStoredContentEnvelopeSchema.safeParse(input.content);
            if (!content.success || content.data.t !== 'plain') return Response.json({ error: 'settings_invalid' }, { status: 400 });
            settings.content = content.data;
            settings.version += 1;
            return Response.json({ success: true, version: settings.version });
        }
        requests.push(request);
        return await params.route(request) ?? Response.json({ error: 'not_found' }, { status: 404 });
    });
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
                for (const write of writes.splice(0).reverse()) await write.rollback();
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
            const write = await TokenStorage.setCredentialsForServerUrlWithRollback(profile.serverUrl, { serverId: id }, spec.credentials ?? { token: tokenFor(spec.accountId) });
            if (!write) throw new Error(`Home credentials could not be persisted: ${spec.key}`);
            writes.push(write);
        }
        await setActiveServer({ serverId: homes[focused.key]!.profileId });
        await restoreConnectionToActiveServer(focused.credentials ?? { token: tokenFor(focused.accountId) });
    } catch (error) {
        await dispose();
        throw error;
    }
    return {
        homes,
        requests,
        /** Includes real bootstrap/profile/settings CAS traffic; requests retains its domain-only contract. */
        httpRequests,
        /** The Home now signs in as another Account (a sign-out and sign-in elsewhere). */
        async switchAccount(key: string, accountId: string) {
            if (disposed) throw new Error('The Action Homes have been disposed');
            const home = homes[key];
            if (!home) throw new Error(`No Action Home saved for ${key}`);
            const isFocused = getActiveServerSnapshot().serverId === home.id;
            if (isFocused) await disconnectActiveServerConnection();
            const write = await TokenStorage.setCredentialsForServerUrlWithRollback(home.serverUrl, { serverId: home.id }, { token: tokenFor(accountId) });
            if (!write) throw new Error(`Home credentials could not be replaced: ${key}`);
            writes.push(write);
            if (isFocused) await restoreConnectionToActiveServer({ token: tokenFor(accountId) });
        },
        dispose,
    };
}

/** Adds the real Metro executor bridge only for journeys that invoke the Action front door. */
export async function serveActionHomes(params: Parameters<typeof serveAccountHomes>[0]) {
    const restoreExecutorModuleLoader = await installRealActionExecutorModuleLoader();
    try {
        const home = await serveAccountHomes(params);
        return {
            ...home,
            async dispose() {
                try {
                    await home.dispose();
                } finally {
                    restoreExecutorModuleLoader();
                }
            },
        };
    } catch (error) {
        restoreExecutorModuleLoader();
        throw error;
    }
}
