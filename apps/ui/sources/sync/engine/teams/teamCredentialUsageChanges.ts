/**
 * Mounted readers of credential, Team and Home usage, woken by the Home's
 * content-free `team-credential-usage-changed` ephemeral after an immutable
 * usage write.
 *
 * This is an observation seam over the existing socket ephemeral, not a second
 * synchronization system: it opens no socket, keeps no cursor, stores nothing
 * and promises no delivery beyond the ephemeral itself. The usage query stays the
 * only source of numbers; a reader that was not mounted reads current usage when
 * it opens.
 */
import type { TeamCredentialUsageQueryInputV1 } from '@happier-dev/protocol/teams';
type Listener = () => void;

const listenersByResource = new Map<string, Set<Listener>>();

function resourceKey(serverId: string, target: Pick<TeamCredentialUsageQueryInputV1, 'resourceId' | 'subject'>): string {
    return JSON.stringify([serverId, target.resourceId ?? null, target.subject?.kind ?? null,
        target.subject?.kind === 'team' ? target.subject.teamId : null]);
}

export function notifyTeamCredentialUsageChanged(params: Readonly<{ serverId: string; resourceId: string; teamId?: string }>): void {
    const targets: Pick<TeamCredentialUsageQueryInputV1, 'resourceId' | 'subject'>[] = [
        { resourceId: params.resourceId },
        { subject: { kind: 'home' } },
        ...(params.teamId ? [{ subject: { kind: 'team' as const, teamId: params.teamId } }] : []),
    ];
    for (const target of targets) {
        const listeners = listenersByResource.get(resourceKey(params.serverId, target));
        if (!listeners) continue;
        for (const listener of Array.from(listeners)) {
            try {
                listener();
            } catch {
                // One mounted reader cannot suppress the wake for its siblings.
            }
        }
    }
}

export function subscribeTeamCredentialUsageChanged(
    params: Readonly<{ serverId: string }> & Pick<TeamCredentialUsageQueryInputV1, 'resourceId' | 'subject'>,
    listener: Listener,
): () => void {
    const key = resourceKey(params.serverId, params);
    const listeners = listenersByResource.get(key) ?? new Set<Listener>();
    listeners.add(listener);
    listenersByResource.set(key, listeners);
    return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && listenersByResource.get(key) === listeners) listenersByResource.delete(key);
    };
}
