import type { Metadata, PermissionMode } from '@/api/types';
import { createSessionStateSyncEngine, parsePermissionIntentAlias } from '@happier-dev/agents';
import type { SessionStateCapabilitiesV1 } from '@happier-dev/protocol';

const PERMISSION_MODE_METADATA_CAPABILITIES: SessionStateCapabilitiesV1 = {
  intent: {
    permissionMode: { supported: true, happierToProvider: { supported: false }, providerToHappier: { supported: false } },
  },
};

function updatePermissionModeMetadataWithEngine(params: Readonly<{
  permissionMode: PermissionMode;
  updatedAt: number;
  updateMetadata: (updater: (current: Metadata) => Metadata) => void;
}>): void {
  const engine = createSessionStateSyncEngine({
    capabilities: PERMISSION_MODE_METADATA_CAPABILITIES,
    facet: null,
    metadataPort: {
      update: async (_sessionId, updater) => {
        try {
          params.updateMetadata((current) => updater(current) as Metadata);
          return { ok: true, version: 0 };
        } catch {
          return { ok: false, reason: 'unknown_error' };
        }
      },
    },
  });

  void engine.writeHappierField({
    sessionId: 'permission-mode-message',
    fieldId: 'intent.permissionMode',
    value: {
      v: 1,
      permissionMode: params.permissionMode,
      updatedAt: params.updatedAt,
    },
    reason: 'user-mutation',
    metadataReason: 'permission_mode_from_user_message',
    mirrorToProvider: false,
  });
}

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
  updatePermissionModeMetadataWithEngine({
    permissionMode: canonicalNext,
    updatedAt: nowMs(),
    updateMetadata: opts.updateMetadata,
  });

  return { didChange: true, currentPermissionMode: canonicalNext };
}
