import { SessionEffectiveAccessV1Schema, projectLegacySessionAccessCapabilitiesV1, readSessionAccessProjectionRoleV1, sessionAccessProjectionRoleFromLevelV1, type SessionAccessCapabilitiesV1, type SessionEffectiveAccessV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { SessionShareSchema } from '@happier-dev/protocol/sessions/control/contract';

export type NormalizedSessionAccessProjection = Readonly<{
    role: 'owner' | 'recipient';
    level: SessionEffectiveAccessV1['level'];
    capabilities: SessionAccessCapabilitiesV1;
    sources?: SessionEffectiveAccessV1['sources'];
    audienceContext?: SessionEffectiveAccessV1['audienceContext'];
    primaryTeamId?: SessionEffectiveAccessV1['primaryTeamId'];
}>;

// The access has already passed the strict schema at its input boundary.
export function projectAdmittedSessionAccess(access: SessionEffectiveAccessV1): NormalizedSessionAccessProjection {
    return {
        role: sessionAccessProjectionRoleFromLevelV1(access.level),
        level: access.level,
        capabilities: access.capabilities,
        sources: access.sources,
        ...(access.audienceContext !== undefined ? { audienceContext: access.audienceContext } : {}),
        ...(access.primaryTeamId !== undefined ? { primaryTeamId: access.primaryTeamId } : {}),
    };
}

const LEGACY_ACCESS_LEVELS = ['view', 'edit', 'admin'] as const;

/**
 * Current rows carry `access`; the flat accessLevel is retained only for
 * released pre-projection payloads. Consumers use this helper so the legacy
 * refinement cannot become a competing authority for current records.
 */
export function isSessionAccessRecipient(
    access: NormalizedSessionAccessProjection | null | undefined,
    legacyAccessLevel: unknown,
): boolean {
    if (access !== undefined) return access?.role === 'recipient';
    return LEGACY_ACCESS_LEVELS.includes(legacyAccessLevel as typeof LEGACY_ACCESS_LEVELS[number]);
}

export function isSessionAccessOwner(
    access: NormalizedSessionAccessProjection | null | undefined,
    legacyAccessLevel: unknown,
): boolean {
    if (access !== undefined) return access?.role === 'owner';
    return legacyAccessLevel == null;
}

type SessionAccessInput = Readonly<{
    effectiveAccess?: unknown;
    share?: unknown;
    metadataLayoutVersion?: unknown;
}>;

type SessionAccessReadOptions = Readonly<{ allowLegacy?: boolean }>;

/** The only UI translation of released owner/direct authority into current capabilities. */
export function normalizeSessionAccessProjection(
    row: SessionAccessInput,
    options: SessionAccessReadOptions = {},
): NormalizedSessionAccessProjection | null {
    if (row.effectiveAccess !== undefined) {
        const parsed = SessionEffectiveAccessV1Schema.safeParse(row.effectiveAccess);
        return parsed.success ? projectAdmittedSessionAccess(parsed.data) : null;
    }
    const role = readSessionAccessProjectionRoleV1(row);
    if (role === 'unavailable') return null;
    if (options.allowLegacy !== true) return null;
    // Released layout zero omitted share for owners; layout one requires explicit null.
    if (role === 'owner') {
        return {
            role: 'owner', level: 'owner',
            capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'owner', canApprovePermissions: true }),
        };
    }
    const share = SessionShareSchema.safeParse(row.share);
    if (!share.success) return null;
    return {
        role: 'recipient', level: share.data.accessLevel,
        capabilities: projectLegacySessionAccessCapabilitiesV1({ level: share.data.accessLevel, canApprovePermissions: share.data.canApprovePermissions }),
    };
}

export function readSessionAccessRole(
    row: SessionAccessInput,
    options: SessionAccessReadOptions = {},
): 'owner' | 'recipient' | 'unavailable' {
    return normalizeSessionAccessProjection(row, options)?.role ?? 'unavailable';
}
