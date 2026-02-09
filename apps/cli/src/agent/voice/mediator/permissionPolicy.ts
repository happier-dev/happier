import type { PermissionMode } from '@/api/types';
import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import { isDefaultWriteLikeToolName } from '@/agent/permissions/CodexLikePermissionHandler';

export type VoiceMediatorPermissionPolicy = 'no_tools' | 'read_only';

export function permissionModeForVoiceMediatorPolicy(_policy: VoiceMediatorPermissionPolicy): PermissionMode {
  // Voice mediator should never run with elevated permissions.
  return 'read-only';
}

export function createVoiceMediatorAcpPermissionHandler(permissionPolicy: VoiceMediatorPermissionPolicy): AcpPermissionHandler {
  if (permissionPolicy === 'no_tools') {
    return {
      async handleToolCall() {
        return { decision: 'denied' };
      },
    };
  }

  return {
    async handleToolCall(_toolCallId, toolName) {
      return { decision: isDefaultWriteLikeToolName(toolName) ? 'denied' : 'approved' };
    },
  };
}

