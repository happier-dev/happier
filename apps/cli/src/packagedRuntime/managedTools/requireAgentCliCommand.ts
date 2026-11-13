import { legacyCustomAcpCompat } from '@happier-dev/agents';
import { readAgentCatalogSnapshot } from '@/agent/catalog/snapshot';
import { resolveAgentCliOverrideEnvKey } from '@happier-dev/cli-common/agents/resolution';
import { sessionProcessEnvironment, sessionWorkingDirectory } from '@/agent/runtime/lifecycle/hostedSessionScope';

import { AgentCliNotFoundError } from './agentCliNotFoundError';
import { readAgentCliOverrideForRuntime, resolveAgentCliCommandForRuntime } from './agentCliResolution';

export type AgentCliResolutionOptions = Readonly<{
  processEnv?: NodeJS.ProcessEnv;
  cwd?: string;
  catalogSnapshot?: ReturnType<typeof readAgentCatalogSnapshot>;
}>;

export function resolveAgentCliRuntimeSpecForLookupId(lookupId: string, opts: AgentCliResolutionOptions = {}) {
  if (legacyCustomAcpCompat.isLegacyCustomAcpAgentId(lookupId)) {
    return legacyCustomAcpCompat.getLegacyCustomAcpAgentCliRuntimeSpec();
  }
  const snapshot = opts.catalogSnapshot ?? readAgentCatalogSnapshot();
  const runtimeSpec = snapshot.agentDefinitionsById.get(lookupId)?.runtimeSpec;
  if (runtimeSpec) return runtimeSpec;
  // Daemon prerequisites name the declared tool, while managed installations
  // are keyed by the Agent runtime. Consume the same catalog binding as Exec.
  for (const agent of snapshot.agentDefinitionsById.values()) {
    const toolId = agent.catalogEntry?.agentCliSystemTool?.toolId;
    if (toolId && (lookupId === toolId || lookupId === `${agent.pluginId}/${toolId}`)) {
      if (agent.runtimeSpec) return agent.runtimeSpec;
    }
  }
  throw new Error(`Missing agent CLI runtime metadata for '${lookupId}'`);
}

export function buildMissingAgentCliCommandErrorMessage(
  agentId: string,
  opts: AgentCliResolutionOptions = {},
): string {
  const processEnv = opts.processEnv ?? sessionProcessEnvironment();
  const runtimeSpec = resolveAgentCliRuntimeSpecForLookupId(agentId, opts);
  const envKey = resolveAgentCliOverrideEnvKey(runtimeSpec.id);
  if (readAgentCliOverrideForRuntime(runtimeSpec, processEnv)) {
    return (
      `${capitalize(agentId)} CLI (${agentId}) is unavailable because ${envKey} is set ` +
      `but does not point to a supported CLI entrypoint. Fix ${envKey} or unset it, then restart the daemon.`
    );
  }
  return (
    `${capitalize(agentId)} CLI (${agentId}) is not available from any configured source. ` +
    `Install a system install of ${agentId}, use a managed install, or set ${envKey}, then restart the daemon.`
  );
}

export function requireAgentCliCommand(
  agentId: string,
  opts: AgentCliResolutionOptions = {},
): string {
  const resolved = resolveAgentCliCommandForRuntime(resolveAgentCliRuntimeSpecForLookupId(agentId, opts), {
    processEnv: opts.processEnv ?? sessionProcessEnvironment(),
    cwd: opts.cwd ?? sessionWorkingDirectory(),
  });
  if (resolved) return resolved.command;
  throw new AgentCliNotFoundError(agentId, buildMissingAgentCliCommandErrorMessage(agentId, opts));
}

function capitalize(value: string): string {
  if (!value) return value;
  return `${value[0]!.toUpperCase()}${value.slice(1)}`;
}
