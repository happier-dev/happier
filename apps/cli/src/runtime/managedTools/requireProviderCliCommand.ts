import {
  getProviderCliRuntimeSpec,
  isAgentId,
  legacyCustomAcpCompat,
} from '@happier-dev/agents';
import type { CatalogAgentLookupId } from '@/backends/types';

import { readProviderCliOverrideForRuntime, resolveProviderCliCommandForRuntime } from './providerCliResolution';

export function resolveProviderCliRuntimeSpecForLookupId(agentId: CatalogAgentLookupId) {
  if (isAgentId(agentId)) {
    return getProviderCliRuntimeSpec(agentId);
  }
  if (legacyCustomAcpCompat.isLegacyCustomAcpAgentId(agentId)) {
    return legacyCustomAcpCompat.getLegacyCustomAcpProviderCliRuntimeSpec();
  }
  throw new Error(`Unsupported provider CLI runtime lookup id '${agentId}'`);
}

export function buildMissingProviderCliCommandErrorMessage(
  agentId: CatalogAgentLookupId,
  opts: Readonly<{ processEnv?: NodeJS.ProcessEnv }> = {},
): string {
  const processEnv = opts.processEnv ?? process.env;
  const runtimeSpec = resolveProviderCliRuntimeSpecForLookupId(agentId);
  const envKey = `HAPPIER_${agentId.toUpperCase()}_PATH`;
  if (readProviderCliOverrideForRuntime(runtimeSpec, processEnv)) {
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

export function requireProviderCliCommand(
  agentId: CatalogAgentLookupId,
  opts: Readonly<{ processEnv?: NodeJS.ProcessEnv }> = {},
): string {
  const resolved = resolveProviderCliCommandForRuntime(resolveProviderCliRuntimeSpecForLookupId(agentId), {
    processEnv: opts.processEnv,
  });
  if (resolved) return resolved.command;
  throw new ReferenceError(buildMissingProviderCliCommandErrorMessage(agentId, opts));
}

function capitalize(value: string): string {
  if (!value) return value;
  return `${value[0]!.toUpperCase()}${value.slice(1)}`;
}
