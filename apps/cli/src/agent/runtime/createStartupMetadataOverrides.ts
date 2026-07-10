import type { PermissionMode } from '@/api/types';
import type { SessionModelSelectionV1 } from '@happier-dev/protocol';
import {
  buildModelOverride,
  buildPermissionModeOverride,
} from '@/agent/runtime/startupMetadataUpdate';

export function createStartupMetadataOverrides(opts: {
  permissionMode?: PermissionMode;
  permissionModeUpdatedAt?: number;
  modelSelection?: SessionModelSelectionV1;
}) {
  return {
    permissionModeOverride: buildPermissionModeOverride({
      permissionMode: opts.permissionMode,
      permissionModeUpdatedAt: opts.permissionModeUpdatedAt,
    }),
    modelOverride: buildModelOverride({
      modelSelection: opts.modelSelection,
    }),
  };
}
