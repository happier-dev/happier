import {
    isCustomSessionRoleId,
    readBuiltInSessionRoleDisplayNameV1,
    SessionRoleBadgeColorV1Schema,
    SessionRoleProfilesV1Schema,
    type AssignableSessionRoleProfileV1,
    type BuiltInSessionRole,
    type LegacySessionRole,
    type SessionRole,
} from '@happier-dev/protocol';

import { t } from '@/text';

/** Localized role names shared by the row badge, menus, composer chip, and role profile settings. */
export const SESSION_ROLE_LABEL_KEYS = {
    planner: 'sessionRole.planner',
    project_lead: 'sessionRole.projectLead',
    worker: 'sessionRole.worker',
    delegate: 'sessionRole.delegate',
    reviewer: 'sessionRole.reviewer',
} as const satisfies Record<BuiltInSessionRole | LegacySessionRole, string>;

function normalizeDisplayName(value: unknown): string | null {
    return typeof value === 'string' ? value.trim() || null : null;
}

/** One display-only role-name owner. Built-in aliases never become prompt or metadata names. */
export function resolveSessionRoleDisplayName(input: Readonly<{
    role: SessionRole;
    snapshotName?: string | null;
    /** An already-resolved display alias, such as a list-row projection. */
    displayName?: string | null;
    sessionRoleProfilesV1?: unknown;
}>): string {
    if (isCustomSessionRoleId(input.role)) {
        return normalizeDisplayName(input.snapshotName) ?? t('sessionRole.custom');
    }
    return normalizeDisplayName(input.displayName)
        ?? readBuiltInSessionRoleDisplayNameV1(input.sessionRoleProfilesV1, input.role)
        ?? t(SESSION_ROLE_LABEL_KEYS[input.role]);
}

export function resolveAssignableSessionRoleProfileDisplayName(
    profile: AssignableSessionRoleProfileV1,
): string {
    return resolveSessionRoleDisplayName({
        role: profile.id,
        snapshotName: profile.name,
        displayName: profile.displayName,
    });
}

/** Account colors repaint built-ins only; custom identities remain their retained snapshot. */
export function resolveSessionRoleDisplayColor(input: Readonly<{
    role: SessionRole;
    snapshotColor?: string | null;
    sessionRoleProfilesV1?: unknown;
}>): `#${string}` | null {
    const snapshot = SessionRoleBadgeColorV1Schema.safeParse(input.snapshotColor);
    const snapshotColor = snapshot.success ? snapshot.data.toLowerCase() as `#${string}` : null;
    if (isCustomSessionRoleId(input.role)) return snapshotColor;
    const profiles = SessionRoleProfilesV1Schema.safeParse(input.sessionRoleProfilesV1);
    const accountColor = profiles.success
        ? SessionRoleBadgeColorV1Schema.safeParse(profiles.data.colorsByRole?.[input.role])
        : { success: false as const };
    return accountColor.success ? accountColor.data.toLowerCase() as `#${string}` : snapshotColor;
}
