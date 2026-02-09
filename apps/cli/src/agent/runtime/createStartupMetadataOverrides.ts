import type { PermissionMode } from '@/api/types';
import {
  buildAcpSessionModeOverride,
  buildModelOverride,
  buildPermissionModeOverride,
} from '@/agent/runtime/startupMetadataUpdate';

export function createStartupMetadataOverrides(opts: {
  permissionMode?: PermissionMode;
  permissionModeUpdatedAt?: number;
  agentModeId?: string;
  agentModeUpdatedAt?: number;
  modelId?: string;
  modelUpdatedAt?: number;
}) {
  return {
    permissionModeOverride: buildPermissionModeOverride({
      permissionMode: opts.permissionMode,
      permissionModeUpdatedAt: opts.permissionModeUpdatedAt,
    }),
    acpSessionModeOverride: buildAcpSessionModeOverride({
      agentModeId: opts.agentModeId,
      agentModeUpdatedAt: opts.agentModeUpdatedAt,
    }),
    modelOverride: buildModelOverride({
      modelId: opts.modelId,
      modelUpdatedAt: opts.modelUpdatedAt,
    }),
  };
}
