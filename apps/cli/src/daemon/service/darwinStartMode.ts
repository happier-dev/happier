import type { DaemonOwnerEvaluation } from '@/daemon/ownership/evaluateCurrentDaemonOwner';
import { isRunningDaemonOwnedByService } from './resolveDaemonServiceLifecycleAction';
import { readBackgroundServiceActivity } from './readBackgroundServiceHealth';

/** A daemon's service marker alone does not establish that launchd still has its job. */
export function resolveDarwinServiceStartMode(params: Readonly<{
  platform: NodeJS.Platform;
  uid: number | null;
  label: string;
  ownership: DaemonOwnerEvaluation;
  deadlineMs?: number;
}>): 'rebootstrap' | 'kickstart' {
  return params.platform === 'darwin'
    && isRunningDaemonOwnedByService({ ownership: params.ownership, expectedServiceLabel: params.label })
    && readBackgroundServiceActivity(params) === 'active'
    ? 'kickstart'
    : 'rebootstrap';
}
