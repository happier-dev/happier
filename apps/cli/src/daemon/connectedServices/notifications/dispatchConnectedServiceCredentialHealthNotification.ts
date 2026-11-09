import type {
  AccountSettings,
} from '@happier-dev/protocol';

import { dispatchActivityNotificationAsync } from '@/notifications/activity/dispatchActivityNotification';
import type { ActivityNotificationEvent } from '@/notifications/activity/activityNotificationEvent';
import type { ExpoPushActivityNotificationSender } from '@/notifications/activity/sendExpoPushActivityNotification';
import {
  loadConnectedServiceNotificationProfilesById,
  resolveConnectedServiceNotificationDisplayName,
  resolveConnectedServiceNotificationProfileLabel,
  type ConnectedServiceNotificationProfileSummary,
  type ConnectedServiceNotificationAccountReader,
} from './connectedServiceNotificationLabels';

export type ConnectedServiceCredentialHealthNotificationSource = Readonly<{
  sessionId: string;
  sessionTitle?: string | null;
  serviceId: string;
  profileId: string;
  status: 'reconnect_required' | 'refresh_failed_retryable';
  reason?: string | null;
  providerStatus?: number | null;
  providerErrorCode?: string | null;
  action?: Readonly<{ kind: 'open_url'; url: string }> | null;
}>;

export async function dispatchConnectedServiceCredentialHealthNotificationAsync(params: Readonly<{
  settings: AccountSettings | null | undefined;
  signal?: AbortSignal;
  settingsSecretsReadKeys?: ReadonlyArray<Uint8Array | null | undefined>;
  expoPushSender?: ExpoPushActivityNotificationSender | null;
  listQualifiedConnectedAccounts: ConnectedServiceNotificationAccountReader;
  loadProfilesById?: () => Promise<ReadonlyMap<string, ConnectedServiceNotificationProfileSummary>>;
  source: ConnectedServiceCredentialHealthNotificationSource;
  nowMs?: () => number;
  dedupeWindowMs?: number;
}> & Pick<Parameters<typeof dispatchActivityNotificationAsync>[0], 'operationContext' | 'secretSources'>): Promise<void> {
  const serviceDisplayName = resolveConnectedServiceNotificationDisplayName(params.source.serviceId);
  const event: Extract<ActivityNotificationEvent, { topic: 'connected_service_credential_health' }> = {
    topic: 'connected_service_credential_health',
    sessionId: params.source.sessionId,
    sessionTitle: params.source.sessionTitle ?? null,
    serviceId: params.source.serviceId,
    serviceDisplayName,
    profileId: params.source.profileId,
    status: params.source.status,
    reason: params.source.reason ?? null,
    providerStatus: params.source.providerStatus ?? null,
    providerErrorCode: params.source.providerErrorCode ?? null,
    action: params.source.action ?? null,
  };
  await dispatchActivityNotificationAsync({
    signal: params.signal,
    settings: params.settings,
    operationContext: params.operationContext,
    secretSources: params.secretSources,
    settingsSecretsReadKeys: params.settingsSecretsReadKeys,
    expoPushSender: params.expoPushSender,
    event,
    prepareEventContent: async () => {
      const profilesById = await (params.loadProfilesById?.() ?? loadConnectedServiceNotificationProfilesById({
        signal: params.signal,
        serviceId: params.source.serviceId,
        profileIds: [params.source.profileId],
        listQualifiedConnectedAccounts: params.listQualifiedConnectedAccounts,
      }));
      return { ...event, profileLabel: resolveConnectedServiceNotificationProfileLabel(
        profilesById, params.source.profileId, serviceDisplayName ?? 'Provider',
      ) };
    },
    nowMs: params.nowMs,
    dedupeWindowMs: params.dedupeWindowMs,
  });
}

export async function dispatchConnectedServiceCredentialHealthNotificationsAsync(params: Readonly<
  Omit<Parameters<typeof dispatchConnectedServiceCredentialHealthNotificationAsync>[0], 'source' | 'loadProfilesById'> & {
    source: Omit<ConnectedServiceCredentialHealthNotificationSource, 'sessionId' | 'sessionTitle'>;
    targets: readonly Readonly<{ sessionId: string; sessionTitle?: string | null }>[];
  }
>): Promise<void> {
  let profilesRead: Promise<ReadonlyMap<string, ConnectedServiceNotificationProfileSummary>> | undefined;
  const loadProfilesById = () => profilesRead ??= loadConnectedServiceNotificationProfilesById({
    serviceId: params.source.serviceId,
    profileIds: [params.source.profileId],
    signal: params.signal,
    listQualifiedConnectedAccounts: params.listQualifiedConnectedAccounts,
  });
  await Promise.all(params.targets.map((target) => dispatchConnectedServiceCredentialHealthNotificationAsync({
    ...params, source: { ...params.source, ...target }, loadProfilesById,
  })));
}
