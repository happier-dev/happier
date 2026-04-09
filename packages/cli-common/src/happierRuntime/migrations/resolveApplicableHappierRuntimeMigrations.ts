import { compareVersions } from '../../update/index.js';

import {
    HAPPIER_RUNTIME_MIGRATION_CATALOG,
    type HappierRuntimeMigrationEntry,
} from './catalog.js';

function normalizeVersionId(value: string | null | undefined): string | null {
    const normalized = String(value ?? '').trim().replace(/^v/i, '');
    return normalized || null;
}

function hasCrossedMigrationBoundary(params: Readonly<{
    fromVersion: string | null;
    toVersion: string | null;
    boundaryVersion: string;
}>): boolean {
    if (!params.fromVersion || !params.toVersion) {
        return false;
    }

    return compareVersions(params.fromVersion, params.boundaryVersion) < 0
        && compareVersions(params.toVersion, params.boundaryVersion) >= 0;
}

export function resolveApplicableHappierRuntimeMigrations(params: Readonly<{
    fromVersion: string | null | undefined;
    toVersion: string | null | undefined;
}>): HappierRuntimeMigrationEntry[] {
    const fromVersion = normalizeVersionId(params.fromVersion);
    const toVersion = normalizeVersionId(params.toVersion);

    return HAPPIER_RUNTIME_MIGRATION_CATALOG.filter((entry) => hasCrossedMigrationBoundary({
        fromVersion,
        toVersion,
        boundaryVersion: entry.boundaryVersion,
    }));
}

export function hasApplicableHappierRuntimeMigrations(params: Readonly<{
    fromVersion: string | null | undefined;
    toVersion: string | null | undefined;
}>): boolean {
    return resolveApplicableHappierRuntimeMigrations(params).length > 0;
}
