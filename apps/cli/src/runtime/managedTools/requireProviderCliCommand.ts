import type { AgentId } from '@happier-dev/agents';

import { readProviderCliOverride, resolveProviderCliCommand } from './providerCliResolution';

export function buildMissingProviderCliCommandErrorMessage(
  agentId: AgentId,
  opts: Readonly<{ processEnv?: NodeJS.ProcessEnv }> = {},
): string {
  const processEnv = opts.processEnv ?? process.env;
  const envKey = `HAPPIER_${agentId.toUpperCase()}_PATH`;
  if (readProviderCliOverride(agentId, processEnv)) {
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
  agentId: AgentId,
  opts: Readonly<{ processEnv?: NodeJS.ProcessEnv }> = {},
): string {
  const resolved = resolveProviderCliCommand(agentId, { processEnv: opts.processEnv });
  if (resolved) return resolved.command;
  throw new ReferenceError(buildMissingProviderCliCommandErrorMessage(agentId, opts));
}

function capitalize(value: string): string {
  if (!value) return value;
  return `${value[0]!.toUpperCase()}${value.slice(1)}`;
}
