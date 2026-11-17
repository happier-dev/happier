import type { PermissionMode } from '@/api/types';
import type { SessionModelSelection } from '@happier-dev/protocol/providers/selection/v2';
import {
  buildModelOverride,
  buildPermissionModeOverride,
} from '@/agent/runtime/startupMetadataUpdate';

export function createStartupMetadataOverrides(opts: {
  permissionMode?: PermissionMode;
  permissionModeUpdatedAt?: number;
  modelSelection?: SessionModelSelection;
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
