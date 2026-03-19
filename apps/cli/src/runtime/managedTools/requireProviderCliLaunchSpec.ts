import type { AgentId } from '@happier-dev/agents';
import {
  providerCliPathRequiresJavaScriptRuntime,
  resolveJavaScriptRuntimeCommand,
  resolveProviderCliCommand,
  type ProviderCliCommandResolution,
} from '@happier-dev/cli-common/providers';

import { isBun } from '@/utils/runtime';

import { buildMissingProviderCliCommandErrorMessage } from './requireProviderCliCommand';

export type ProviderCliLaunchSpec = Readonly<{
  source: ProviderCliCommandResolution['source'];
  resolvedPath: string;
  command: string;
  args: readonly string[];
}>;

export function resolveProviderCliLaunchSpec(
  agentId: AgentId,
  opts: Readonly<{ processEnv?: NodeJS.ProcessEnv }> = {},
): ProviderCliLaunchSpec | null {
  const processEnv = opts.processEnv ?? process.env;
  const resolved = resolveProviderCliCommand(agentId, {
    processEnv,
    isBunRuntime: isBun(),
    currentExecPath: process.execPath,
  });
  if (!resolved) return null;

  if (!providerCliPathRequiresJavaScriptRuntime(resolved.command)) {
    return {
      source: resolved.source,
      resolvedPath: resolved.command,
      command: resolved.command,
      args: [],
    };
  }

  const runtimeCommand = resolveJavaScriptRuntimeCommand({
    isBunRuntime: isBun(),
    processEnv,
    currentExecPath: process.execPath,
  });
  if (!runtimeCommand) return null;

  return {
    source: resolved.source,
    resolvedPath: resolved.command,
    command: runtimeCommand,
    args: [resolved.command],
  };
}

export function requireProviderCliLaunchSpec(
  agentId: AgentId,
  opts: Readonly<{ processEnv?: NodeJS.ProcessEnv }> = {},
): ProviderCliLaunchSpec {
  const resolved = resolveProviderCliLaunchSpec(agentId, opts);
  if (resolved) return resolved;
  throw new ReferenceError(buildMissingProviderCliCommandErrorMessage(agentId, opts));
}
