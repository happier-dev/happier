import type { PermissionMode } from '@/api/types';
import { normalizePermissionModeToIntent } from '@/agent/runtime/permissionModeCanonical';

export type QwenApprovalMode = 'plan' | 'default' | 'auto-edit' | 'yolo';

function asIntent(mode: PermissionMode | null | undefined): PermissionMode {
  return normalizePermissionModeToIntent(mode ?? 'default') ?? 'default';
}

export function resolveQwenApprovalMode(permissionMode: PermissionMode | null | undefined): QwenApprovalMode {
  const intent = asIntent(permissionMode);
  if (intent === 'yolo' || intent === 'bypassPermissions') return 'yolo';
  if (intent === 'safe-yolo') return 'auto-edit';
  if (intent === 'plan' || intent === 'read-only') return 'plan';
  return 'default';
}

export function buildQwenAcpArgs(permissionMode: PermissionMode | null | undefined): string[] {
  return ['--acp', '--approval-mode', resolveQwenApprovalMode(permissionMode)];
}
