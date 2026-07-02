import type { Metadata, PermissionMode } from '@/api/types';

import { normalizePermissionModeToIntent } from './modeCanonical';
import { maybeUpdatePermissionModeMetadata } from './modeMetadata';

export function resolvePermissionModeForQueueingUserMessage(opts: {
  currentPermissionMode: PermissionMode | undefined;
  messagePermissionModeRaw: unknown;
  updateMetadata: (updater: (current: Metadata) => Metadata) => void;
  nowMs: () => number;
}): { currentPermissionMode: PermissionMode | undefined; queuePermissionMode: PermissionMode; didChange: boolean } {
  let nextCurrentPermissionMode = opts.currentPermissionMode;
  // Canonical change signal (ported S-6): maybeUpdatePermissionModeMetadata compares ALIAS-
  // NORMALIZED modes ('acceptEdits' ≡ 'safe-yolo', 'bypassPermissions' ≡ 'yolo'), so an alias
  // respelling of the current mode is NOT a change. Callers must gate on this instead of a raw
  // string compare, which wrongly blocked in-flight steering on alias-only differences.
  let didChange = false;

  const nextPermissionMode = normalizePermissionModeToIntent(opts.messagePermissionModeRaw);
  if (nextPermissionMode) {
    const res = maybeUpdatePermissionModeMetadata({
      currentPermissionMode: opts.currentPermissionMode,
      nextPermissionMode,
      updateMetadata: opts.updateMetadata,
      nowMs: opts.nowMs,
    });
    nextCurrentPermissionMode = res.currentPermissionMode;
    didChange = res.didChange;
  }

  return {
    currentPermissionMode: nextCurrentPermissionMode,
    queuePermissionMode: nextCurrentPermissionMode || 'default',
    didChange,
  };
}
