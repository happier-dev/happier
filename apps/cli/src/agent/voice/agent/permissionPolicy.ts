import type { PermissionMode } from '@/api/types';
import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import { isDefaultWriteLikeToolName } from '@/agent/permissions/CodexLikePermissionHandler';

export type VoiceAgentPermissionPolicy = 'no_tools' | 'read_only';

export function permissionModeForVoiceAgentPolicy(_policy: VoiceAgentPermissionPolicy): PermissionMode {
  // Voice agent should never run with elevated permissions.
  return 'read-only';
}

export function createVoiceAgentAcpPermissionHandler(permissionPolicy: VoiceAgentPermissionPolicy): AcpPermissionHandler {
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
