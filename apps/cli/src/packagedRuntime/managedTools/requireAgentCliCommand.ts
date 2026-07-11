import {
  getAgentCliRuntimeSpec,
  isAgentId,
  legacyCustomAcpCompat,
} from '@happier-dev/agents';
import type { CatalogAgentLookupId } from '@/agent/catalog/ids';

import { readAgentCliOverrideForRuntime, resolveAgentCliCommandForRuntime } from './agentCliResolution';

export function resolveAgentCliRuntimeSpecForLookupId(agentId: CatalogAgentLookupId) {
  if (isAgentId(agentId)) {
    return getAgentCliRuntimeSpec(agentId);
  }
  if (legacyCustomAcpCompat.isLegacyCustomAcpAgentId(agentId)) {
    return legacyCustomAcpCompat.getLegacyCustomAcpAgentCliRuntimeSpec();
  }
  throw new Error(`Unsupported agent CLI runtime lookup id '${agentId}'`);
}

export function buildMissingAgentCliCommandErrorMessage(
  agentId: CatalogAgentLookupId,
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
  agentId: CatalogAgentLookupId,
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
