import { legacyCustomAcpCompat } from '@happier-dev/agents';
import { readAgentCatalogSnapshot } from '@/agent/catalog/snapshot';

import { readAgentCliOverrideForRuntime, resolveAgentCliCommandForRuntime } from './agentCliResolution';

export function resolveAgentCliRuntimeSpecForLookupId(agentId: string) {
  if (legacyCustomAcpCompat.isLegacyCustomAcpAgentId(agentId)) {
    return legacyCustomAcpCompat.getLegacyCustomAcpAgentCliRuntimeSpec();
  }
  const runtimeSpec = readAgentCatalogSnapshot().agentDefinitionsById.get(agentId)?.runtimeSpec;
  if (runtimeSpec) return runtimeSpec;
  throw new Error(`Missing agent CLI runtime metadata for '${agentId}'`);
}

export function buildMissingAgentCliCommandErrorMessage(
  agentId: string,
  opts: Readonly<{ processEnv?: NodeJS.ProcessEnv }> = {},
): string {
  const processEnv = opts.processEnv ?? process.env;
  const runtimeSpec = resolveAgentCliRuntimeSpecForLookupId(agentId);
  const envKey = `HAPPIER_${agentId.toUpperCase()}_PATH`;
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
  opts: Readonly<{ processEnv?: NodeJS.ProcessEnv }> = {},
): string {
  const resolved = resolveAgentCliCommandForRuntime(resolveAgentCliRuntimeSpecForLookupId(agentId), {
    processEnv: opts.processEnv,
  });
  if (resolved) return resolved.command;
  throw new ReferenceError(buildMissingAgentCliCommandErrorMessage(agentId, opts));
}

function capitalize(value: string): string {
  if (!value) return value;
  return `${value[0]!.toUpperCase()}${value.slice(1)}`;
}
