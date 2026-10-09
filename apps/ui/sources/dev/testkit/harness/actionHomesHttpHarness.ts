import { vi } from 'vitest';
import { loadVitestModuleForNodeRequire } from '@/dev/vitestRnShim';
import { getVitestNodeBuiltin } from '@/dev/vitestNodeBuiltins';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';

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
}>;

type HomeSpec = Readonly<{ key: string; serverUrl: string; accountId: string; settings?: Readonly<Record<string, unknown>>;
    accountMode?: 'plain' | 'e2ee'; credentials?: AuthCredentials }>;

function tokenFor(accountId: string): string {
    return `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
}

function accountOf(init: RequestInit | undefined): string | null {
    const header = new Headers(init?.headers).get('Authorization');
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
    const payload = token?.split('.')[1];
    if (!payload) return null;
    try {
        return (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sub?: string }).sub ?? null;
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
 * `runtimeFetch`) and the stored credentials (one plain-mode token per Home, switchable to another
 * Account) are replaced. The last Home listed is the focused one.
 */
export async function serveAccountHomes(params: Readonly<{
    homes: readonly HomeSpec[];
    route: (request: ServedHomeRequest) => Response | undefined | Promise<Response | undefined>;
}>) {
    const [{ upsertServerProfileOnly, setActiveServer }, { TokenStorage }, { setRuntimeFetch, resetRuntimeFetch }, { getStorage }] = await Promise.all([
        import('@/sync/domains/server/serverRuntime'),
        import('@/auth/storage/tokenStorage'),
        import('@/utils/system/runtimeFetch'),
        import('@/sync/domains/state/storage'),
    ]);
    const accounts = new Map<string, string>();
    const byOrigin = new Map<string, string>();
    const settingsByHome = new Map(params.homes.map(home => [home.key, home.settings ?? {}]));
    const specsByHome = new Map(params.homes.map(home => [home.key, home]));
    const homes: Record<string, Readonly<{ id: string; serverUrl: string }>> = {};
    const requests: ServedHomeRequest[] = [];
    // Activation can start readiness immediately. Install the external HTTP
    // boundary before publishing any fixture Home, as app-entry fixtures do.
    setRuntimeFetch(async (url, init) => {
        const target = new URL(String(url));
        if (target.pathname === '/health' || target.pathname === '/v1/auth/ping') return Response.json({});
        const home = byOrigin.get(target.origin);
        if (!home) throw new Error(`Request to an unknown Home: ${target.origin}`);
        if (target.pathname === '/v1/account/encryption') {
            const spec = specsByHome.get(home);
            return Response.json({ mode: accounts.get(home) === spec?.accountId ? spec?.accountMode ?? 'plain' : 'plain', updatedAt: 0 });
        }
        if (target.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: settingsByHome.get(home) ?? {} }, version: 1 });
        const request: ServedHomeRequest = {
            home,
            method: init?.method ?? 'GET',
            path: target.pathname,
            url: target,
            accountId: accountOf(init),
            body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        };
        requests.push(request);
        return await params.route(request) ?? Response.json({ error: 'not_found' }, { status: 404 });
    });
    for (const spec of params.homes) {
        const home = await upsertServerProfileOnly({ serverUrl: spec.serverUrl });
        homes[spec.key] = { id: home.id, serverUrl: home.serverUrl };
        accounts.set(spec.key, spec.accountId);
        byOrigin.set(new URL(home.serverUrl).origin, spec.key);
        // Device selection also works in Node/native harnesses without the
        // browser sessionStorage that owns a tab-scoped selection.
        await setActiveServer({ serverId: home.id });
    }
    const focused = params.homes.at(-1)!;
    const focusedScope = { serverId: homes[focused.key]!.id, accountId: focused.accountId };
    getStorage().setState({ settingsScope: focusedScope, profileScope: focusedScope });
    // A focused Home reads the applied Settings projection, not its HTTP baseline.
    // Publish the same fixture response through the real store producer.
    const { settingsParse } = await import('@/sync/domains/settings/settings');
    getStorage().getState().applySettingsForScope(focusedScope, settingsParse(focused.settings ?? {}), 1);
    const credentials = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(async (serverUrl: string) => {
        const key = byOrigin.get(new URL(serverUrl).origin);
        const accountId = key ? accounts.get(key) : undefined;
        const spec = key ? specsByHome.get(key) : undefined;
        return accountId ? { ...(spec?.accountId === accountId ? spec.credentials : undefined), token: tokenFor(accountId) } : null;
    });
    return {
        homes,
        requests,
        /** The Home now signs in as another Account (a sign-out and sign-in elsewhere). */
        switchAccount(key: string, accountId: string) {
            accounts.set(key, accountId);
        },
        dispose() {
            resetRuntimeFetch();
            credentials.mockRestore();
        },
    };
}

/** Adds the real Metro executor bridge only for journeys that invoke the Action front door. */
export async function serveActionHomes(params: Parameters<typeof serveAccountHomes>[0]) {
    const restoreExecutorModuleLoader = await installRealActionExecutorModuleLoader();
    try {
        const home = await serveAccountHomes(params);
        return {
            ...home,
            dispose() {
                try {
                    home.dispose();
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
