import { compareVersions } from '@happier-dev/cli-common/update';

import { resolveBackgroundServiceRepairPlanForCurrentRuntime } from '@/diagnostics/backgroundServiceRepair/resolveBackgroundServiceRepairPlanForCurrentRuntime';

import { handleServiceRepairCliCommand } from '../serviceRepair/handleServiceRepairCliCommand';

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
  return compareVersions(fromVersion, '0.2.3') < 0 && compareVersions(toVersion, '0.2.3') >= 0;
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

  const { runtime, plan } = await resolveBackgroundServiceRepairPlanForCurrentRuntime({
    preferredMode: 'user',
    includeAllModes: true,
    systemUser: '',
  });

  if (plan.actions.length === 0 && plan.manualWarnings.length === 0) {
    return false;
  }

  const requiresRootForPlan = runtime.platform === 'linux'
    && runtime.uid !== 0
    && plan.actions.some((action) => action.kind === 'remove-service'
      ? action.service.mode === 'system'
      : action.mode === 'system');
  if (requiresRootForPlan) {
    console.warn('Skipping automatic system background-service migration without root privileges. Re-run manually with: sudo happier self migrate --yes');
    return false;
  }

  await handleServiceRepairCliCommand({
    argv: [...params.argv],
    commandPath: params.commandPath,
  });
  return true;
}
