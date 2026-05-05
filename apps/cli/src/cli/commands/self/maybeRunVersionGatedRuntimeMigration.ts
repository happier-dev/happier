import { resolveApplicableHappierRuntimeMigrations } from '@happier-dev/cli-common/happierRuntime';

import { resolveBackgroundServiceRepairPlanForCurrentRuntime } from '@/diagnostics/backgroundServiceRepair/resolveBackgroundServiceRepairPlanForCurrentRuntime';
import { isInteractiveTerminal } from '@/terminal/prompts/promptInput';

import { handleServiceRepairCliCommand } from '../service/repair/handleServiceRepairCliCommand';

function normalizeVersionId(value: string | null | undefined): string | null {
  const normalized = String(value ?? '').trim().replace(/^v/i, '');
  return normalized || null;
}

export function hasCrossedBackgroundServiceMigrationBoundary(params: Readonly<{
  fromVersion: string | null | undefined;
  toVersion: string | null | undefined;
  hadLegacyCurrentInstallWithoutVersionMarkers?: boolean;
}>): boolean {
  return resolveApplicableHappierRuntimeMigrations({
    fromVersion: normalizeVersionId(params.fromVersion),
    toVersion: normalizeVersionId(params.toVersion),
    hadLegacyCurrentInstallWithoutVersionMarkers: params.hadLegacyCurrentInstallWithoutVersionMarkers,
  }).length > 0;
}

export async function maybeRunVersionGatedRuntimeMigration(params: Readonly<{
  fromVersion: string | null | undefined;
  toVersion: string | null | undefined;
  hadLegacyCurrentInstallWithoutVersionMarkers?: boolean;
  argv: readonly string[];
  commandPath: string;
  installedRuntimeNodePath?: string | null;
  forceNonInteractive?: boolean;
}>): Promise<boolean> {
  const migrations = resolveApplicableHappierRuntimeMigrations({
    fromVersion: params.fromVersion,
    toVersion: params.toVersion,
    hadLegacyCurrentInstallWithoutVersionMarkers: params.hadLegacyCurrentInstallWithoutVersionMarkers,
  });
  if (migrations.length === 0) {
    return false;
  }

  const installedRuntimeNodePath = String(params.installedRuntimeNodePath ?? '').trim();

  const runWithInstalledRuntimeContext = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (!installedRuntimeNodePath) {
      return await fn();
    }

    const previousNodePath = process.env.HAPPIER_DAEMON_SERVICE_NODE_PATH;
    process.env.HAPPIER_DAEMON_SERVICE_NODE_PATH = installedRuntimeNodePath;
    try {
      return await fn();
    } finally {
      if (previousNodePath === undefined) {
        delete process.env.HAPPIER_DAEMON_SERVICE_NODE_PATH;
      } else {
        process.env.HAPPIER_DAEMON_SERVICE_NODE_PATH = previousNodePath;
      }
    }
  };

  const { runtime, plan } = await runWithInstalledRuntimeContext(async () => {
    return await resolveBackgroundServiceRepairPlanForCurrentRuntime({
      preferredMode: 'user',
      includeAllModes: true,
      systemUser: '',
    });
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

  const shouldAutoConsent = params.forceNonInteractive === true || !isInteractiveTerminal();
  const repairArgv = [
    ...params.argv,
    ...(params.argv.includes('--migrate') ? [] : ['--migrate']),
    ...(shouldAutoConsent && !params.argv.includes('--yes') ? ['--yes'] : []),
  ];
  const previousInstallerMigration = process.env.HAPPIER_INSTALLER_MIGRATION;
  await runWithInstalledRuntimeContext(async () => {
    process.env.HAPPIER_INSTALLER_MIGRATION = '1';
    try {
      await handleServiceRepairCliCommand({
        argv: repairArgv,
        commandPath: params.commandPath,
      });
    } finally {
      if (previousInstallerMigration === undefined) {
        delete process.env.HAPPIER_INSTALLER_MIGRATION;
      } else {
        process.env.HAPPIER_INSTALLER_MIGRATION = previousInstallerMigration;
      }
    }
  });
  return true;
}
