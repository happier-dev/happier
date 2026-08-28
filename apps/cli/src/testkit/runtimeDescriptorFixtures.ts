import type { RuntimeDescriptorV1 } from '@happier-dev/protocol';

export function buildTestAgentRuntimeDescriptorV1(
  agentId: string,
  agent: Readonly<Record<string, unknown>>,
): RuntimeDescriptorV1 {
  return { v: 1, agentId, agent };
}

export function buildTestCodexRuntimeDescriptorV1(
  agent: Readonly<Record<string, unknown>>,
): RuntimeDescriptorV1 {
  return buildTestAgentRuntimeDescriptorV1('codex', agent);
}

export function buildTestOpenCodeRuntimeDescriptorV1(
  agent: Readonly<Record<string, unknown>>,
): RuntimeDescriptorV1 {
  return buildTestAgentRuntimeDescriptorV1('opencode', agent);
}
