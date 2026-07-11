import type { CatalogAgentLookupId } from '@/agent/catalog/ids';
import {
  agentCliPathRequiresJavaScriptRuntime,
  resolveAgentCliJavaScriptRuntimeCommand,
  resolveAgentCliCommandForRuntime,
  type AgentCliCommandResolution,
} from '@happier-dev/cli-common/agents';

import { isBun } from '../../utils/runtime';

import {
  buildMissingAgentCliCommandErrorMessage,
  resolveAgentCliRuntimeSpecForLookupId,
} from './requireAgentCliCommand';

export type AgentCliLaunchSpec = Readonly<{
  source: AgentCliCommandResolution['source'];
  resolvedPath: string;
  command: string;
  args: readonly string[];
}>;

export function resolveAgentCliLaunchSpec(
  agentId: CatalogAgentLookupId,
  opts: Readonly<{ processEnv?: NodeJS.ProcessEnv }> = {},
): AgentCliLaunchSpec | null {
  const processEnv = opts.processEnv ?? process.env;
  const resolved = resolveAgentCliCommandForRuntime(resolveAgentCliRuntimeSpecForLookupId(agentId), {
    processEnv,
    isBunRuntime: isBun(),
    currentExecPath: process.execPath,
  });
  if (!resolved) return null;

  const runtimeCommand = resolveAgentCliJavaScriptRuntimeCommand(resolved.command, processEnv, {
    isBunRuntime: isBun(),
    currentExecPath: process.execPath,
  });

  if (!agentCliPathRequiresJavaScriptRuntime(resolved.command)) {
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

export function requireAgentCliLaunchSpec(
  agentId: CatalogAgentLookupId,
  opts: Readonly<{ processEnv?: NodeJS.ProcessEnv }> = {},
): AgentCliLaunchSpec {
  const resolved = resolveAgentCliLaunchSpec(agentId, opts);
  if (resolved) return resolved;
  throw new ReferenceError(buildMissingAgentCliCommandErrorMessage(agentId, opts));
}
