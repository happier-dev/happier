import {
  agentCliPathRequiresJavaScriptRuntime,
  resolveAgentCliJavaScriptRuntimeCommand,
  resolveAgentCliCommandForRuntime,
  type AgentCliCommandResolution,
  type AgentCliRuntimeDescriptor,
} from '@happier-dev/cli-common/agents';

import { isBun } from '../../utils/runtime';

export type AgentCliLaunchSpec = Readonly<{
  source: AgentCliCommandResolution['source'];
  resolvedPath: string;
  command: string;
  args: readonly string[];
}>;

export function resolveAgentCliLaunchSpecForRuntime(
  runtimeSpec: AgentCliRuntimeDescriptor,
  opts: Readonly<{ processEnv?: NodeJS.ProcessEnv }> = {},
): AgentCliLaunchSpec | null {
  const processEnv = opts.processEnv ?? process.env;
  const resolved = resolveAgentCliCommandForRuntime(runtimeSpec, {
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
