import type { AgentId } from '@happier-dev/agents';
import { getProviderCliRuntimeSpec } from '@happier-dev/agents';

import { readProviderCliOverride, resolveProviderCliCommand } from './providerCliResolution';

/** Resolution failed before a provider process or session could be created. */
export class ProviderCliNotFoundError extends ReferenceError {
  constructor(agentId: AgentId, opts: Readonly<{ processEnv?: NodeJS.ProcessEnv }> = {}) {
    super(buildMissingProviderCliCommandErrorMessage(agentId, opts));
    this.name = 'ProviderCliNotFoundError';
  }
}

/**
 * The provider CLI resolved and started, but its version cannot serve the requested launch.
 * The message names the minimum and the vendor's own update command, so it is shown as is.
 */
export class ProviderCliVersionUnsupportedError extends Error {
  readonly agentId: AgentId;
  readonly foundVersion: string | null;
  readonly minimumVersion: string;
  /** The vendor's own updater (`<binary> <nativeUpdate.args>`), when the catalog declares one. */
  readonly updateCommand: string | null;

  constructor(params: Readonly<{
    agentId: AgentId;
    /** What needs the newer CLI, as the sentence subject (e.g. "Connected Antigravity accounts"). */
    requiredFor: string;
    foundVersion: string | null;
    minimumVersion: string;
  }>) {
    const spec = getProviderCliRuntimeSpec(params.agentId);
    const foundVersion = params.foundVersion?.trim() || null;
    const updateCommand = spec.nativeUpdate ? [spec.binaryName, ...spec.nativeUpdate.args].join(' ') : null;
    super(
      `${params.requiredFor} need ${spec.title} ${params.minimumVersion} or newer${foundVersion ? ` (found ${foundVersion})` : ''}. `
      + (updateCommand ? `Run \`${updateCommand}\` on this machine, then try again.` : `Update ${spec.title} on this machine, then try again.`),
    );
    this.name = 'ProviderCliVersionUnsupportedError';
    this.agentId = params.agentId;
    this.foundVersion = foundVersion;
    this.minimumVersion = params.minimumVersion;
    this.updateCommand = updateCommand;
  }
}

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
  throw new ProviderCliNotFoundError(agentId, opts);
}

function capitalize(value: string): string {
  if (!value) return value;
  return `${value[0]!.toUpperCase()}${value.slice(1)}`;
}
