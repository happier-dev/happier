type SessionPaneUrlParamShape = Readonly<{
    right?: unknown;
    bottom?: unknown;
    details?: unknown;
    path?: unknown;
    sha?: unknown;
}>;

const SESSION_PANE_URL_PARAM_KEYS = ['right', 'bottom', 'details', 'path', 'sha'] as const;

function normalizeSessionPaneUrlParamValue(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

export function pushSessionPaneUrlParams(params: SessionPaneUrlParamShape): boolean {
    if (typeof window === 'undefined') {
        return false;
    }

    const history = window.history;
    const href = window.location?.href;
    if (typeof href !== 'string' || typeof history?.pushState !== 'function') {
        return false;
    }

    try {
        const url = new URL(href);
        for (const key of SESSION_PANE_URL_PARAM_KEYS) {
            const nextValue = normalizeSessionPaneUrlParamValue(params[key]);
            if (nextValue) {
                url.searchParams.set(key, nextValue);
            } else {
                url.searchParams.delete(key);
            }
        }
        history.pushState(history.state ?? null, '', url.toString());
        return true;
    } catch {
        return false;
    }
}
