export type WebHmrOptOutAction = 'disable' | 'enable' | 'reset';

export type WebHmrOptOutResolution = {
    disabled: boolean;
    nextSessionValue: string | null;
    shouldStripQueryParam: boolean;
};

export type WebHmrOptOutRuntimeState = {
    available: boolean;
    disabled: boolean;
    enabled: boolean;
    guardInstalled: boolean;
    requiresPageReload: boolean;
};

export const WEB_HMR_OPT_OUT_QUERY_PARAM = 'happier_hmr';
export const WEB_HMR_OPT_OUT_SESSION_STORAGE_KEY = 'happier.web.hmrOptOut';

declare global {
    // Per-tab opt-out flag used by our Expo async-require shim (see metro.config.js).
    // When true, web HMR is initialized but disabled (no Fast Refresh / autoreload).
    // When false/undefined, default Expo web dev behavior remains unchanged.
    // eslint-disable-next-line no-var
    var __HAPPIER_WEB_HMR_OPT_OUT__: boolean | undefined;

    // eslint-disable-next-line no-var
    var __HAPPIER_WEB_HMR_OPT_OUT_WEBSOCKET_GUARD__:
        | {
              originalWebSocket: WebSocketCtorLike;
              sessionStorage: SessionStorageLike;
              fallbackPageUrl: URL;
          }
        | undefined;
}

export function resolveWebHmrOptOutActionFromUrl(url: URL): WebHmrOptOutAction | null {
    const raw = url.searchParams.get(WEB_HMR_OPT_OUT_QUERY_PARAM);
    if (!raw) return null;

    const v = raw.trim().toLowerCase();
    if (v === 'reset' || v === 'clear') return 'reset';
    if (v === '0' || v === 'false' || v === 'off' || v === 'disable' || v === 'disabled') return 'disable';
    if (v === '1' || v === 'true' || v === 'on' || v === 'enable' || v === 'enabled') return 'enable';

    return null;
}

export function stripWebHmrOptOutQueryParam(url: URL): boolean {
    const had = url.searchParams.has(WEB_HMR_OPT_OUT_QUERY_PARAM);
    url.searchParams.delete(WEB_HMR_OPT_OUT_QUERY_PARAM);
    return had;
}

export function resolveWebHmrOptOutResolution({
    url,
    sessionValue,
}: {
    url: URL;
    sessionValue: string | null;
}): WebHmrOptOutResolution {
    const action = resolveWebHmrOptOutActionFromUrl(url);
    const hadQueryParam = url.searchParams.has(WEB_HMR_OPT_OUT_QUERY_PARAM);

    if (action === 'disable') {
        return { disabled: true, nextSessionValue: 'disabled', shouldStripQueryParam: true };
    }

    if (action === 'enable' || action === 'reset') {
        return { disabled: false, nextSessionValue: null, shouldStripQueryParam: true };
    }

    return {
        disabled: sessionValue === 'disabled',
        nextSessionValue: sessionValue ?? null,
        shouldStripQueryParam: hadQueryParam,
    };
}

type SessionStorageLike = {
    getItem: (key: string) => string | null;
    setItem: (key: string, value: string) => void;
    removeItem: (key: string) => void;
};

type HistoryLike = {
    replaceState: (data: unknown, unused: string, url?: string | URL | null) => void;
};

type WebSocketCtorLike = {
    new (url: string | URL, protocols?: string | string[]): unknown;
    CONNECTING?: number;
    OPEN?: number;
    CLOSING?: number;
    CLOSED?: number;
};

type WebSocketGlobalTargetLike = {
    WebSocket?: WebSocketCtorLike;
    location?: {
        href?: string;
    };
    __HAPPIER_WEB_HMR_OPT_OUT__?: boolean;
    __HAPPIER_WEB_HMR_OPT_OUT_WEBSOCKET_GUARD__?: typeof globalThis.__HAPPIER_WEB_HMR_OPT_OUT_WEBSOCKET_GUARD__;
};

function isWebHmrOptOutDisabled(
    sessionStorage: SessionStorageLike,
    globalTarget: WebSocketGlobalTargetLike = globalThis,
): boolean {
    return (
        sessionStorage.getItem(WEB_HMR_OPT_OUT_SESSION_STORAGE_KEY) === 'disabled' ||
        globalTarget.__HAPPIER_WEB_HMR_OPT_OUT__ === true
    );
}

