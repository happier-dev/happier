import type { Metadata, PermissionMode } from '@/api/types';
import { parsePermissionIntentAlias } from '@happier-dev/agents';

export function maybeUpdatePermissionModeMetadata(opts: {
  currentPermissionMode: PermissionMode | undefined;
  nextPermissionMode: PermissionMode;
  updateMetadata: (updater: (current: Metadata) => Metadata) => void;
  nowMs?: () => number;
}): { didChange: boolean; currentPermissionMode: PermissionMode } {
  const canonicalNext = (parsePermissionIntentAlias(opts.nextPermissionMode) ?? 'default') as PermissionMode;
  const canonicalCurrent = opts.currentPermissionMode
    ? ((parsePermissionIntentAlias(opts.currentPermissionMode) ?? opts.currentPermissionMode) as PermissionMode)
    : undefined;

  if (canonicalCurrent === canonicalNext) {
    return { didChange: false, currentPermissionMode: canonicalNext };
  }

  const nowMs = opts.nowMs ?? Date.now;
  opts.updateMetadata((current) => ({
    ...current,
    permissionMode: canonicalNext,
    permissionModeUpdatedAt: nowMs(),
  }));

  return { didChange: true, currentPermissionMode: canonicalNext };
}
