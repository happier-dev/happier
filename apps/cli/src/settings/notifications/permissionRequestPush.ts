import axios from 'axios';
import type { AccountSettings } from '@happier-dev/protocol';
import type { PermissionMode } from '@/api/types';
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import { isDefaultWriteLikeToolName } from '@/agent/permissions/writeLikeToolNameHeuristics';
import type { AgentRequestKind } from '@/agent/permissions/requestKind';
import { logger } from '@/ui/logger';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

import { shouldSendPermissionRequestPushNotification, shouldSendUserActionRequestPushNotification } from './notificationsPolicy';

export type PermissionRequestPushSender = Readonly<{
  sendToAllDevicesAsync: (title: string, body: string, data: Record<string, unknown>) => Promise<void>;
}>;

function firstString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function firstStringFromUnknown(value: unknown): string | null {
  const direct = firstString(value);
  if (direct) return direct;
  if (Array.isArray(value)) {
    for (const item of value) {
      const s = firstString(item);
      if (s) return s;
    }
  }
  return null;
}

function shortPath(raw: string): string {
  const value = raw.trim();
  if (!value) return value;
  const normalized = value.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length <= 2) return normalized;
  return `${parts.at(-2)}/${parts.at(-1)}`;
}

function commandName(raw: string): string {
  const value = raw.trim();
  if (!value) return value;
  // Avoid leaking arguments (tokens/paths/etc). Show only the command name.
  // Handles common "cmd && cmd" forms by taking the first token.
  const first = value.split(/\s+/).filter(Boolean)[0] ?? '';
  return first;
}

export function summarizeToolInputForPushNotification(toolName: string, toolInput: unknown): string | null {
  if (!toolInput || typeof toolInput !== 'object') return null;
  const rec = toolInput as Record<string, unknown>;

  // Prefer file/path hints for file-ish tools.
  const path =
    firstString(rec.file_path) ??
    firstString(rec.filePath) ??
    firstString(rec.path) ??
    firstString(rec.filename) ??
    firstString(rec.fileName);
  if (path) return `File: ${shortPath(path)}`;

  // Command-ish tools (Bash)
  const command =
    firstStringFromUnknown(rec.command) ??
    firstStringFromUnknown(rec.cmd) ??
    firstStringFromUnknown(rec.script);
  if (command) {
    const name = commandName(command);
    return name ? `Command: ${name}` : null;
  }

  // AskUserQuestion: surface number of questions/options, avoid showing question text.
  const questions = rec.questions;
  if (Array.isArray(questions)) {
    const count = questions.length;
    if (count === 1) return `1 question`;
    if (count > 1) return `${count} questions`;
  }

  // Default: no details (avoid leaking arbitrary input content).
  const normalized = typeof toolName === 'string' ? toolName.trim() : '';
  if (normalized === 'Read' || normalized === 'Write' || normalized === 'Edit' || normalized === 'Bash') {
    return null;
  }
  return null;
}

export function buildAgentRequestPushNotification(params: Readonly<{
  kind: AgentRequestKind;
  sessionId: string;
  requestId: string;
  toolName: string;
  toolDetails?: string | null;
}>): Readonly<{ title: string; body: string; data: Record<string, unknown> }> {
  const type = params.kind === 'user_action' ? 'user_action_request' : 'permission_request';
  const title = params.kind === 'user_action' ? 'Action Required' : 'Permission Request';
  const details = typeof params.toolDetails === 'string' && params.toolDetails.trim() ? params.toolDetails.trim() : null;
  const body = params.kind === 'user_action'
    ? details
      ? `Input needed for: ${params.toolName}\n${details}`
      : `Input needed for: ${params.toolName}`
    : details
      ? `Approval needed for: ${params.toolName}\n${details}`
      : `Approval needed for: ${params.toolName}`;

  return {
    title,
    body,
    data: {
      sessionId: params.sessionId,
      requestId: params.requestId,
      tool: params.toolName,
      type,
      kind: params.kind,
    },
  };
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
  const built = buildAgentRequestPushNotification({
    kind: params.kind,
    sessionId: params.sessionId,
    requestId: params.requestId,
    toolName: params.toolName,
    toolDetails: details,
  });
  try {
    await params.pushSender.sendToAllDevicesAsync(built.title, built.body, built.data);
    return true;
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
  sendPermissionRequestPushNotificationBestEffort({
    ...params,
    settings,
  });
}
