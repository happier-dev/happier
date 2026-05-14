import {
    resolveSessionRoutePathForSurface,
    type SessionMobileSurface,
} from './sessionCockpitState';

export type SessionDetailsSourceSurface = Exclude<SessionMobileSurface, 'tabs'>;

type SessionRouteQueryValue = string | number | boolean | null | undefined;

export function normalizeSessionDetailsSourceSurface(value: unknown): SessionDetailsSourceSurface | null {
    const raw = Array.isArray(value) ? value[0] : value;
    const normalized = typeof raw === 'string' ? raw.trim() : '';
    if (normalized === 'chat' || normalized === 'browse' || normalized === 'git' || normalized === 'terminal') {
        return normalized;
    }
    return null;
}

export function resolveSessionDetailsSourceSurface(surface: SessionMobileSurface): SessionDetailsSourceSurface | null {
    return surface === 'tabs' ? null : surface;
}

export function buildSessionDetailsRouteQuery(
    query: Readonly<Record<string, SessionRouteQueryValue>>,
    sourceSurface: SessionDetailsSourceSurface | null,
): Readonly<Record<string, SessionRouteQueryValue>> {
    if (!sourceSurface) {
        return query;
    }
    return {
        ...query,
        sourceSurface,
    };
}

export function resolveSessionDetailsFallbackHref(input: Readonly<{
    sessionId: string;
    serverId?: string | null;
    sourceSurface?: unknown;
    fallbackHref: string;
}>): string {
    const sourceSurface = normalizeSessionDetailsSourceSurface(input.sourceSurface);
    if (!sourceSurface) {
        return input.fallbackHref;
    }

    return resolveSessionRoutePathForSurface(input.sessionId, sourceSurface, {
        serverId: input.serverId,
    });
}
