import { compareVersions, normalizeSemverBase } from '@happier-dev/cli-common/update';

import { resolveBackgroundServiceRepairPlanForCurrentRuntime } from '@/diagnostics/backgroundServiceRepair/resolveBackgroundServiceRepairPlanForCurrentRuntime';
import type { DaemonServiceMode } from '@/daemon/service/plan';
import { isInteractiveTerminal } from '@/terminal/prompts/promptInput';

import { handleServiceRepairCliCommand } from '../serviceRepair/handleServiceRepairCliCommand';
import { resolveBackgroundServiceRepairSystemUser } from '../serviceRepair/repairSystemUser';

function normalizeVersionId(value: string | null | undefined): string | null {
  const normalized = String(value ?? '').trim().replace(/^v/i, '');
  return normalized || null;
}

function normalizeVersionBase(value: string | null | undefined): string | null {
  const normalized = normalizeVersionId(value);
  if (!normalized) return null;
  return normalizeSemverBase(normalized) ?? normalized;
}

export function hasCrossedBackgroundServiceMigrationBoundary(params: Readonly<{
  fromVersion: string | null | undefined;
  toVersion: string | null | undefined;
  hadLegacyCurrentInstallWithoutVersionMarkers?: boolean;
}>): boolean {
  const fromVersion = normalizeVersionBase(params.fromVersion);
  const toVersion = normalizeVersionBase(params.toVersion);
  if (!toVersion) {
    return false;
  }
  if (!fromVersion) {
    return params.hadLegacyCurrentInstallWithoutVersionMarkers === true
      && compareVersions(toVersion, '0.2.3') >= 0;
  }
  return compareVersions(fromVersion, '0.2.3') < 0 && compareVersions(toVersion, '0.2.3') >= 0;
}

function resolveAutomaticMigrationPreferredMode(params: Readonly<{
  platform: 'darwin' | 'linux' | 'win32';
  uid: number | null;
  currentReleaseChannel: string;
  currentServerId: string;
  services: readonly Readonly<{ serverId: string; mode?: DaemonServiceMode; targetMode: string; releaseChannel: string }>[];
}>): DaemonServiceMode {
  const compatibleDefaultModes = new Set<DaemonServiceMode>();
  for (const service of params.services) {
    if (service.targetMode !== 'default-following' && service.targetMode !== 'pinned') continue;
    if (service.targetMode === 'pinned' && service.serverId !== params.currentServerId) continue;
    compatibleDefaultModes.add(service.mode === 'system' ? 'system' : 'user');
  }

  if (compatibleDefaultModes.size === 1) {
    return [...compatibleDefaultModes][0];
  }
  if (params.platform === 'linux' && params.uid === 0 && compatibleDefaultModes.has('system')) {
    return 'system';
  }
  return 'user';
}

function buildAutomaticMigrationArgv(params: Readonly<{
  baseArgv: readonly string[];
  preferredMode: DaemonServiceMode;
  systemUser?: string;
  interactive: boolean;
}>): string[] {
  const argv = [...params.baseArgv];
  if (!argv.includes('--migrate')) {
    argv.push('--migrate');
  }
  // In a TTY, drop --yes so the user walks the guided flow with migration-scope
  // auto-apply on safe findings (dedupe / stale / legacy-channel-scoped) while
  // still getting prompted for material choices (legacy-pinned → default,
  // channel switches). Without a TTY (install-payload promotion,
  // non-interactive self-update) keep --yes so headless convergence succeeds.
  if (!params.interactive && !argv.includes('--yes')) {
    argv.push('--yes');
  }
  const modeFlagIndex = argv.findIndex((arg) => arg === '--mode' || arg.startsWith('--mode='));
  if (modeFlagIndex >= 0) {
    if (argv[modeFlagIndex] === '--mode') {
      argv.splice(modeFlagIndex, 2, '--mode', params.preferredMode);
    } else {
      argv.splice(modeFlagIndex, 1, `--mode=${params.preferredMode}`);
    }
  } else {
    argv.push('--mode', params.preferredMode);
  }
  if (params.preferredMode !== 'system' || !params.systemUser) {
    return argv;
  }
  const systemUserFlagIndex = argv.findIndex((arg) => arg === '--system-user' || arg.startsWith('--system-user='));
  if (systemUserFlagIndex >= 0) {
    if (argv[systemUserFlagIndex] === '--system-user') {
      argv.splice(systemUserFlagIndex, 2, '--system-user', params.systemUser);
    } else {
      argv.splice(systemUserFlagIndex, 1, `--system-user=${params.systemUser}`);
    }
    return argv;
  }
  argv.push('--system-user', params.systemUser);
  return argv;
}

