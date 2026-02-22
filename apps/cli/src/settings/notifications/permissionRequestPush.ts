import axios from 'axios';

import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import { isDefaultWriteLikeToolName } from '@/agent/permissions/CodexLikePermissionHandler';
import { logger } from '@/ui/logger';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

import { shouldSendPermissionRequestPushNotification } from './notificationsPolicy';
import type { AccountSettings } from '@happier-dev/protocol';
import type { PermissionMode } from '@/api/types';

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
  pushSender: PushSender;
  sessionId: string;
  permissionId: string;
  toolName: string;
  permissionMode?: PermissionMode | null;
}>): void {
  if (isAutoApprovedByMode(params.permissionMode, params.toolName)) return;
  const settings = getActiveAccountSettingsSnapshot()?.settings ?? null;
  sendPermissionRequestPushNotification({ ...params, settings });
}
