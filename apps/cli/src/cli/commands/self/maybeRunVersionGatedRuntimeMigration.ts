import { hasApplicableHappierRuntimeMigrations } from '@happier-dev/cli-common/happierRuntime';

import { buildHappierRuntimeRepairPlan } from '@/diagnostics/happierRuntimeRepair';
import { buildDoctorSnapshot } from '@/ui/doctorSnapshot';

import { handleServiceRepairCliCommand } from '../serviceRepair/handleServiceRepairCliCommand';

export function hasCrossedBackgroundServiceMigrationBoundary(params: Readonly<{
    fromVersion: string | null | undefined;
    toVersion: string | null | undefined;
}>): boolean {
    return hasApplicableHappierRuntimeMigrations(params);
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
