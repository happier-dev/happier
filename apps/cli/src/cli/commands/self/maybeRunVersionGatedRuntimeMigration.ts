import { compareVersions } from '@happier-dev/cli-common/update';

import { buildHappierRuntimeRepairPlan } from '@/diagnostics/happierRuntimeRepair';
import { buildDoctorSnapshot } from '@/ui/doctorSnapshot';

import { handleServiceRepairCliCommand } from '../serviceRepair/handleServiceRepairCliCommand';

const BACKGROUND_SERVICE_MIGRATION_BOUNDARY_VERSION = '0.2.3';

function normalizeVersionId(value: string | null | undefined): string | null {
    const normalized = String(value ?? '').trim().replace(/^v/i, '');
    return normalized || null;
}

export function hasCrossedBackgroundServiceMigrationBoundary(params: Readonly<{
    fromVersion: string | null | undefined;
    toVersion: string | null | undefined;
}>): boolean {
    const fromVersion = normalizeVersionId(params.fromVersion);
    const toVersion = normalizeVersionId(params.toVersion);
    if (!fromVersion || !toVersion) {
        return false;
    }

    return compareVersions(fromVersion, BACKGROUND_SERVICE_MIGRATION_BOUNDARY_VERSION) < 0
        && compareVersions(toVersion, BACKGROUND_SERVICE_MIGRATION_BOUNDARY_VERSION) >= 0;
}

export async function maybeRunVersionGatedRuntimeMigration(params: Readonly<{
    fromVersion: string | null | undefined;
    toVersion: string | null | undefined;
    argv: readonly string[];
    commandPath: string;
}>): Promise<boolean> {
    if (!hasCrossedBackgroundServiceMigrationBoundary(params)) {
        return false;
    }

    const snapshot = await buildDoctorSnapshot();
    const plan = buildHappierRuntimeRepairPlan(snapshot);
    if (plan.actions.length === 0 && plan.manualWarnings.length === 0) {
        return false;
    }

    await handleServiceRepairCliCommand({
        argv: [...params.argv],
        commandPath: params.commandPath,
    });
    return true;
}
