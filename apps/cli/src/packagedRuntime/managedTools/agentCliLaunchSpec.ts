import {
  agentCliPathRequiresJavaScriptRuntime,
  resolveAgentCliJavaScriptRuntimeCommand,
  resolveAgentCliCommandForRuntime,
  type AgentCliCommandResolution,
  type AgentCliRuntimeDescriptor,
} from '@happier-dev/cli-common/agents';
import { resolveDirectJavaScriptRuntimeCommand } from '@happier-dev/cli-common/agents/managedJavaScriptRuntime';
import { isWindowsShellShimPath } from '@happier-dev/cli-common/process';

import { resolveCliRuntimeAssetPath } from '../assets/resolveCliRuntimeAssetPath';
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

  if (process.platform === 'win32' && isWindowsShellShimPath(resolved.command)) {
    const runnerPath = resolveCliRuntimeAssetPath(
      'scripts',
      'agent_cli_windows_shim_runner.cjs',
    );
    const runtimeCommand = resolveDirectJavaScriptRuntimeCommand({
      isBunRuntime: isBun(),
      processEnv,
      currentExecPath: process.execPath,
    });
    if (!runtimeCommand) return null;
    return {
      source: resolved.source,
      resolvedPath: resolved.command,
      command: runtimeCommand,
      args: [runnerPath, resolved.command],
    };
  }

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