export async function maybeRunVersionGatedRuntimeMigration(params: Readonly<{
  fromVersion: string | null | undefined;
  toVersion: string | null | undefined;
  hadLegacyCurrentInstallWithoutVersionMarkers?: boolean;
  argv: readonly string[];
  commandPath: string;
  /**
   * `true` when the caller is an unattended process (install-payload promotion
   * spawned by installer scripts) and the migration must run headlessly.
   * Defaults to auto-detection via `isInteractiveTerminal()`.
   */
  forceNonInteractive?: boolean;
}>): Promise<boolean> {
  if (!hasCrossedBackgroundServiceMigrationBoundary(params)) {
    return false;
  }

  let repairState = await resolveBackgroundServiceRepairPlanForCurrentRuntime({
    preferredMode: 'user',
    includeAllModes: true,
    systemUser: '',
  });
  const preferredMode = resolveAutomaticMigrationPreferredMode({
    platform: repairState.runtime.platform,
    uid: repairState.runtime.uid,
    currentReleaseChannel: repairState.runtime.channel,
    currentServerId: repairState.runtime.instanceId,
    services: repairState.services,
  });
  const systemUser = resolveBackgroundServiceRepairSystemUser({
    preferredMode,
  });
  if (preferredMode !== 'user') {
      if (!systemUser) {
      console.warn('Skipping automatic system background service migration because no system user could be resolved. Re-run manually with: sudo happier doctor repair --yes --mode system --system-user <user>');
      return false;
    }
    repairState = await resolveBackgroundServiceRepairPlanForCurrentRuntime({
      preferredMode,
      includeAllModes: true,
      systemUser,
    });
  }
  const { runtime, plan } = repairState;

  if (plan.actions.length === 0 && plan.manualWarnings.length === 0) {
    return false;
  }

  const requiresRootForPlan = runtime.platform === 'linux'
    && runtime.uid !== 0
    && plan.actions.some((action) => action.kind === 'remove-service'
      ? action.service.mode === 'system'
      : action.mode === 'system');
  if (requiresRootForPlan) {
    console.warn('Skipping automatic system background service migration without root privileges. Re-run manually with: sudo happier doctor repair --yes --mode system');
    return false;
  }

  const interactive = params.forceNonInteractive === true
    ? false
    : isInteractiveTerminal();

  // HAPPIER_INSTALLER_MIGRATION tells the repair handler it was invoked from
  // the 0.2.3 migration hook; the handler broadens `autoApplyWithoutPrompt` so
  // lane-switches and legacy-pinned-converge-to-default-following run without
  // prompting during the migration. In interactive mode we pass the explicit
  // `--migrate` flag instead so the banner is printed and the guided flow
  // still prompts for material choices (the flag takes precedence over the env
  // var, and the env var is only needed for older CLI binaries that don't yet
  // parse the flag — we keep setting it in non-interactive mode for that
  // backwards-compat case).
  const previousMigrationEnv = process.env.HAPPIER_INSTALLER_MIGRATION;
  if (!interactive) {
    process.env.HAPPIER_INSTALLER_MIGRATION = '1';
  }
  try {
    await handleServiceRepairCliCommand({
      argv: buildAutomaticMigrationArgv({
        baseArgv: params.argv,
        preferredMode,
        systemUser,
        interactive,
      }),
      commandPath: params.commandPath,
    });
  } finally {
    if (previousMigrationEnv === undefined) {
      delete process.env.HAPPIER_INSTALLER_MIGRATION;
    } else {
      process.env.HAPPIER_INSTALLER_MIGRATION = previousMigrationEnv;
    }
  }
  return true;
}
