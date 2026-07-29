import {
  buildMissingAgentCliCommandErrorMessage,
  resolveAgentCliRuntimeSpecForLookupId,
} from './requireAgentCliCommand';
import {
  resolveAgentCliLaunchSpecForRuntime,
  type AgentCliLaunchSpec,
} from './agentCliLaunchSpec';
export type { AgentCliLaunchSpec } from './agentCliLaunchSpec';

export function resolveAgentCliLaunchSpec(
  agentId: string,
  opts: Readonly<{ processEnv?: NodeJS.ProcessEnv }> = {},
): AgentCliLaunchSpec | null {
  return resolveAgentCliLaunchSpecForRuntime(
    resolveAgentCliRuntimeSpecForLookupId(agentId),
    opts,
  );
}

export function requireAgentCliLaunchSpec(
  agentId: string,
  opts: Readonly<{ processEnv?: NodeJS.ProcessEnv }> = {},
): AgentCliLaunchSpec {
  const resolved = resolveAgentCliLaunchSpec(agentId, opts);
  if (resolved) return resolved;
  throw new ReferenceError(buildMissingAgentCliCommandErrorMessage(agentId, opts));
}
