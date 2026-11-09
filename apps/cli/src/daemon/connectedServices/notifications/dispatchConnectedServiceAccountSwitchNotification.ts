import type {
  AccountSettings,
} from '@happier-dev/protocol';

import { dispatchActivityNotificationAsync } from '@/notifications/activity/dispatchActivityNotification';
import type { ExpoPushActivityNotificationSender } from '@/notifications/activity/sendExpoPushActivityNotification';
import type { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import { isBackgroundConnectedServiceSwitchReason } from '../connectedServiceSwitchEventVisibility';
import {
  loadConnectedServiceNotificationProfilesById,
  resolveConnectedServiceNotificationDisplayName,
  resolveConnectedServiceNotificationProfileLabel,
  type ConnectedServiceNotificationProfileSummary,
  type ConnectedServiceNotificationAccountReader,
} from './connectedServiceNotificationLabels';

type ConnectedServiceAccountSwitchNotificationSource = Readonly<{
  sessionId: string;
  sessionTitle?: string | null;
  serviceId: string;
  groupId: string;
  fromProfileId: string | null;
  toProfileId: string | null;
  reason: string;
  limitCategory?: string | null;
  retryAfterMs?: number | null;
  quotaScope?: string | null;
  providerLimitId?: string | null;
  action?: Readonly<{ kind: 'open_url'; url: string }> | null;
}>;

function clampUsagePercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function resolveUsagePercent(input: Readonly<{
  runtimeQuotaSnapshots: ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore;
  serviceId: string;
  groupId: string;
  profileId: string | null;
}>): number | null {
  if (!input.profileId) return null;
  const snapshot = input.runtimeQuotaSnapshots.getSnapshot({
    serviceId: input.serviceId,
    groupId: input.groupId,
    profileId: input.profileId,
  });
  if (!snapshot) return null;
  const utilizationValues = snapshot.meters
    .map((meter) => meter.utilizationPct)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (utilizationValues.length > 0) {
    return clampUsagePercent(Math.max(...utilizationValues));
  }
  const remainingValues = snapshot.meters
    .map((meter) => meter.remainingPct)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (remainingValues.length === 0) return null;
  return clampUsagePercent(100 - Math.min(...remainingValues));
}

export async function dispatchConnectedServiceAccountSwitchNotificationAsync(params: Readonly<{
  settings: AccountSettings | null | undefined;
  settingsSecretsReadKeys?: ReadonlyArray<Uint8Array | null | undefined>;
  expoPushSender?: ExpoPushActivityNotificationSender | null;
  runtimeQuotaSnapshots: ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore;
  listQualifiedConnectedAccounts: ConnectedServiceNotificationAccountReader;
  profilesById?: ReadonlyMap<string, ConnectedServiceNotificationProfileSummary>;
  source: ConnectedServiceAccountSwitchNotificationSource;
  nowMs?: () => number;
  dedupeWindowMs?: number;
}>): Promise<void> {
  if (isBackgroundConnectedServiceSwitchReason(params.source.reason)) return;
  // Manual switches were performed by the user — a push about their own action is noise.
  // The transcript event still commits (the visibility policy above owns full silence).
  if (params.source.reason === 'manual') return;

  const serviceDisplayName = resolveConnectedServiceNotificationDisplayName(params.source.serviceId);
  const profilesById = params.profilesById ?? await loadConnectedServiceNotificationProfilesById({
    serviceId: params.source.serviceId,
    profileIds: [params.source.fromProfileId, params.source.toProfileId],
    listQualifiedConnectedAccounts: params.listQualifiedConnectedAccounts,
  });
  await dispatchActivityNotificationAsync({
    settings: params.settings,
    settingsSecretsReadKeys: params.settingsSecretsReadKeys,
    expoPushSender: params.expoPushSender,
    event: {
      topic: 'connected_service_account_switch',
      sessionId: params.source.sessionId,
      sessionTitle: params.source.sessionTitle ?? null,
      serviceId: params.source.serviceId,
      serviceDisplayName,
      groupId: params.source.groupId,
      fromProfileId: params.source.fromProfileId,
      toProfileId: params.source.toProfileId,
      fromProfileLabel: resolveConnectedServiceNotificationProfileLabel(profilesById, params.source.fromProfileId, serviceDisplayName ?? 'Provider'),
      toProfileLabel: resolveConnectedServiceNotificationProfileLabel(profilesById, params.source.toProfileId, serviceDisplayName ?? 'Provider'),
      fromUsagePercent: resolveUsagePercent({
        runtimeQuotaSnapshots: params.runtimeQuotaSnapshots,
        serviceId: params.source.serviceId,
        groupId: params.source.groupId,
        profileId: params.source.fromProfileId,
      }),
      toUsagePercent: resolveUsagePercent({
        runtimeQuotaSnapshots: params.runtimeQuotaSnapshots,
        serviceId: params.source.serviceId,
        groupId: params.source.groupId,
        profileId: params.source.toProfileId,
      }),
      reason: params.source.reason,
      limitCategory: params.source.limitCategory ?? null,
      retryAfterMs: params.source.retryAfterMs ?? null,
      quotaScope: params.source.quotaScope ?? null,
      providerLimitId: params.source.providerLimitId ?? null,
      action: params.source.action ?? null,
    },
    nowMs: params.nowMs,
    dedupeWindowMs: params.dedupeWindowMs,
  });
}
