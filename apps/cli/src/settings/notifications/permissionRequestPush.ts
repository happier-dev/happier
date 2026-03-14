import axios from 'axios';
import type { AccountSettings } from '@happier-dev/protocol';
import type { PermissionMode } from '@/api/types';
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import { isDefaultWriteLikeToolName } from '@/agent/permissions/writeLikeToolNameHeuristics';
import type { AgentRequestKind } from '@/agent/permissions/requestKind';
import { dispatchActivityNotificationAsync } from '@/activity/notifications/dispatchActivityNotification';
import {
  buildAgentRequestNotificationContent,
  summarizeToolInputForNotification,
} from '@/activity/notifications/buildAgentRequestNotificationContent';
import { logger } from '@/ui/logger';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

import { shouldSendPermissionRequestPushNotification, shouldSendUserActionRequestPushNotification } from './notificationsPolicy';

export type PermissionRequestPushSender = Readonly<{
  sendToAllDevicesAsync: (title: string, body: string, data: Record<string, unknown>) => Promise<void>;
}>;

export function summarizeToolInputForPushNotification(toolName: string, toolInput: unknown): string | null {
  return summarizeToolInputForNotification(toolName, toolInput);
}

export function buildAgentRequestPushNotification(params: Readonly<{
  kind: AgentRequestKind;
  sessionId: string;
  requestId: string;
  toolName: string;
  toolDetails?: string | null;
}>): Readonly<{ title: string; body: string; data: Record<string, unknown> }> {
  return buildAgentRequestNotificationContent(params);
}

export function buildPermissionRequestPushNotification(params: Readonly<{
  sessionId: string;
  permissionId: string;
  toolName: string;
}>): Readonly<{ title: string; body: string; data: Record<string, unknown> }> {
  return buildAgentRequestPushNotification({
    kind: 'permission',
    sessionId: params.sessionId,
    requestId: params.permissionId,
    toolName: params.toolName,
  });
}

export async function sendAgentRequestPushNotificationAsync(params: Readonly<{
  pushSender: PermissionRequestPushSender;
  sessionId: string;
  requestId: string;
  toolName: string;
  kind: AgentRequestKind;
  settings: AccountSettings | null;
  settingsSecretsReadKeys?: ReadonlyArray<Uint8Array | null | undefined>;
  toolInput?: unknown;
  toolDetails?: string | null;
}>): Promise<boolean> {
  const shouldSend = params.kind === 'user_action'
    ? shouldSendUserActionRequestPushNotification(params.settings)
    : shouldSendPermissionRequestPushNotification(params.settings);
  if (!shouldSend) return false;

  const details = typeof params.toolDetails === 'string' && params.toolDetails.trim()
    ? params.toolDetails.trim()
    : summarizeToolInputForPushNotification(params.toolName, params.toolInput);
  try {
    const result = await dispatchActivityNotificationAsync({
      settings: params.settings,
      settingsSecretsReadKeys: params.settingsSecretsReadKeys,
      expoPushSender: params.pushSender,
      event: {
        topic: params.kind === 'user_action' ? 'user_action_request' : 'permission_request',
        sessionId: params.sessionId,
        requestId: params.requestId,
        toolName: params.toolName,
        toolInput: params.toolInput,
        toolDetails: details,
      },
    });
    return result.deliveredChannels > 0;
  } catch (error) {
    logger.debug(
      '[permissionRequestPush] Failed to send request push',
      axios.isAxiosError(error) ? serializeAxiosErrorForLog(error) : error,
    );
    return false;
  }
}

export async function sendPermissionRequestPushNotificationAsync(params: Readonly<{
  pushSender: PermissionRequestPushSender;
  sessionId: string;
  permissionId: string;
  toolName: string;
  settings: AccountSettings | null;
  settingsSecretsReadKeys?: ReadonlyArray<Uint8Array | null | undefined>;
  toolInput?: unknown;
  toolDetails?: string | null;
}>): Promise<boolean> {
  return sendAgentRequestPushNotificationAsync({
    pushSender: params.pushSender,
    sessionId: params.sessionId,
    requestId: params.permissionId,
    toolName: params.toolName,
    kind: 'permission',
    settings: params.settings,
    settingsSecretsReadKeys: params.settingsSecretsReadKeys,
    toolInput: params.toolInput,
    toolDetails: params.toolDetails,
  });
}

export function sendPermissionRequestPushNotification(params: Readonly<{
  pushSender: PermissionRequestPushSender;
  sessionId: string;
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
  permissionId: string;
  toolName: string;
  settings: AccountSettings | null;
  settingsSecretsReadKeys?: ReadonlyArray<Uint8Array | null | undefined>;
  toolInput?: unknown;
  toolDetails?: string | null;
}>): void {
  void sendPermissionRequestPushNotificationAsync(params).catch(() => {});
}

/**
 * Returns true when the given permission mode would auto-approve the tool,
 * meaning a push notification would just be noise.
 */
function isAutoApprovedByMode(permissionMode: PermissionMode | null | undefined, toolName: string): boolean {
  if (!permissionMode) return false;
  if (permissionMode === 'yolo' || permissionMode === 'bypassPermissions') return true;
  if (permissionMode === 'safe-yolo' && !isDefaultWriteLikeToolName(toolName)) return true;
  return false;
}

export function sendPermissionRequestPushNotificationForActiveAccount(params: Readonly<{
  pushSender: PermissionRequestPushSender;
  sessionId: string;
  permissionId: string;
  toolName: string;
  permissionMode?: PermissionMode | null;
  toolInput?: unknown;
  toolDetails?: string | null;
}>): void {
  if (isAutoApprovedByMode(params.permissionMode, params.toolName)) return;
  const settings = getActiveAccountSettingsSnapshot()?.settings ?? null;
  const settingsSecretsReadKeys = getActiveAccountSettingsSnapshot()?.settingsSecretsReadKeys ?? [];
  sendPermissionRequestPushNotificationBestEffort({
    ...params,
    settings,
    settingsSecretsReadKeys,
  });
}
