import type {
  AccountSettings,
  ConnectedServiceId,
} from '@happier-dev/protocol';

import { dispatchActivityNotificationAsync } from '@/notifications/activity/dispatchActivityNotification';
import type { ExpoPushActivityNotificationSender } from '@/notifications/activity/sendExpoPushActivityNotification';
import {
  loadConnectedServiceNotificationProfilesById,
  resolveConnectedServiceNotificationProfileLabel,
  type ConnectedServiceNotificationProfileSummary,
} from './connectedServiceNotificationLabels';

export type ConnectedServiceCredentialHealthNotificationSource = Readonly<{
  sessionId: string;
  sessionTitle?: string | null;
  serviceId: ConnectedServiceId;
  profileId: string;
  status: 'reconnect_required' | 'refresh_failed_retryable';
  reason?: string | null;
  providerStatus?: number | null;
  providerErrorCode?: string | null;
  action?: Readonly<{ kind: 'open_url'; url: string }> | null;
}>;

export async function dispatchConnectedServiceCredentialHealthNotificationAsync(params: Readonly<{
  settings: AccountSettings | null | undefined;
  settingsSecretsReadKeys?: ReadonlyArray<Uint8Array | null | undefined>;
  expoPushSender?: ExpoPushActivityNotificationSender | null;
  listConnectedServiceProfiles(input: Readonly<{ serviceId: ConnectedServiceId }>): Promise<Readonly<{
    serviceId: ConnectedServiceId;
    profiles: ReadonlyArray<ConnectedServiceNotificationProfileSummary>;
  }>>;
  source: ConnectedServiceCredentialHealthNotificationSource;
  nowMs?: () => number;
  dedupeWindowMs?: number;
}>): Promise<void> {
  const profilesById = await loadConnectedServiceNotificationProfilesById({
    serviceId: params.source.serviceId,
    listConnectedServiceProfiles: params.listConnectedServiceProfiles,
  });
  await dispatchActivityNotificationAsync({
    settings: params.settings,
    settingsSecretsReadKeys: params.settingsSecretsReadKeys,
    expoPushSender: params.expoPushSender,
    event: {
      topic: 'connected_service_credential_health',
      sessionId: params.source.sessionId,
      sessionTitle: params.source.sessionTitle ?? null,
      serviceId: params.source.serviceId,
      profileId: params.source.profileId,
      profileLabel: resolveConnectedServiceNotificationProfileLabel(profilesById, params.source.profileId),
      status: params.source.status,
      reason: params.source.reason ?? null,
      providerStatus: params.source.providerStatus ?? null,
      providerErrorCode: params.source.providerErrorCode ?? null,
      action: params.source.action ?? null,
    },
    nowMs: params.nowMs,
    dedupeWindowMs: params.dedupeWindowMs,
  });
}
