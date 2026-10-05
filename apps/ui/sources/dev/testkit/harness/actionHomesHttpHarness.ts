import { vi } from 'vitest';
import { loadVitestModuleForNodeRequire } from '@/dev/vitestRnShim';

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

type HomeSpec = Readonly<{ key: string; serverUrl: string; accountId: string }>;

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

/**
 * Real Homes behind a fake network: every Home is a real server profile and every Action, account
 * context, scoped transport and credential reader runs for real. Only the HTTP boundary (one
 * `runtimeFetch`) and the stored credentials (one plain-mode token per Home, switchable to another
 * Account) are replaced. The last Home listed is the focused one.
 */
export async function serveActionHomes(params: Readonly<{
    homes: readonly HomeSpec[];
    route: (request: ServedHomeRequest) => Response | Promise<Response> | undefined;
}>) {
    const executorBridge = await loadVitestModuleForNodeRequire(
        new URL('../../../sync/ops/actions/defaultActionExecutor.ts', import.meta.url),
        () => import('@/sync/ops/actions/defaultActionExecutor'),
    );
    const [{ upsertAndActivateServer }, { TokenStorage }, { setRuntimeFetch, resetRuntimeFetch }, { getStorage }] = await Promise.all([
        import('@/sync/domains/server/serverRuntime'),
        import('@/auth/storage/tokenStorage'),
        import('@/utils/system/runtimeFetch'),
        import('@/sync/domains/state/storage'),
    ]);
    const accounts = new Map<string, string>();
    const byOrigin = new Map<string, string>();
    const homes: Record<string, Readonly<{ id: string; serverUrl: string }>> = {};
    for (const spec of params.homes) {
        const home = await upsertAndActivateServer({ serverUrl: spec.serverUrl, scope: 'tab' });
        homes[spec.key] = { id: home.id, serverUrl: home.serverUrl };
        accounts.set(spec.key, spec.accountId);
        byOrigin.set(new URL(home.serverUrl).origin, spec.key);
    }
    const focused = params.homes.at(-1)!;
    const focusedScope = { serverId: homes[focused.key]!.id, accountId: focused.accountId };
    getStorage().setState({ settingsScope: focusedScope, profileScope: focusedScope });
    const credentials = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(async (serverUrl: string) => {
        const key = byOrigin.get(new URL(serverUrl).origin);
        const accountId = key ? accounts.get(key) : undefined;
        return accountId ? { token: tokenFor(accountId) } : null;
    });
    const requests: ServedHomeRequest[] = [];
    setRuntimeFetch(async (url, init) => {
        const target = new URL(String(url));
        if (target.pathname === '/health' || target.pathname === '/v1/auth/ping') return Response.json({});
        const home = byOrigin.get(target.origin);
        if (!home) throw new Error(`Request to an unknown Home: ${target.origin}`);
        if (target.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
        if (target.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
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
    return {
        homes,
        requests,
        /** The Home now signs in as another Account (a sign-out and sign-in elsewhere). */
        switchAccount(key: string, accountId: string) {
            accounts.set(key, accountId);
        },
        dispose() {
            executorBridge.dispose();
            resetRuntimeFetch();
            credentials.mockRestore();
        },
    };
}
