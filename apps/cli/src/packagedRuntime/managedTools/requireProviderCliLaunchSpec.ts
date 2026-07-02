import type { CatalogAgentLookupId } from '@/backends/types';
import {
  providerCliPathRequiresJavaScriptRuntime,
  resolveProviderCliJavaScriptRuntimeCommand,
  resolveProviderCliCommandForRuntime,
  type ProviderCliCommandResolution,
} from '@happier-dev/cli-common/providers';

import { isBun } from '../../utils/runtime';

import {
  buildMissingProviderCliCommandErrorMessage,
  resolveAgentCliRuntimeSpecForLookupId,
} from './requireProviderCliCommand';

export type ProviderCliLaunchSpec = Readonly<{
  source: ProviderCliCommandResolution['source'];
  resolvedPath: string;
  command: string;
  args: readonly string[];
}>;

export function resolveProviderCliLaunchSpec(
  agentId: CatalogAgentLookupId,
  opts: Readonly<{ processEnv?: NodeJS.ProcessEnv }> = {},
): ProviderCliLaunchSpec | null {
  const processEnv = opts.processEnv ?? process.env;
  const resolved = resolveProviderCliCommandForRuntime(resolveAgentCliRuntimeSpecForLookupId(agentId), {
    processEnv,
    isBunRuntime: isBun(),
    currentExecPath: process.execPath,
  });
  if (!resolved) return null;

  const runtimeCommand = resolveProviderCliJavaScriptRuntimeCommand(resolved.command, processEnv, {
    isBunRuntime: isBun(),
    currentExecPath: process.execPath,
  });

  if (!providerCliPathRequiresJavaScriptRuntime(resolved.command)) {
    return {
      source: resolved.source,
      resolvedPath: resolved.command,
      command: resolved.command,
      args: [],
    };
  }
  if (!runtimeCommand) return null;

  return {
    source: resolved.source,
    resolvedPath: resolved.command,
    command: runtimeCommand,
    args: [resolved.command],
  };
}

export function requireProviderCliLaunchSpec(
  agentId: CatalogAgentLookupId,
  opts: Readonly<{ processEnv?: NodeJS.ProcessEnv }> = {},
): ProviderCliLaunchSpec {
  const resolved = resolveProviderCliLaunchSpec(agentId, opts);
  if (resolved) return resolved;
  throw new ReferenceError(buildMissingProviderCliCommandErrorMessage(agentId, opts));
}
