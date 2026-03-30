import type { PermissionMode } from '@/sync/domains/permissions/permissionTypes';

type TimedPermissionMode = Readonly<{
    mode: PermissionMode;
    updatedAt: number | null;
}>;

type TimedPermissionCandidate = Readonly<{
    mode: PermissionMode | null | undefined;
    updatedAt: number | null | undefined;
}>;

function normalizeUpdatedAt(updatedAt: number | null | undefined): number | null {
    return typeof updatedAt === 'number' && Number.isFinite(updatedAt) ? updatedAt : null;
}

export function pickNewerSessionPermissionMode(
    current: TimedPermissionMode,
    candidate: TimedPermissionCandidate,
): TimedPermissionMode {
    if (!candidate.mode) {
        return current;
    }

    const candidateUpdatedAt = normalizeUpdatedAt(candidate.updatedAt);
    if (candidateUpdatedAt === null) {
        return current;
    }

    const currentUpdatedAt = normalizeUpdatedAt(current.updatedAt) ?? -Infinity;
    if (candidateUpdatedAt <= currentUpdatedAt) {
        return current;
    }

    return {
        mode: candidate.mode,
        updatedAt: candidateUpdatedAt,
    };
}

export function resolveMergedSessionPermissionMode(params: Readonly<{
    baseMode: PermissionMode;
    baseUpdatedAt: number | null | undefined;
    candidates: readonly TimedPermissionCandidate[];
}>): TimedPermissionMode {
    let merged: TimedPermissionMode = {
        mode: params.baseMode,
        updatedAt: normalizeUpdatedAt(params.baseUpdatedAt),
    };

    for (const candidate of params.candidates) {
        merged = pickNewerSessionPermissionMode(merged, candidate);
    }

    return merged;
}
