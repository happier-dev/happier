export const TERMINAL_CONNECT_WEB_BOOTSTRAP_STORAGE_KEY = 'happier:terminalConnect:webBootstrapHash:v1';

function normalizeWebPathname(raw: string): string {
    let path = String(raw ?? '');
    if (!path.startsWith('/')) path = `/${path}`;
    return path.replace(/\/+$/, '') || '/';
}

function isTerminalConnectPath(pathname: string): boolean {
    return normalizeWebPathname(pathname) === '/terminal/connect';
}

/**
 * Work around Expo Router's initial web linking handling when a deep-link includes a hash fragment.
 *
 * We stash the fragment in sessionStorage and remove it from the visible URL *before* the router initializes.
 * The terminal connect route then reads the stashed fragment and clears it.
 */
export function bootstrapTerminalConnectWebHash(params: Readonly<{
    url: URL;
    sessionStorage: Pick<Storage, 'getItem' | 'setItem'>;
    history: Pick<History, 'replaceState'>;
}>): void {
    if (!isTerminalConnectPath(params.url.pathname)) return;
    const hash = String(params.url.hash ?? '');
    if (!hash) return;
    if (!hash.includes('key=')) return;

    try {
        params.sessionStorage.setItem(TERMINAL_CONNECT_WEB_BOOTSTRAP_STORAGE_KEY, hash);
    } catch {
        // Best-effort only.
    }

    try {
        const normalizedPath = normalizeWebPathname(params.url.pathname);
        const search = String(params.url.search ?? '');
        params.history.replaceState(null, '', `${normalizedPath}${search}`);
    } catch {
        // Best-effort only.
    }
}

export function consumeTerminalConnectWebBootstrapHash(
    sessionStorage: Pick<Storage, 'getItem' | 'removeItem'>,
): string | null {
    try {
        const stored = sessionStorage.getItem(TERMINAL_CONNECT_WEB_BOOTSTRAP_STORAGE_KEY);
        if (!stored) return null;
        sessionStorage.removeItem(TERMINAL_CONNECT_WEB_BOOTSTRAP_STORAGE_KEY);
        return stored;
    } catch {
        return null;
    }
}
