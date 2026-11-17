import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';

import {
    resolveSessionPaneScreenRoutePath,
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

    // The classic phone's Details page returns to the full-screen pane it was opened from.
    return sourceSurface === 'browse' || sourceSurface === 'git' || sourceSurface === 'terminal'
        ? resolveSessionPaneScreenRoutePath(input.sessionId, sourceSurface, { serverId: input.serverId })
        : resolveSessionRoutePathForSurface(input.sessionId, sourceSurface, { serverId: input.serverId });
}

/**
 * The one link to a Session destination that is both a sidebar tab and a phone surface (Agents,
 * Collaboration): the cockpit's surface route when the cockpit experience is on, otherwise the
 * Session route with that sidebar tab open. An unqualified link stays unqualified so the Session root
 * resolves its Home.
 */
export function buildSessionDestinationRouteHref(input: Readonly<{
    sessionId: string;
    serverId?: string | null;
    cockpitEnabled: boolean;
    surface: SessionMobileSurface;
    rightTabId: string;
    query?: Readonly<Record<string, SessionRouteQueryValue>>;
}>): string {
    const query = input.query ?? {};
    return input.cockpitEnabled
        ? resolveSessionRoutePathForSurface(input.sessionId, input.surface, { serverId: input.serverId, query })
        : buildScopedSessionRouteHref({ sessionId: input.sessionId, serverId: input.serverId, query: { ...query, right: input.rightTabId } });
}
