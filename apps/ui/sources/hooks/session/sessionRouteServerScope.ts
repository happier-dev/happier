type SessionRouteServerScopeParams = Readonly<Record<string, unknown>>;

type SessionRouteHrefQueryValue = string | number | boolean | null | undefined;

type BuildScopedSessionRouteHrefParams = Readonly<{
    sessionId: string;
    serverId?: string | null;
    suffix?: string;
    query?: Readonly<Record<string, SessionRouteHrefQueryValue>>;
}>;

export type SessionRouteServerScope = Readonly<{
    serverId: string | null;
    hydrationOptions?: Readonly<{ serverId: string }>;
    withParams: <T extends Record<string, unknown>>(params: T) => T & { serverId?: string };
    buildHref: (sessionId: string, options?: Readonly<{
        suffix?: string;
        query?: Readonly<Record<string, SessionRouteHrefQueryValue>>;
    }>) => string;
}>;

function normalizeRouteParam(value: unknown): string | null {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : null;
    }
    if (Array.isArray(value)) {
        return normalizeRouteParam(value[0]);
    }
    return null;
}

export function readSessionRouteServerId(params: SessionRouteServerScopeParams | null | undefined): string | null {
    if (!params) return null;
    return normalizeRouteParam(params.serverId);
}

export function mergeSessionRouteServerScopeParams<T extends Record<string, unknown>>(
    params: T,
    serverId?: string | null,
): T & { serverId?: string } {
    const normalizedServerId = normalizeRouteParam(serverId);
    if (!normalizedServerId) {
        return params as T & { serverId?: string };
    }
    return {
        ...params,
        serverId: normalizedServerId,
    };
}

export function buildScopedSessionRouteHref(params: BuildScopedSessionRouteHrefParams): string {
    const normalizedSessionId = String(params.sessionId ?? '').trim();
    const normalizedSuffix = typeof params.suffix === 'string' ? params.suffix : '';
    const pathname = `/session/${encodeURIComponent(normalizedSessionId)}${normalizedSuffix}`;
    const searchParams = new URLSearchParams();
    const normalizedServerId = normalizeRouteParam(params.serverId);
    if (normalizedServerId) {
        searchParams.set('serverId', normalizedServerId);
    }

    for (const [key, rawValue] of Object.entries(params.query ?? {})) {
        if (key === 'serverId') continue;
        if (rawValue === null || rawValue === undefined) continue;
        const value = String(rawValue);
        if (value.length === 0) continue;
        searchParams.set(key, value);
    }

    const query = searchParams.toString();
    return query.length > 0 ? `${pathname}?${query}` : pathname;
}

export function createSessionRouteServerScope(
    params: SessionRouteServerScopeParams | null | undefined,
): SessionRouteServerScope {
    const serverId = readSessionRouteServerId(params);

    return {
        serverId,
        hydrationOptions: serverId ? { serverId } : undefined,
        withParams: <T extends Record<string, unknown>>(nextParams: T) =>
            mergeSessionRouteServerScopeParams(nextParams, serverId),
        buildHref: (sessionId: string, options?: Readonly<{
            suffix?: string;
            query?: Readonly<Record<string, SessionRouteHrefQueryValue>>;
        }>) => buildScopedSessionRouteHref({
            sessionId,
            serverId,
            suffix: options?.suffix,
            query: options?.query,
        }),
    };
}
