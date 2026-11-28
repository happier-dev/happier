import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { loadExpoNotifications } from '@/utils/platform/loadExpoNotifications';
import { findSavedNotificationServerProfile } from './resolveNotificationPermissionTarget';

export type AgentRequestNotificationIdentity = ServerAccountScope & Readonly<{
    kind: 'permission' | 'user_action';
    sessionId: string;
    requestId: string;
    occurrenceId: string;
}>;

function readIdentity(value: unknown): AgentRequestNotificationIdentity | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const data = value as Record<string, unknown>;
    const { kind, accountId, serverUrl, sessionId, requestId, occurrenceId } = data;
    if ((kind !== 'permission' && kind !== 'user_action')
        || typeof accountId !== 'string' || !accountId
        || typeof serverUrl !== 'string'
        || typeof sessionId !== 'string' || !sessionId
        || typeof requestId !== 'string' || !requestId
        || typeof occurrenceId !== 'string' || !occurrenceId) return null;
    const home = findSavedNotificationServerProfile(serverUrl);
    if (!home) return null;
    const serverId = resolveServerProfileScopeIdForIdentifier(home.id);
    return { serverId, accountId, kind, sessionId, requestId, occurrenceId };
}

/** Current OS inventory supplies presentation demand. The caller supplies proof of settlement. */
export async function dismissSettledAgentRequestNotifications(
    resolveSettlement: (identity: AgentRequestNotificationIdentity) => AgentRequestNotificationIdentity | null,
    onPresentedSessions?: (sessionIds: Set<string>) => void,
): Promise<void> {
    const notifications = await loadExpoNotifications();
    const inventory = await notifications.getPresentedNotificationsAsync();
    const presented = inventory.flatMap(({ request }) => {
        const identity = readIdentity(request.content.data);
        return identity ? [{ identifier: request.identifier, identity }] : [];
    });
    onPresentedSessions?.(new Set(presented.map(({ identity }) => identity.sessionId)));
    for (const { identifier, identity } of presented) {
        const settled = resolveSettlement(identity);
        if (settled && identity.accountId === settled.accountId
            && areServerProfileIdentifiersEquivalent(identity.serverId, settled.serverId)
            && identity.kind === settled.kind && identity.sessionId === settled.sessionId
            && identity.requestId === settled.requestId && identity.occurrenceId === settled.occurrenceId) {
            await notifications.dismissNotificationAsync(identifier);
        }
    }
}

export function dismissConfirmedAgentRequestNotification(settled: AgentRequestNotificationIdentity): Promise<void> {
    return dismissSettledAgentRequestNotifications(() => settled);
}
