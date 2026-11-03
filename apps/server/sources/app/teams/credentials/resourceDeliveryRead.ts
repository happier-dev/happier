import {
    TEAM_CREDENTIAL_ROUTES_V1,
    TeamCredentialAllowedRoutesV1Schema,
    TeamCredentialDeliveryConfigurationV1Schema,
    type TeamCredentialAllowedRoutesV1,
    type TeamCredentialDeliveryConfigurationV1,
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
