import { AgentCliNotFoundError } from './agentCliNotFoundError';
import {
  buildMissingAgentCliCommandErrorMessage,
  resolveAgentCliRuntimeSpecForLookupId,
  type AgentCliResolutionOptions,
} from './requireAgentCliCommand';
import {
  resolveAgentCliLaunchSpecForRuntime,
  type AgentCliLaunchSpec,
} from './agentCliLaunchSpec';
export type { AgentCliLaunchSpec } from './agentCliLaunchSpec';

export function resolveAgentCliLaunchSpec(
  agentId: string,
  opts: AgentCliResolutionOptions = {},
): AgentCliLaunchSpec | null {
  return resolveAgentCliLaunchSpecForRuntime(
    resolveAgentCliRuntimeSpecForLookupId(agentId, opts),
    opts,
  );
}

export function requireAgentCliLaunchSpec(
  agentId: string,
  opts: AgentCliResolutionOptions = {},
): AgentCliLaunchSpec {
  const resolved = resolveAgentCliLaunchSpec(agentId, opts);
  if (resolved) return resolved;
  throw new AgentCliNotFoundError(agentId, buildMissingAgentCliCommandErrorMessage(agentId, opts));
}
