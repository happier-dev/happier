import {
  agentCliPathRequiresJavaScriptRuntime,
  resolveAgentCliJavaScriptRuntimeCommand,
  resolveAgentCliCommandForRuntime,
  type AgentCliCommandResolution,
  type AgentCliRuntimeDescriptor,
} from '@happier-dev/cli-common/agents/resolution';
import { resolveDirectJavaScriptRuntimeCommand } from '@happier-dev/cli-common/agents/managedJavaScriptRuntime';
import { isWindowsShellShimPath } from '@happier-dev/cli-common/process';
import { sessionProcessEnvironment, sessionWorkingDirectory } from '@/agent/runtime/lifecycle/hostedSessionScope';

import { resolveCliRuntimeAssetPath } from '../assets/resolveCliRuntimeAssetPath';
import { isBun } from '../../utils/runtime';

export type AgentCliLaunchSpec = Readonly<{
  source: AgentCliCommandResolution['source'];
  resolvedPath: string;
  command: string;
  args: readonly string[];
  /** The builder launches the provider in this process rather than a shell-shim child. */
  providerExitOwnership?: 'direct';
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
      ...(params.spec.providerExitOwnership ? { providerExitOwnership: params.spec.providerExitOwnership } : {}),
    }),
  });
}

export function resolveAgentCliLaunchSpecForRuntime(
  runtimeSpec: AgentCliRuntimeDescriptor,
  opts: Readonly<{ processEnv?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; cwd?: string }> = {},
): AgentCliLaunchSpec | null {
  const processEnv = opts.processEnv ?? sessionProcessEnvironment();
  const cwd = opts.cwd ?? sessionWorkingDirectory();
  const resolved = resolveAgentCliCommandForRuntime(runtimeSpec, {
    processEnv,
    cwd,
    isBunRuntime: isBun(),
    currentExecPath: process.execPath,
  });
  if (!resolved) return null;
  return buildAgentCliLaunchSpecFromResolution(resolved, { processEnv, platform: opts.platform, cwd });
}

/**
 * Builds the launch spec for one already-admitted CLI resolution.
 *
 * A composition that resolved its executable under a request-scoped policy —
 * the temporary-computer Runner's `managed_only` preparation — launches through
 * this entry so the admitted command survives unchanged. Resolving again at
 * launch would let an endpoint override or system install substitute itself
 * between readiness and launch.
 */
export function buildAgentCliLaunchSpecFromResolution(
  resolved: AgentCliCommandResolution,
  opts: Readonly<{ processEnv?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; cwd?: string }> = {},
): AgentCliLaunchSpec | null {
  const processEnv = opts.processEnv ?? sessionProcessEnvironment();
  const platform = opts.platform ?? process.platform;

  if (platform === 'win32' && isWindowsShellShimPath(resolved.command)) {
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
    cwd: opts.cwd ?? sessionWorkingDirectory(),
    isBunRuntime: isBun(),
    currentExecPath: process.execPath,
  });

  if (!agentCliPathRequiresJavaScriptRuntime(resolved.command)) {
    return {
      source: resolved.source,
      resolvedPath: resolved.command,
      command: resolved.command,
      args: [],
      providerExitOwnership: 'direct',
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
    platform === 'win32' && isWindowsShellShimPath(runtimeCommand)
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
    providerExitOwnership: 'direct',
  };
}
