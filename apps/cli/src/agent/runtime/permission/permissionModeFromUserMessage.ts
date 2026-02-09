import type { Metadata, PermissionMode } from '@/api/types';

import { normalizePermissionModeToIntent } from './permissionModeCanonical';
import { maybeUpdatePermissionModeMetadata } from './permissionModeMetadata';

export function resolvePermissionModeForQueueingUserMessage(opts: {
  currentPermissionMode: PermissionMode | undefined;
  messagePermissionModeRaw: unknown;
  updateMetadata: (updater: (current: Metadata) => Metadata) => void;
  nowMs: () => number;
}): { currentPermissionMode: PermissionMode | undefined; queuePermissionMode: PermissionMode } {
  let nextCurrentPermissionMode = opts.currentPermissionMode;

  const nextPermissionMode = normalizePermissionModeToIntent(opts.messagePermissionModeRaw);
  if (nextPermissionMode) {
    const res = maybeUpdatePermissionModeMetadata({
      currentPermissionMode: opts.currentPermissionMode,
      nextPermissionMode,
      updateMetadata: opts.updateMetadata,
      nowMs: opts.nowMs,
    });
    nextCurrentPermissionMode = res.currentPermissionMode;
  }

  return {
    currentPermissionMode: nextCurrentPermissionMode,
    queuePermissionMode: nextCurrentPermissionMode || 'default',
  };
}