export function readWebHmrOptOutRuntimeState({
    sessionStorage,
    globalTarget = globalThis,
}: {
    sessionStorage: SessionStorageLike | null | undefined;
    globalTarget?: WebSocketGlobalTargetLike;
}): WebHmrOptOutRuntimeState {
    if (!sessionStorage) {
        return {
            available: false,
            disabled: false,
            enabled: false,
            guardInstalled: Boolean(globalTarget.__HAPPIER_WEB_HMR_OPT_OUT_WEBSOCKET_GUARD__),
            requiresPageReload: true,
        };
    }

    const disabled = isWebHmrOptOutDisabled(sessionStorage, globalTarget);
    return {
        available: true,
        disabled,
        enabled: !disabled,
        guardInstalled: Boolean(globalTarget.__HAPPIER_WEB_HMR_OPT_OUT_WEBSOCKET_GUARD__),
        requiresPageReload: true,
    };
}

export function setWebHmrOptOutDisabledForWebTab({
    disabled,
    sessionStorage,
    globalTarget = globalThis,
}: {
    disabled: boolean;
    sessionStorage: SessionStorageLike;
    globalTarget?: WebSocketGlobalTargetLike;
}): WebHmrOptOutRuntimeState {
    if (disabled) {
        sessionStorage.setItem(WEB_HMR_OPT_OUT_SESSION_STORAGE_KEY, 'disabled');
    } else {
        sessionStorage.removeItem(WEB_HMR_OPT_OUT_SESSION_STORAGE_KEY);
    }

    globalTarget.__HAPPIER_WEB_HMR_OPT_OUT__ = disabled;
    return readWebHmrOptOutRuntimeState({ sessionStorage, globalTarget });
}

export function shouldBlockExpoDevWebSocket({
    disabled,
    socketUrl,
    pageUrl,
}: {
    disabled: boolean;
    socketUrl: string | URL;
    pageUrl: URL;
}): boolean {
    if (!disabled) {
        return false;
    }

    let resolvedUrl: URL;
    try {
        resolvedUrl = new URL(String(socketUrl), pageUrl.toString());
    } catch {
        return false;
    }

    if (resolvedUrl.protocol !== 'ws:' && resolvedUrl.protocol !== 'wss:') {
        return false;
    }

    if (resolvedUrl.host !== pageUrl.host) {
        return false;
    }

    const pathname = resolvedUrl.pathname.replace(/\/+$/, '') || '/';
    return pathname === '/hot' || pathname === '/message';
}

function createBlockedWebSocket({
    socketUrl,
    nativeWebSocket,
}: {
    socketUrl: string | URL;
    nativeWebSocket: WebSocketCtorLike;
}) {
    const listeners = new Map<string, Set<(event: unknown) => void>>();
    const openValue = nativeWebSocket.OPEN ?? 1;

    const addListener = (type: string, listener: (event: unknown) => void) => {
        const existing = listeners.get(type) ?? new Set<(event: unknown) => void>();
        existing.add(listener);
        listeners.set(type, existing);
    };

    const removeListener = (type: string, listener: (event: unknown) => void) => {
        listeners.get(type)?.delete(listener);
    };

    const dispatch = (type: string, event: unknown) => {
        listeners.get(type)?.forEach((listener) => listener(event));
    };

    const blocked = {
        url: String(socketUrl),
        readyState: openValue,
        bufferedAmount: 0,
        extensions: '',
        protocol: '',
        binaryType: 'blob',
        onopen: null as ((event: unknown) => void) | null,
        onerror: null as ((event: unknown) => void) | null,
        onclose: null as ((event: unknown) => void) | null,
        onmessage: null as ((event: unknown) => void) | null,
        addEventListener(type: string, listener: (event: unknown) => void) {
            addListener(type, listener);
        },
        removeEventListener(type: string, listener: (event: unknown) => void) {
            removeListener(type, listener);
        },
        dispatchEvent(event: { type?: string } | undefined) {
            const type = String(event?.type ?? '').trim();
            if (!type) {
                return true;
            }
            dispatch(type, event);
            return true;
        },
        send() {
            return undefined;
        },
        close() {
            return undefined;
        },
    };

    queueMicrotask(() => {
        // IMPORTANT:
        // This socket stub must behave like a successful, stable connection.
        // Expo's HMRClient treats WebSocket close/error as a "Metro disconnected" state and will
        // aggressively call `window.location.reload()` to recover (which defeats our per-tab opt-out).
        // By emitting a single open event (and never emitting error/close), we keep bundle splitting
        // register-entrypoints calls from crashing without allowing any update messages through.
        const openEvent = {
            type: 'open',
        };
        blocked.onopen?.(openEvent);
        dispatch('open', openEvent);
    });

    return blocked;
}

