import type { AgentAcpRuntimeDefinition } from '@happier-dev/plugin-sdk/agents/runtime';

// FX 0.0.14 renamed v0.0.13's `code` policy to `auto`. Both identities retain
// automatic safety review; `full-access` bypasses it and is never a candidate.
export const FX_PERMISSION_MODE_MAPPING = {
  default: null,
  'read-only': ['ask'],
  'safe-yolo': ['auto', 'code'],
} as const satisfies AgentAcpRuntimeDefinition['permissionModeMapping'];
