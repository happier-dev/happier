import {
    serverAccountScopeKeySuffix,
    type ServerAccountScope,
} from '@/sync/domains/scope/serverAccountScope';

/**
 * The client-side identity of one Team on one exact Home.
 *
 * This is navigation, selection and cache identity only. It is never sent to a
 * Home, never persisted in a Home-local Team row, and never used as an
 * authorization fact: the Home authorizes every Team operation itself.
 *
 * `serverId` is the existing server-profile scope id (`resolveServerProfileScopeId`).
 * Callers normalize an arbitrary identifier through that owner before building
 * an address, exactly as they do for `ServerAccountScope`; this module owns the
 * identity contract, not profile resolution.
 */
export type TeamAddress = Readonly<{
    serverId: string;
    teamId: string;
}>;

function normalizeTeamAddressPart(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

/**
 * Builds an address, or `null` when either half is missing. A Team ID alone is
 * deliberately not addressable: two Homes may legitimately hold the same one.
 */
export function createTeamAddress(serverId: unknown, teamId: unknown): TeamAddress | null {
    const normalizedServerId = normalizeTeamAddressPart(serverId);
    const normalizedTeamId = normalizeTeamAddressPart(teamId);
    if (!normalizedServerId || !normalizedTeamId) return null;
    return {
        serverId: normalizedServerId,
        teamId: normalizedTeamId,
    };
}

/** A missing address is unequal to everything, including another missing one. */
export function areTeamAddressesEqual(
    a: TeamAddress | null | undefined,
    b: TeamAddress | null | undefined,
): boolean {
    if (!a || !b) return false;
    return a.serverId === b.serverId && a.teamId === b.teamId;
}

function encodeAddressPart(value: string): string {
    return `${value.length}:${value}`;
}

/**
 * A collision-safe key. Length prefixes keep `('home:1', 'team')` and
 * `('home', '1:team')` distinct, so no separator inside an id can make two
 * different Teams share one cache entry.
 */
export function teamAddressKey(address: TeamAddress): string {
    return `${encodeAddressPart(address.serverId)}${encodeAddressPart(address.teamId)}`;
}

/**
 * The cache key for Team detail. Team snapshots are qualified by the exact
 * server *and Account*: two Accounts on one Home see different Teams, roles and
 * capabilities and must never read each other's rows.
 */
export function serverAccountScopedTeamKey(scope: ServerAccountScope, address: TeamAddress): string {
    return `${serverAccountScopeKeySuffix(scope)}${teamAddressKey(address)}`;
}

/** Home setup visibility uses the Account-qualified Team identity. */
export function teamSetupStepId(scope: ServerAccountScope, address: TeamAddress): string {
    return `team:${serverAccountScopedTeamKey(scope, { serverId: scope.serverId, teamId: address.teamId })}`;
}

/**
 * Collision-safe identity for a Team-owned projection below Team detail.
 * Every discriminator is length-prefixed, so filters and opaque IDs may
 * contain spaces, colons, slashes, or each other's apparent separators.
 */
export function serverAccountScopedTeamResourceKey(
    scope: ServerAccountScope,
    address: TeamAddress,
    ...parts: readonly string[]
): string {
    return `${serverAccountScopedTeamKey(scope, address)}${parts.map(encodeAddressPart).join('')}`;
}
