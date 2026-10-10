import { teamAddressKey, type TeamAddress } from '@/sync/domains/teams/teamAddress';

import { firstRouteParam } from '../teamRouteParams';
import type { TeamCredentialSourceHint } from '../teamsRoutes';
import type { TeamsDirectoryRow } from '../teamsDirectoryViewState';
import { createHappierCollectionVisitMemory, resolveHappierCollectionInitialKey } from '@happier-dev/plugin-ui/presentation';

const TEAMS_ROOT_SEGMENTS = ['settings', 'teams'] as const;

/** The addressed Team may be readable to a Home administrator without membership.
 * Keep that observed identity alongside the member directory, not a false empty
 * list. This does not turn a member page sequence into an administered directory.
 */
export function resolveTeamsCollectionRows(rows: readonly TeamsDirectoryRow[], selected: TeamsDirectoryRow | null) {
    if (!selected || selected.team.archivedAt !== null || rows.some((row) => teamAddressKey(row.address) === teamAddressKey(selected.address))) {
        return { rows, supplemented: false };
    }
    return { rows: [...rows, selected], supplemented: true };
}

/**
 * The Team a Teams-collection pathname is about (`/settings/teams/<serverId>/<teamId>/…`), so the
 * rail can show it selected on every destination of that Team. `null` on the index and `new`.
 */
export function resolveSelectedTeamAddress(pathname: string): TeamAddress | null {
    const segments = pathname.split('/').filter((segment) => segment.length > 0);
    if (segments[0] !== TEAMS_ROOT_SEGMENTS[0] || segments[1] !== TEAMS_ROOT_SEGMENTS[1]) return null;
    const serverId = segments[2];
    const teamId = segments[3];
    if (!serverId || !teamId || serverId === 'new') return null;
    try {
        return { serverId: decodeURIComponent(serverId), teamId: decodeURIComponent(teamId) };
    } catch {
        return null;
    }
}

/**
 * The member a Teams-collection pathname is about (`…/<teamId>/members/<membershipId>`), so the
 * Members rail can stand beside the open person. `null` on the roster itself, on the add page and
 * everywhere else in the Team.
 */
export function resolveSelectedTeamMember(
    pathname: string,
): Readonly<{ address: TeamAddress; membershipId: string }> | null {
    const address = resolveSelectedTeamAddress(pathname);
    if (!address) return null;
    const segments = pathname.split('/').filter((segment) => segment.length > 0);
    const membershipId = segments[5];
    if (segments[4] !== 'members' || !membershipId || membershipId === 'add' || segments.length !== 6) return null;
    try {
        return { address, membershipId: decodeURIComponent(membershipId) };
    } catch {
        return null;
    }
}

/**
 * Where a wide Teams collection lands when its route names no Team: the Team opened last, while it
 * is still listed, else the first Team. A Team is its Home and id together; the same id on another
 * Home is another Team.
 */
export function resolveTeamsCollectionLanding(
    rows: readonly TeamsDirectoryRow[],
    lastVisited: TeamAddress | null,
): TeamAddress | null {
    const landingKey = resolveHappierCollectionInitialKey({
        keys: rows.map((row) => teamAddressKey(row.address)),
        lastVisited: lastVisited ? teamAddressKey(lastVisited) : null,
    });
    return rows.find((row) => teamAddressKey(row.address) === landingKey)?.address ?? null;
}

/**
 * The Team opened last in the Teams collection during this app session. Session memory only: a
 * navigation convenience, not a preference, so it is neither persisted nor synced.
 */
const teamVisits = createHappierCollectionVisitMemory<TeamAddress>();

export const recordTeamsCollectionVisit = teamVisits.record;
export const readLastVisitedTeamsCollectionTeam = teamVisits.read;

type RouteParam = string | string[] | undefined;

/** The share-with-Team source a Teams route carries (`teamsDirectoryShareCredentialPath`), or null when incomplete. */
export function readTeamCredentialSourceHint(params: Readonly<Record<string, RouteParam>>): TeamCredentialSourceHint | null {
    const read = (key: string) => firstRouteParam(params[key]).trim();
    const serverId = read('credentialSourceServerId');
    const kind = read('credentialSourceKind');
    if (!serverId) return null;
    if (kind === 'provider_connection') {
        const connectionId = read('credentialSourceConnectionId');
        const credentialSlotId = read('credentialSourceSlotId');
        const machineId = read('credentialSourceMachineId');
        const connectionSecurityFingerprint = read('credentialSourceConnectionSecurityFingerprint');
        return connectionId && credentialSlotId && machineId && connectionSecurityFingerprint
            ? { kind: 'provider_connection', serverId, machineId, connectionId, credentialSlotId, connectionSecurityFingerprint }
            : null;
    }
    const pluginId = read('credentialSourcePluginId');
    const localId = read('credentialSourceLocalId');
    if (!pluginId || !localId) return null;
    const service = { pluginId, localId };
    if (kind === 'connected_pool') {
        const groupId = read('credentialSourceGroupId');
        return groupId ? { kind: 'connected_pool', serverId, service, groupId } : null;
    }
    const accountId = read('credentialSourceAccountId');
    return accountId ? { kind: 'connected_account', serverId, account: { service, accountId } } : null;
}
