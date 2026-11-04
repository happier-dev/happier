import {
    TEAM_CREDENTIAL_ROUTES_V1,
    TeamCredentialAllowedRoutesV1Schema,
    TeamCredentialDeliveryConfigurationV1Schema,
    type TeamCredentialAllowedRoutesV1,
    type TeamCredentialDeliveryConfigurationV1,
    type TeamCredentialResourceReplacementV1,
} from '@happier-dev/protocol/teams/credentials/resourceV1';

type StoredRead<T> = Readonly<{ success: true; data: T }> | Readonly<{ success: false }>;

/** Retained disclosure ceilings remain readable; retired Team consent is unused. */
export function readTeamCredentialDeliveryConfiguration(value: string): StoredRead<TeamCredentialDeliveryConfigurationV1> {
    if (value === 'brokered_only' || value === 'direct_allowed') return { success: true, data: {
        policy: { preferredAllowedModes: value === 'brokered_only' ? ['brokered'] : ['brokered', 'direct'] },
    } };
    let decoded: unknown;
    try { decoded = JSON.parse(value); } catch { return { success: false }; }
    if (decoded && typeof decoded === 'object' && !Array.isArray(decoded)) {
        const { experimentalBindingConfirmations: _retiredTeamConsent, ...configuration } = decoded as Record<string, unknown>;
        decoded = configuration;
    }
    const parsed = TeamCredentialDeliveryConfigurationV1Schema.safeParse(decoded);
    return parsed.success ? { success: true, data: parsed.data } : { success: false };
}

/** Only persisted legacy grants accept the old pair-only spellings. */
export function readTeamCredentialAllowedRoutes(value: string): StoredRead<TeamCredentialAllowedRoutesV1> {
    const legacy = value === 'brokered' ? ['brokered'] : value === 'direct' ? ['direct']
        : value === 'both' ? ['brokered', 'direct'] : null;
    let decoded: unknown;
    try { decoded = legacy ?? JSON.parse(value); } catch { return { success: false }; }
    const parsed = TeamCredentialAllowedRoutesV1Schema.safeParse(decoded);
    return parsed.success ? { success: true, data: TEAM_CREDENTIAL_ROUTES_V1.filter(route => parsed.data.includes(route)) }
        : { success: false };
}

/** Audience ordering is meaningless; stable encoding preserves equal writes. */
export function serializeTeamCredentialAllowedRoutes(routes: TeamCredentialAllowedRoutesV1): string {
    const admitted = TeamCredentialAllowedRoutesV1Schema.parse(routes);
    return JSON.stringify(TEAM_CREDENTIAL_ROUTES_V1.filter(route => admitted.includes(route)));
}

export type TeamCredentialAudience = Pick<TeamCredentialResourceReplacementV1,
    'allMembersAllowedRoutes' | 'groupGrants' | 'memberGrants'>;

/** The single persisted-audience boundary, shared by administration and mutation. */
export function readTeamCredentialAudience(value: Readonly<{
    allMembersDeliveryMode: string | null;
    groupGrants: readonly Readonly<{ teamGroupId: string; deliveryMode: string }>[];
    memberGrants: readonly Readonly<{ teamMembershipId: string; deliveryMode: string }>[];
}>): StoredRead<TeamCredentialAudience> {
    const all = value.allMembersDeliveryMode === null ? { success: true as const, data: null }
        : readTeamCredentialAllowedRoutes(value.allMembersDeliveryMode);
    if (!all.success) return { success: false };
    const groupGrants: TeamCredentialAudience['groupGrants'] = [];
    const memberGrants: TeamCredentialAudience['memberGrants'] = [];
    for (const grant of value.groupGrants) {
        const routes = readTeamCredentialAllowedRoutes(grant.deliveryMode);
        if (!routes.success) return { success: false };
        groupGrants.push({ teamGroupId: grant.teamGroupId, allowedRoutes: routes.data });
    }
    for (const grant of value.memberGrants) {
        const routes = readTeamCredentialAllowedRoutes(grant.deliveryMode);
        if (!routes.success) return { success: false };
        memberGrants.push({ teamMembershipId: grant.teamMembershipId, allowedRoutes: routes.data });
    }
    return { success: true, data: { allMembersAllowedRoutes: all.data, groupGrants, memberGrants } };
}

export function serializeTeamCredentialAudience(value: TeamCredentialAudience) {
    return {
        allMembersDeliveryMode: value.allMembersAllowedRoutes === null ? null : serializeTeamCredentialAllowedRoutes(value.allMembersAllowedRoutes),
        groupGrants: value.groupGrants.map(grant => ({ teamGroupId: grant.teamGroupId, deliveryMode: serializeTeamCredentialAllowedRoutes(grant.allowedRoutes) })),
        memberGrants: value.memberGrants.map(grant => ({ teamMembershipId: grant.teamMembershipId, deliveryMode: serializeTeamCredentialAllowedRoutes(grant.allowedRoutes) })),
    };
}

/** Narrowing withdraws only removed routes, never grants another route. */
export function narrowTeamCredentialAudience(value: TeamCredentialAudience, allowed: readonly string[]): TeamCredentialAudience {
    const narrow = (routes: TeamCredentialAllowedRoutesV1) => routes.filter(route => allowed.includes(route));
    const all = value.allMembersAllowedRoutes === null ? [] : narrow(value.allMembersAllowedRoutes);
    return { allMembersAllowedRoutes: all.length ? all : null,
        groupGrants: value.groupGrants.flatMap(grant => {
            const allowedRoutes = narrow(grant.allowedRoutes);
            return allowedRoutes.length ? [{ ...grant, allowedRoutes }] : [];
        }),
        memberGrants: value.memberGrants.flatMap(grant => {
            const allowedRoutes = narrow(grant.allowedRoutes);
            return allowedRoutes.length ? [{ ...grant, allowedRoutes }] : [];
        }) };
}
