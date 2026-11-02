import { t } from '@/text';
import { joinList } from '@/utils/text/joinList';

const EXCLUSION_KEYS: Readonly<Record<string, Parameters<typeof t>[0]>> = {
  quota_exhausted: 'usage.board.plans.excludedUsedUp',
  cooldown: 'usage.board.plans.excludedCooldown',
  auth_invalid: 'usage.board.plans.excludedSignIn',
  credential_unavailable: 'usage.board.plans.excludedUnavailable',
  disabled: 'usage.board.plans.excludedOff',
  capacity_limited: 'usage.board.plans.excludedCapacity',
  plan_unavailable: 'usage.board.plans.excludedUnavailable',
  validation_blocked: 'usage.board.plans.excludedUnavailable',
  policy_wait_until_reset: 'usage.board.plans.excludedWaitReset',
  current_active: 'usage.board.plans.usedFirstInUse',
};


/** The pool selection owner's closed reasons, shared by usage and start recovery. */
export function connectedServicePoolExclusionText(reason: string): string {
  return t(EXCLUSION_KEYS[reason] ?? 'usage.board.plans.excludedUnavailable');
}

type ExclusionCountKey =
  | 'connectedServicesPool.startUnavailableUsedUp'
  | 'connectedServicesPool.startUnavailableSignIn'
  | 'connectedServicesPool.startUnavailableCoolingDown'
  | 'connectedServicesPool.startUnavailableWaitingReset'
  | 'connectedServicesPool.startUnavailableOff'
  | 'connectedServicesPool.startUnavailableAtCapacity'
  | 'connectedServicesPool.startUnavailableUnusable'
  | 'connectedServicesPool.startUnavailableInUse';

const EXCLUSION_COUNT_KEYS: Readonly<Record<string, ExclusionCountKey>> = {
  quota_exhausted: 'connectedServicesPool.startUnavailableUsedUp',
  cooldown: 'connectedServicesPool.startUnavailableCoolingDown',
  auth_invalid: 'connectedServicesPool.startUnavailableSignIn',
  disabled: 'connectedServicesPool.startUnavailableOff',
  capacity_limited: 'connectedServicesPool.startUnavailableAtCapacity',
  policy_wait_until_reset: 'connectedServicesPool.startUnavailableWaitingReset',
  current_active: 'connectedServicesPool.startUnavailableInUse',
};

/**
 * The same closed reasons counted as one sentence ("2 are used up and 3 need you to sign in again");
 * reasons that read the same are counted together. Empty when nothing was excluded.
 */
export function connectedServicePoolExclusionCountsText(reasons: readonly string[]): string {
  const counts = new Map<ExclusionCountKey, number>();
  for (const reason of reasons) {
    const key = EXCLUSION_COUNT_KEYS[reason] ?? 'connectedServicesPool.startUnavailableUnusable';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts.size === 0 ? '' : joinList(Array.from(counts, ([key, count]) => t(key, { count })));
}
