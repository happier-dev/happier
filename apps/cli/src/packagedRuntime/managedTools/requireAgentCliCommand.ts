import { legacyCustomAcpCompat } from '@happier-dev/agents';
import { readAgentCatalogSnapshot } from '@/agent/catalog/snapshot';
import { resolveAgentCliOverrideEnvKey } from '@happier-dev/cli-common/agents/resolution';

import { AgentCliNotFoundError } from './agentCliNotFoundError';
import { readAgentCliOverrideForRuntime, resolveAgentCliCommandForRuntime } from './agentCliResolution';

export type AgentCliResolutionOptions = Readonly<{
  processEnv?: NodeJS.ProcessEnv;
  catalogSnapshot?: ReturnType<typeof readAgentCatalogSnapshot>;
}>;

export function resolveAgentCliRuntimeSpecForLookupId(agentId: string, opts: AgentCliResolutionOptions = {}) {
  if (legacyCustomAcpCompat.isLegacyCustomAcpAgentId(agentId)) {
    return legacyCustomAcpCompat.getLegacyCustomAcpAgentCliRuntimeSpec();
  }
  const runtimeSpec = (opts.catalogSnapshot ?? readAgentCatalogSnapshot()).agentDefinitionsById.get(agentId)?.runtimeSpec;
  if (runtimeSpec) return runtimeSpec;
  throw new Error(`Missing agent CLI runtime metadata for '${agentId}'`);
}

export function buildMissingAgentCliCommandErrorMessage(
  agentId: string,
  opts: AgentCliResolutionOptions = {},
): string {
  const processEnv = opts.processEnv ?? process.env;
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
    processEnv: opts.processEnv,
  });
  if (resolved) return resolved.command;
  throw new AgentCliNotFoundError(agentId, buildMissingAgentCliCommandErrorMessage(agentId, opts));
}

function capitalize(value: string): string {
  if (!value) return value;
  return `${value[0]!.toUpperCase()}${value.slice(1)}`;
}
