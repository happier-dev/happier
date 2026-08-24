import {
  agentCliPathRequiresJavaScriptRuntime,
  resolveAgentCliJavaScriptRuntimeCommand,
  resolveAgentCliCommandForRuntime,
  type AgentCliCommandResolution,
  type AgentCliRuntimeDescriptor,
} from '@happier-dev/cli-common/agents/resolution';
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

/**
 * A non-secret, in-memory binding of one admitted CLI launch to the Agent
 * contribution that is allowed to consume it. This never carries the source
 * environment that selected the CLI.
 */
export type BoundAgentCliLaunchSpec = Readonly<{
  localAgentId: string;
  spec: AgentCliLaunchSpec;
}>;

export function bindAgentCliLaunchSpec(params: Readonly<{
  localAgentId: string;
  spec: AgentCliLaunchSpec;
}>): BoundAgentCliLaunchSpec {
  return Object.freeze({
    localAgentId: params.localAgentId,
    spec: Object.freeze({
      source: params.spec.source,
      resolvedPath: params.spec.resolvedPath,
      command: params.spec.command,
      args: Object.freeze([...params.spec.args]),
    }),
  });
}

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
