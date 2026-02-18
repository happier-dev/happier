import axios from 'axios';

import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import { logger } from '@/ui/logger';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

import { shouldSendPermissionRequestPushNotification } from './notificationsPolicy';
import type { AccountSettings } from '@happier-dev/protocol';

type PushSender = Readonly<{
  sendToAllDevices: (title: string, body: string, data: Record<string, unknown>) => void;
}>;

export function sendPermissionRequestPushNotification(params: Readonly<{
  pushSender: PushSender;
  sessionId: string;
  permissionId: string;
  toolName: string;
  settings?: AccountSettings | null;
}>): void {
  if (!shouldSendPermissionRequestPushNotification(params.settings ?? null)) return;
  try {
    params.pushSender.sendToAllDevices(
      'Permission Request',
      `Approval needed for: ${params.toolName}`,
      {
        sessionId: params.sessionId,
        requestId: params.permissionId,
        tool: params.toolName,
        type: 'permission_request',
      },
    );
  } catch (error) {
    logger.debug(
      '[permissionRequestPush] Failed to send permission request push',
      axios.isAxiosError(error) ? serializeAxiosErrorForLog(error) : error,
    );
  }
}

export function sendPermissionRequestPushNotificationForActiveAccount(params: Readonly<{
  pushSender: PushSender;
  sessionId: string;
  permissionId: string;
  toolName: string;
}>): void {
  const settings = getActiveAccountSettingsSnapshot()?.settings ?? null;
  sendPermissionRequestPushNotification({ ...params, settings });
}
