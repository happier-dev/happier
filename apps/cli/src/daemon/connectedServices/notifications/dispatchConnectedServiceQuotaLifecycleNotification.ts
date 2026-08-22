import type { AccountSettings } from '@happier-dev/protocol';

import { dispatchActivityNotificationAsync } from '@/notifications/activity/dispatchActivityNotification';
import type { ExpoPushActivityNotificationSender } from '@/notifications/activity/sendExpoPushActivityNotification';
import type { ConnectedServiceQuotaLifecycleTransition } from '../quotas/ConnectedServiceQuotasCoordinator';
import { resolveConnectedServiceNotificationDisplayName } from './connectedServiceNotificationLabels';

export async function dispatchConnectedServiceQuotaLifecycleNotificationAsync(params: Readonly<{
  settings: AccountSettings | null | undefined;
  settingsSecretsReadKeys?: ReadonlyArray<Uint8Array | null | undefined>;
  expoPushSender?: ExpoPushActivityNotificationSender | null;
  transition: ConnectedServiceQuotaLifecycleTransition;
  nowMs?: () => number;
  dedupeWindowMs?: number;
}>): Promise<void> {
  const transition = params.transition;
  const topic = transition.phase === 'blocked'
    ? ('connected_service_quota_blocked' as const)
    : ('connected_service_quota_recovered' as const);
  const nowMs = (params.nowMs ?? (() => Date.now()))();
  const retryAfterMs =
    typeof transition.resetAtMs === 'number' && Number.isFinite(transition.resetAtMs) && transition.resetAtMs > nowMs
      ? Math.trunc(transition.resetAtMs - nowMs)
      : null;

  for (const sessionId of transition.sessionIds) {
    await dispatchActivityNotificationAsync({
      settings: params.settings,
      settingsSecretsReadKeys: params.settingsSecretsReadKeys,
      expoPushSender: params.expoPushSender,
      event: {
        topic,
        sessionId,
        serviceId: transition.serviceId,
        serviceDisplayName:
          resolveConnectedServiceNotificationDisplayName(transition.serviceId),
        issueFingerprint: transition.issueFingerprint,
        groupId: transition.groupId,
        profileId: transition.activeProfileId,
        limitCategory: 'usage_limit',
        retryAfterMs,
      },
      nowMs: params.nowMs,
      dedupeWindowMs: params.dedupeWindowMs,
    });
  }
}
