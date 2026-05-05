import { configuration } from '@/configuration';
import { resolveBackgroundServiceRepairPlanForCurrentRuntime } from '@/diagnostics/backgroundServiceRepair/resolveBackgroundServiceRepairPlanForCurrentRuntime';
import { resolveDaemonServiceCliRuntimeFromEnv } from '@/daemon/service/cli';

import { getReleaseRingCatalogEntry } from '@happier-dev/release-runtime/releaseRings';
import type { DoctorSnapshot } from '@happier-dev/protocol';

type DoctorWarning = NonNullable<DoctorSnapshot['warnings']>[number];

function buildRepairRecommendedWarning(actionCount: number): DoctorWarning {
  return {
    code: 'backgroundServiceRepairRecommended',
    severity: 'warning',
    message: actionCount === 1
      ? 'Automatic startup repair is recommended for this installation.'
      : `Automatic startup repair is recommended (${actionCount} actions).`,
    repairCommands: ['happier doctor repair --yes'],
  };
}

function buildManualRepairWarning(message: string): DoctorWarning {
  return {
    code: 'backgroundServiceRepairManual',
    severity: 'warning',
    message,
    repairCommands: ['happier doctor repair'],
  };
}

function buildRunningDaemonMismatchWarning(params: Readonly<{
  daemonStatus: NonNullable<DoctorSnapshot['daemonStatus']>;
}>): DoctorWarning | null {
  const daemon = params.daemonStatus.daemon;
  if (!daemon.running) {
    return null;
  }

  const currentVersion = String(configuration.currentCliVersion ?? '').trim();
  const currentRing = getReleaseRingCatalogEntry(configuration.publicReleaseRing).publicLabel;
  const versionMismatch = Boolean(currentVersion && daemon.startedWithCliVersion && daemon.startedWithCliVersion !== currentVersion);
  const ringMismatch = Boolean(currentRing && daemon.startedWithPublicReleaseChannel && daemon.startedWithPublicReleaseChannel !== currentRing);
  if (!versionMismatch && !ringMismatch) {
    return null;
  }

  const repairCommands = daemon.serviceManaged === true
    ? ['happier doctor repair']
    : daemon.serviceManaged === false
      ? ['happier daemon restart']
      : [];

  return {
    code: 'runningDaemonMismatch',
    severity: 'warning',
    message: 'The currently running daemon is not using this CLI installation.',
    repairCommands,
  };
}

export async function readDoctorWarnings(params: Readonly<{
  daemonStatus?: DoctorSnapshot['daemonStatus'];
}>): Promise<readonly DoctorWarning[]> {
  const runtime = resolveDaemonServiceCliRuntimeFromEnv({
    mode: 'user',
  });
  const repairState = await resolveBackgroundServiceRepairPlanForCurrentRuntime({
    preferredMode: 'user',
    includeAllModes: runtime.platform === 'linux',
    systemUser: '',
  });

  const warnings: DoctorWarning[] = [];
  if (repairState.plan.actions.length > 0) {
    warnings.push(buildRepairRecommendedWarning(repairState.plan.actions.length));
  }
  for (const manualWarning of repairState.plan.manualWarnings) {
    warnings.push(buildManualRepairWarning(manualWarning));
  }
  if (params.daemonStatus) {
    const mismatchWarning = buildRunningDaemonMismatchWarning({
      daemonStatus: params.daemonStatus,
    });
    if (mismatchWarning) {
      warnings.push(mismatchWarning);
    }
  }

  return warnings;
}