export function installWebHmrOptOutWebSocketGuard({
    pageUrl,
    sessionStorage,
    globalTarget = globalThis as WebSocketGlobalTargetLike,
}: {
    pageUrl: URL;
    sessionStorage: SessionStorageLike;
    globalTarget?: WebSocketGlobalTargetLike;
}): void {
    const existing = globalTarget.__HAPPIER_WEB_HMR_OPT_OUT_WEBSOCKET_GUARD__;
    if (existing) {
        existing.sessionStorage = sessionStorage;
        existing.fallbackPageUrl = pageUrl;
        return;
    }

    const NativeWebSocket = globalTarget.WebSocket;
    if (typeof NativeWebSocket !== 'function') {
        return;
    }

    globalTarget.__HAPPIER_WEB_HMR_OPT_OUT_WEBSOCKET_GUARD__ = {
        originalWebSocket: NativeWebSocket,
        sessionStorage,
        fallbackPageUrl: pageUrl,
    };

    globalTarget.WebSocket = new Proxy(NativeWebSocket, {
        construct(target, args, newTarget) {
            const guardState = globalTarget.__HAPPIER_WEB_HMR_OPT_OUT_WEBSOCKET_GUARD__;
            const currentPageUrl = (() => {
                try {
                    const href = String(globalTarget.location?.href ?? '').trim();
                    return href ? new URL(href) : guardState?.fallbackPageUrl ?? pageUrl;
                } catch {
                    return guardState?.fallbackPageUrl ?? pageUrl;
                }
            })();

            if (
                guardState &&
                shouldBlockExpoDevWebSocket({
                    disabled: isWebHmrOptOutDisabled(guardState.sessionStorage, globalTarget),
                    socketUrl: args[0] as string | URL,
                    pageUrl: currentPageUrl,
                })
            ) {
                return createBlockedWebSocket({
                    socketUrl: args[0] as string | URL,
                    nativeWebSocket: guardState.originalWebSocket,
                });
            }

            return Reflect.construct(target, args, newTarget);
        },
    }) as WebSocketCtorLike;
}

export function installWebHmrOptOutForWebTab({
    url,
    sessionStorage,
    history,
}: {
    url: URL;
    sessionStorage: SessionStorageLike;
    history: HistoryLike;
}): boolean {
    const sessionValue = sessionStorage.getItem(WEB_HMR_OPT_OUT_SESSION_STORAGE_KEY);
    const res = resolveWebHmrOptOutResolution({ url, sessionValue });

    if (res.nextSessionValue === null) {
        if (sessionValue !== null) {
            sessionStorage.removeItem(WEB_HMR_OPT_OUT_SESSION_STORAGE_KEY);
        }
    } else if (sessionValue !== res.nextSessionValue) {
        sessionStorage.setItem(WEB_HMR_OPT_OUT_SESSION_STORAGE_KEY, res.nextSessionValue);
    }

    // IMPORTANT:
    // Treat query-param stripping as best-effort only. Some environments can throw from replaceState
    // (or other history shims) even when the URL is same-origin. We still want the opt-out decision
    // and WebSocket guard to be applied reliably for this tab.
    globalThis.__HAPPIER_WEB_HMR_OPT_OUT__ = res.disabled;
    installWebHmrOptOutWebSocketGuard({
        pageUrl: url,
        sessionStorage,
    });

    if (res.shouldStripQueryParam) {
        try {
            const nextUrl = new URL(url.toString());
            if (stripWebHmrOptOutQueryParam(nextUrl)) {
                history.replaceState(null, '', nextUrl.toString());
            }
        } catch {
            // Best-effort: ok to keep the query param if history is unavailable/broken.
        }
    }

    return res.disabled;
}

export function installWebHmrOptOutForCurrentWebTab(): boolean {
    if (typeof window === 'undefined') {
        return false;
    }

    try {
        return installWebHmrOptOutForWebTab({
            url: new URL(window.location.href),
            sessionStorage: window.sessionStorage,
            history: window.history,
        });
    } catch {
        return false;
    }
}
