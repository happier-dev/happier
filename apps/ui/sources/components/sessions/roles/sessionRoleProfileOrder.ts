import {
    listAssignableSessionRoleProfilesV1,
    SEEDED_PRODUCT_LEAD_ROLE_PROFILE_V1,
    type AssignableSessionRoleProfileV1,
    type BuiltInSessionRole,
} from '@happier-dev/protocol';

const UI_BUILT_IN_SESSION_ROLE_ORDER: readonly BuiltInSessionRole[] = [
    'project_lead',
    'planner',
    'worker',
    'reviewer',
];

/**
 * UI catalog order. The persisted Repo Admin template is recognized only by its stable id;
 * absent/deleted templates are never synthesized or advertised to assignment callers.
 */
export function listUiAssignableSessionRoleProfiles(
    settings: unknown,
): readonly AssignableSessionRoleProfileV1[] {
    const profiles = listAssignableSessionRoleProfilesV1(settings);
    const byId = new Map(profiles.map((profile) => [profile.id, profile]));
    const productLead = byId.get(SEEDED_PRODUCT_LEAD_ROLE_PROFILE_V1.id);
    const builtIns = UI_BUILT_IN_SESSION_ROLE_ORDER.flatMap((role) => {
        const profile = byId.get(role);
        return profile ? [profile] : [];
    });
    const additionalCustomRoles = profiles.filter((profile) => (
        profile.kind === 'custom' && profile.id !== SEEDED_PRODUCT_LEAD_ROLE_PROFILE_V1.id
    ));
    return [...(productLead ? [productLead] : []), ...builtIns, ...additionalCustomRoles];
}
