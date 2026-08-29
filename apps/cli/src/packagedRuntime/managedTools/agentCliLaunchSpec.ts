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

  // This launch spec is consumed by direct child_process spawns (shell: false).
  // On Windows a JS runtime that resolves to a .cmd wrapper (the managed
  // runtime wrapper) cannot be spawned that way, so reuse the direct-runtime
  // resolver to launch the underlying managed runtime binary
  // (runtime/node.exe) instead. There is deliberately no cmd.exe/shell/PATH
  // fallback here: a runtime command that cannot resolve directly keeps the
  // previously resolved command and fails at spawn, as before.
  const launchCommand =
    process.platform === 'win32' && isWindowsShellShimPath(runtimeCommand)
      ? (resolveDirectJavaScriptRuntimeCommand({
          isBunRuntime: isBun(),
          processEnv,
          currentExecPath: process.execPath,
        }) ?? runtimeCommand)
      : runtimeCommand;

  return {
    source: resolved.source,
    resolvedPath: resolved.command,
    command: launchCommand,
    args: [resolved.command],
  };
}
