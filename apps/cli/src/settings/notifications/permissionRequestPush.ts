import {
  summarizeToolInputForNotification,
  type AccountSettings,
} from '@happier-dev/protocol';
import type { PermissionMode } from '@/api/types';
import type { PushNotificationDeliveryOptions } from '@/api/pushNotifications';
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import type { AgentRequestKind } from '@/agent/permissions/requestKind';
import { dispatchActivityNotificationAsync } from '@/notifications/activity/dispatchActivityNotification';
import {
  resolveLiveActivityRemoteSender,
  type LiveActivityRemoteSenderCandidate,
} from '@/notifications/activity/liveActivity/resolveLiveActivityRemoteSender';
import { logger } from '@/ui/logger';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

export type PermissionRequestPushSender = LiveActivityRemoteSenderCandidate & Readonly<{
  sendToAllDevicesAsync: (
    title: string,
    body: string,
    data: Record<string, unknown>,
    options?: PushNotificationDeliveryOptions,
  ) => Promise<void>;
}>;

export type AgentRequestPushNotificationResult = Readonly<{
  status: 'delivered' | 'skipped' | 'failed';
}>;

export async function sendAgentRequestPushNotificationAsync(params: Readonly<{
  pushSender: PermissionRequestPushSender;
  sessionId: string;
  sessionTitle?: string | null;
  agentDisplayName?: string | null;
  requestId: string;
  toolName: string;
  kind: AgentRequestKind;
  settings: AccountSettings | null;
  settingsSecretsReadKeys?: ReadonlyArray<Uint8Array | null | undefined>;
  toolInput?: unknown;
  toolDetails?: string | null;
}>): Promise<AgentRequestPushNotificationResult> {
  const details = typeof params.toolDetails === 'string' && params.toolDetails.trim()
    ? params.toolDetails.trim()
    : summarizeToolInputForNotification(params.toolName, params.toolInput);
  try {
    const result = await dispatchActivityNotificationAsync({
      settings: params.settings,
      settingsSecretsReadKeys: params.settingsSecretsReadKeys,
      expoPushSender: params.pushSender,
      liveActivityRemoteSender: resolveLiveActivityRemoteSender(params.pushSender),
      event: {
        topic: params.kind === 'user_action' ? 'user_action_request' : 'permission_request',
        sessionId: params.sessionId,
        sessionTitle: params.sessionTitle,
        agentDisplayName: params.agentDisplayName,
        requestId: params.requestId,
        toolName: params.toolName,
        toolInput: params.toolInput,
        toolDetails: details,
      },
    });
    if (result.deliveredChannels > 0) return { status: 'delivered' };
    if (result.attemptedChannels === 0) return { status: 'skipped' };
    return { status: 'failed' };
  } catch (error) {
    logger.debug(
      '[permissionRequestPush] Failed to send request push',
      serializeAxiosErrorForLog(error),
    );
    return { status: 'failed' };
  }
}

export async function sendPermissionRequestPushNotificationAsync(params: Readonly<{
  pushSender: PermissionRequestPushSender;
  sessionId: string;
  sessionTitle?: string | null;
  agentDisplayName?: string | null;
  permissionId: string;
  toolName: string;
  settings: AccountSettings | null;
  settingsSecretsReadKeys?: ReadonlyArray<Uint8Array | null | undefined>;
  toolInput?: unknown;
  toolDetails?: string | null;
}>): Promise<boolean> {
  const result = await sendAgentRequestPushNotificationAsync({
    pushSender: params.pushSender,
    sessionId: params.sessionId,
    sessionTitle: params.sessionTitle,
    agentDisplayName: params.agentDisplayName,
    requestId: params.permissionId,
    toolName: params.toolName,
    kind: 'permission',
    settings: params.settings,
    settingsSecretsReadKeys: params.settingsSecretsReadKeys,
    toolInput: params.toolInput,
    toolDetails: params.toolDetails,
  });
  return result.status === 'delivered';
}

export function sendPermissionRequestPushNotification(params: Readonly<{
  pushSender: PermissionRequestPushSender;
  sessionId: string;
  sessionTitle?: string | null;
  agentDisplayName?: string | null;
  permissionId: string;
  toolName: string;
  settings?: AccountSettings | null;
  settingsSecretsReadKeys?: ReadonlyArray<Uint8Array | null | undefined>;
  toolInput?: unknown;
  toolDetails?: string | null;
}>): void {
  void sendPermissionRequestPushNotificationAsync({
    ...params,
    settings: params.settings ?? null,
  }).catch(() => {});
}

export function sendPermissionRequestPushNotificationBestEffort(params: Readonly<{
  pushSender: PermissionRequestPushSender;
  sessionId: string;
  sessionTitle?: string | null;
  agentDisplayName?: string | null;
  permissionId: string;
  toolName: string;
  settings: AccountSettings | null;
  settingsSecretsReadKeys?: ReadonlyArray<Uint8Array | null | undefined>;
  toolInput?: unknown;
  toolDetails?: string | null;
}>): void {
  void sendPermissionRequestPushNotificationAsync(params).catch(() => {});
}

export function sendPermissionRequestPushNotificationForActiveAccount(params: Readonly<{
  pushSender: PermissionRequestPushSender;
  sessionId: string;
  sessionTitle?: string | null;
  agentDisplayName?: string | null;
  permissionId: string;
  toolName: string;
  permissionMode?: PermissionMode | null;
  toolInput?: unknown;
  toolDetails?: string | null;
}>): void {
  const settings = getActiveAccountSettingsSnapshot()?.settings ?? null;
  const settingsSecretsReadKeys = getActiveAccountSettingsSnapshot()?.settingsSecretsReadKeys ?? [];
  sendPermissionRequestPushNotificationBestEffort({
    ...params,
    settings,
    settingsSecretsReadKeys,
  });
}
