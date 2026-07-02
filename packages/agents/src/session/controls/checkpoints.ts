import type { ToolNormalizationProtocol } from '@happier-dev/protocol';

export type RuntimeCheckpointToolProtocolV1 = ToolNormalizationProtocol;

export const RUNTIME_CHECKPOINT_TOOL_PROTOCOLS_V1 = [
  'acp',
  'claude',
  'codex',
] as const satisfies readonly RuntimeCheckpointToolProtocolV1[];

export function resolveRuntimeCheckpointToolProtocol(value: unknown): RuntimeCheckpointToolProtocolV1 {
  return RUNTIME_CHECKPOINT_TOOL_PROTOCOLS_V1.includes(value as RuntimeCheckpointToolProtocolV1)
    ? value as RuntimeCheckpointToolProtocolV1
    : 'acp';
}
