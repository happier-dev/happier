import { AccountNoticePushDataV1Schema, PluginSessionPushDataV1Schema } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { PushNotificationClient } from '@/api/pushNotifications';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import type { StoredCredentials } from '@/persistence';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { hydrateNotificationChannelCatalogForActiveAccount } from '@/settings/notifications/hydrateNotificationChannelCatalog';
import type { StablePluginNotificationsHost } from '@/plugins/runtime/invocation/services/notifications';
import { dispatchActivityNotificationAsync } from './dispatchActivityNotification';
import type { ExpoPushActivityNotificationSender } from './sendExpoPushActivityNotification';
import { readPluginSessionDestination } from '@/session/services/pluginSessionDestination';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import { isJsonObject } from '@happier-dev/protocol/json/strictJsonValue';

/** The plugin invocation joins the host's existing Account/channel/push owner. */
export function createPluginNativeNotificationDelivery(params: Readonly<{
  credentials: StoredCredentials;
  readCredentials(): Promise<StoredCredentials | null>;
  serverUrl: string;
  serverHttpBaseUrl: string;
  serverId: string;
  isCurrent(): boolean | Promise<boolean>;
  resolveServerFeaturesSnapshot?(): CliServerFeaturesSnapshot | undefined;
  pushSender?: ExpoPushActivityNotificationSender;
}>): NonNullable<StablePluginNotificationsHost['sendNative']> {
  // One Account/Home-bound client retains the incumbent provider cooldown;
  // create it only when an admitted notification actually needs native push.
  let pushSender = params.pushSender;
  return async (seed, request, signal) => runWithServerHttpBaseUrl(params.serverHttpBaseUrl, async () => {
    const none = { attemptedChannels: 0, deliveredChannels: 0 };
    const accountId = readAccountIdFromToken(params.credentials.token);
    const scopeKey = resolveAccountSettingsScopeKey(params.credentials);
    const isCurrent = async () => {
      const current = await params.readCredentials();
      return !signal.aborted && seed.isOccurrenceCurrent() && await params.isCurrent()
        && Boolean(accountId && current && readAccountIdFromToken(current.token) === accountId)
        && getActiveAccountSettingsSnapshot()?.scopeKey === scopeKey;
    };
    if (!accountId || !await isCurrent()) return none;
    let data: Record<string, unknown>;
    if (request.notice) {
      data = AccountNoticePushDataV1Schema.parse({ v: 1, topic: 'account_notice', accountId,
        artifactId: request.notice.artifactId, source: { kind: 'plugin', pluginId: seed.plugin.id, itemId: request.notice.itemId },
        ...(request.notice.page ? { page: request.notice.page } : {}), serverUrl: params.serverUrl,
        ...(request.pluginNotification ? { pluginNotification: request.pluginNotification } : {}) });
    } else {
      // Push-only sends keep their live source. No notice id or stored copy is
      // manufactured when the captured Home cannot name the exact Session.
      const sessionId = isJsonObject(request.data) ? request.data.sessionId : undefined;
      if (typeof sessionId !== 'string') return none;
      const destination = readPluginSessionDestination({ sessionId, serverUrl: params.serverUrl,
        serverFeaturesSnapshot: params.resolveServerFeaturesSnapshot?.() });
      if (!destination) return none;
      const session = await fetchSessionById({ reason: 'session-notification', token: params.credentials.token, sessionId, serverUrl: params.serverHttpBaseUrl,
        accessProjectionVersion: 1, signal });
      if (session?.id !== sessionId || !await isCurrent()) return none;
      data = PluginSessionPushDataV1Schema.parse({ v: 1, topic: 'plugin_session', ...destination, accountId,
        ...(request.pluginNotification ? { pluginNotification: request.pluginNotification } : {}) });
    }
    const snapshot = getActiveAccountSettingsSnapshot();
    if (!snapshot || snapshot.scopeKey !== scopeKey) return none;
    if (!snapshot.notificationChannelCatalog || snapshot.notificationChannelCatalog.status === 'loading') {
      await hydrateNotificationChannelCatalogForActiveAccount({ credentials: params.credentials, signal, cleanupActiveSource: false });
    }
    if (!await isCurrent()) return none;
    const current = getActiveAccountSettingsSnapshot();
    if (!current) return none;
    const pushChannels = current.notificationChannelCatalog?.status === 'ready'
      ? current.notificationChannelCatalog.channels.filter(channel => channel.kind === 'expo_push').map(channel => channel.id) : [];
    return dispatchActivityNotificationAsync({ settings: current.settings, isCurrent,
      event: { topic: 'plugin_notification', title: request.title, eventId: request.eventId, data,
        ...(request.body === undefined ? {} : { body: request.body }), ...(request.type ? { type: request.type } : {}) },
      channels: pushChannels, pluginNotifications: null,
      expoPushSender: pushSender ??= new PushNotificationClient(params.credentials.token, params.serverHttpBaseUrl, params.serverId, params.serverUrl),
    });
  });
}
