import type { PermissionMode } from '@/api/types';
import {
  buildModelOverride,
  buildPermissionModeOverride,
} from '@/agent/runtime/startupMetadataUpdate';

export function createStartupMetadataOverrides(opts: {
  permissionMode?: PermissionMode;
  permissionModeUpdatedAt?: number;
  modelId?: string;
  modelUpdatedAt?: number;
}) {
  return {
    permissionModeOverride: buildPermissionModeOverride({
      permissionMode: opts.permissionMode,
      permissionModeUpdatedAt: opts.permissionModeUpdatedAt,
    }),
    modelOverride: buildModelOverride({
      modelId: opts.modelId,
      modelUpdatedAt: opts.modelUpdatedAt,
    }),
  };
}
