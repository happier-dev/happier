import { spawnSync } from 'node:child_process';

import { AGENTS_CORE, type AgentCore, type AgentId } from '@happier-dev/agents';
import { resolveWindowsCommandInvocation } from '@happier-dev/cli-common/process';

import { requireProviderCliLaunchSpec } from '@/runtime/managedTools/requireProviderCliLaunchSpec';

const HELP_FLAGS = new Set(['-h', '--help']);
const VERSION_FLAGS = new Set(['-v', '--version']);

type NativeCliPassthroughSupport = Pick<AgentCore, 'id' | 'nativeCliPassthroughSubcommands'>;

const NATIVE_CLI_PASSTHROUGH_SUPPORT_BY_AGENT: Readonly<Record<AgentId, NativeCliPassthroughSupport>> = AGENTS_CORE;

function resolveNativeProviderArgs(agentId: AgentId, args: readonly string[]): string[] | null {
  const supported = NATIVE_CLI_PASSTHROUGH_SUPPORT_BY_AGENT[agentId].nativeCliPassthroughSubcommands ?? [];
  if (supported.length === 0) return null;

  const providerArgs = args[0] === agentId ? args.slice(1) : args;
  const subcommand = providerArgs[0];
  if (!subcommand || !supported.includes(subcommand)) return null;
  return [...providerArgs];
}

export function detectProviderCliInfoRequest(args: readonly string[]): '--help' | '--version' | null {
  if (args.some((arg) => HELP_FLAGS.has(arg))) return '--help';
  if (args.some((arg) => VERSION_FLAGS.has(arg))) return '--version';
  return null;
}

function passthroughProviderCli(params: Readonly<{
  agentId: AgentId;
  providerArgs: readonly string[];
  processEnv?: NodeJS.ProcessEnv;
}>): boolean {
  const launch = requireProviderCliLaunchSpec(params.agentId, { processEnv: params.processEnv });
  const invocation = resolveWindowsCommandInvocation({
    command: launch.command,
    args: [...launch.args, ...params.providerArgs],
    env: params.processEnv ?? process.env,
    resolveCommandOnPath: false,
  });
  const result = spawnSync(invocation.command, invocation.args, {
    env: params.processEnv ?? process.env,
    stdio: 'inherit',
    windowsHide: true,
    ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });

  if (result.error) {
    throw result.error;
  }
  if (typeof result.status === 'number' && result.status !== 0) {
    process.exit(result.status);
  }
  if (result.signal) {
    process.exit(1);
  }
  return true;
}

export function maybePassthroughProviderCliInfoRequest(params: Readonly<{
  agentId: AgentId;
  args: readonly string[];
  processEnv?: NodeJS.ProcessEnv;
}>): boolean {
  const nativeProviderArgs = resolveNativeProviderArgs(params.agentId, params.args);
  if (nativeProviderArgs) {
    return passthroughProviderCli({
      agentId: params.agentId,
      providerArgs: nativeProviderArgs,
      processEnv: params.processEnv,
    });
  }

  const flag = detectProviderCliInfoRequest(params.args);
  if (!flag) return false;

  return passthroughProviderCli({
    agentId: params.agentId,
    providerArgs: [flag],
    processEnv: params.processEnv,
  });
}
