import type { BackgroundServiceRepairPlan } from '@/diagnostics/backgroundServiceRepair/types';
import type { DaemonServiceMode } from '@/daemon/service/plan';

function normalizeSystemUser(value: string | null | undefined): string {
  return String(value ?? '').trim();
}

export function resolveBackgroundServiceRepairSystemUser(params: Readonly<{
  preferredMode: DaemonServiceMode;
  systemUser?: string | null;
  processEnv?: NodeJS.ProcessEnv;
}>): string {
  const processEnv = params.processEnv ?? process.env;
  const explicitSystemUser =
    normalizeSystemUser(params.systemUser)
    || normalizeSystemUser(processEnv.HAPPIER_DAEMON_SERVICE_SYSTEM_USER);

  if (explicitSystemUser) {
    return explicitSystemUser;
  }

  if (params.preferredMode !== 'system') {
    return '';
  }

  return normalizeSystemUser(processEnv.SUDO_USER);
}

export function repairPlanNeedsSystemUser(plan: BackgroundServiceRepairPlan): boolean {
  return plan.actions.some((action) => action.kind === 'remove-service'
    ? action.service.mode === 'system'
    : action.mode === 'system');
}

export function assertRepairPlanSystemUserAvailable(params: Readonly<{
  plan: BackgroundServiceRepairPlan;
  systemUser: string;
}>): void {
  if (!repairPlanNeedsSystemUser(params.plan)) {
    return;
  }
  if (normalizeSystemUser(params.systemUser)) {
    return;
  }
  throw new Error(
    'System mode automatic startup repair requires --system-user (or SUDO_USER / HAPPIER_DAEMON_SERVICE_SYSTEM_USER)',
  );
}
