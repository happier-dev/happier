import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import {
    isAutomationSessionCandidate,
    type AutomationSessionCandidate,
} from './isAutomationSessionCandidate';

type AutomationAuthoritySession = AutomationSessionCandidate & Readonly<{
    id: string;
    serverId?: string | null;
}>;

export type SessionAutomationAuthority = Readonly<{
    sessionId: string;
    serverId: string;
    accountLifetime: ActiveServerAccountScopeLifetime;
    isCurrent(): boolean;
}>;

/**
 * Binds a Session Automation surface to the hydrated Session's owning server,
 * the matching route, and the active Account lifetime. A route hint is never
 * promoted above the hydrated Session owner.
 */
export function captureSessionAutomationAuthority(params: Readonly<{
    session: AutomationAuthoritySession | null | undefined;
    routeSessionId: string | null | undefined;
    routeServerId?: string | null;
    activeServerId: string | null | undefined;
    automationsEnabled: boolean;
    accountSettings?: Record<string, unknown> | null;
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    readCurrent: () => Readonly<{
        session: AutomationAuthoritySession | null | undefined;
        routeSessionId: string | null | undefined;
        routeServerId?: string | null;
        activeServerId: string | null | undefined;
        automationsEnabled: boolean;
        accountSettings?: Record<string, unknown> | null;
    }>;
}>): SessionAutomationAuthority | null {
    const sessionId = String(params.session?.id ?? '').trim();
    const serverId = String(params.session?.serverId ?? '').trim();
    if (
        !sessionId
        || !serverId
        || params.routeSessionId !== sessionId
        || (params.routeServerId != null && params.routeServerId !== serverId)
        || params.activeServerId !== serverId
        || params.automationsEnabled !== true
        || !isAutomationSessionCandidate(params.session, params.accountSettings)
        || !params.accountLifetime?.isCurrent()
    ) return null;

    const accountLifetime = params.accountLifetime;
    return Object.freeze({
        sessionId,
        serverId,
        accountLifetime,
        isCurrent(): boolean {
            if (!accountLifetime.isCurrent()) return false;
            const current = params.readCurrent();
            return current.automationsEnabled === true
                && current.session != null
                && isAutomationSessionCandidate(current.session, current.accountSettings)
                && current.routeSessionId === sessionId
                && (current.routeServerId == null || current.routeServerId === serverId)
                && current.activeServerId === serverId
                && current.session?.id === sessionId
                && current.session.serverId === serverId;
        },
    });
}
