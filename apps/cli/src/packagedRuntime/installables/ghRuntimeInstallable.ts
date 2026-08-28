import { compareVersions } from '@happier-dev/cli-common/update';
import { GH_DEP_ID, INSTALLABLE_KEYS } from '@happier-dev/protocol/installables';

import { getGhDepStatus } from '@/capabilities/deps/gh';
import { logger } from '@/ui/logger';

import type { RuntimeInstallableAdapter, RuntimeInstallableLaunchResolution } from './registry';

export async function detectGhLaunchResolution(): Promise<RuntimeInstallableLaunchResolution> {
  const status = await getGhDepStatus();
  return {
    availability: status.installed && status.authenticated
      ? { ok: true }
      : {
        ok: false,
        errorMessage: status.installed
          ? 'gh is installed but not authenticated for github.com'
          : 'gh is not installed',
      },
    canAutoInstall: !status.installed,
    canBackgroundAutoUpdate: status.resolvedSource === 'managed' && status.installed === true,
  };
}

/**
 * Background-update *check* only.
 *
 * The dep.gh descriptor declares `consent.update: 'required'` and
 * `defaultPolicy.autoUpdateMode: 'notify'`. Per FD-0054 / SCM-INSTALLABLES-2 §8.5,
 * the background path may surface that an upgrade is available, but it must NOT
 * unilaterally invoke the install/upgrade action without explicit user consent.
 *
 * Auto-install is only valid when the active policy resolves to
 * `autoUpdateMode: 'auto'`, which `ensureForLaunch` enforces at its own gate
 * (`startBackgroundRuntimeInstallableUpdate`). We do not gate from here.
 */
export async function runGhBackgroundAutoUpdateCheck(): Promise<void> {
  const status = await getGhDepStatus({ includeLatestVersion: true, onlyIfInstalled: true });
  if (status.resolvedSource !== 'managed') return;

  const installedVersion = status.installedVersion;
  const latestVersion = status.latestVersionCheck?.ok ? status.latestVersionCheck.latestVersion : null;
  if (!installedVersion || !latestVersion) return;
  if (compareVersions(latestVersion, installedVersion) <= 0) return;

  // Notify-only: log the available upgrade so the daemon/UI can surface a prompt
  // (or the user can run `happier install gh` explicitly). Do not invoke the
  // shared installer here — that would bypass `consent.update: 'required'`.
  logger.info(
    `[gh] managed install ${installedVersion} has an upgrade available to ${latestVersion}; awaiting explicit consent (descriptor consent.update=required).`,
  );
}

export function createGhRuntimeInstallableAdapter(
  hostAdapter: RuntimeInstallableAdapter,
): RuntimeInstallableAdapter {
  return {
    ...hostAdapter,
    key: INSTALLABLE_KEYS.GH,
    capabilityId: GH_DEP_ID,
    detectCapabilityStatus: getGhDepStatus,
    detectLaunchResolution: detectGhLaunchResolution,
    installOrUpgrade: hostAdapter.installOrUpgrade,
    runBackgroundAutoUpdateCheck: runGhBackgroundAutoUpdateCheck,
  };
}
