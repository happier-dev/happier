import { SEEDED_PRODUCT_LEAD_ROLE_PROFILE_V1 } from '@happier-dev/protocol';

export function seedSessionRoleProfilesIfAbsent(
    raw: Record<string, unknown> | null,
): Readonly<{ raw: Record<string, unknown>; seeded: boolean }> {
    if (raw && Object.prototype.hasOwnProperty.call(raw, 'sessionRoleProfilesV1')) {
        return { raw, seeded: false };
    }
    return {
        raw: {
            ...(raw ?? {}),
            sessionRoleProfilesV1: {
                v: 1,
                instructionsByRole: {},
                customRoles: [{ ...SEEDED_PRODUCT_LEAD_ROLE_PROFILE_V1 }],
            },
        },
        seeded: true,
    };
}
