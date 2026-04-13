import { spawnSync } from 'node:child_process';

import type { AgentId } from '@happier-dev/agents';
import { resolveWindowsCommandInvocation } from '@happier-dev/cli-common/process';

import { requireProviderCliLaunchSpec } from '@/runtime/managedTools/requireProviderCliLaunchSpec';

const HELP_FLAGS = new Set(['-h', '--help']);
const VERSION_FLAGS = new Set(['-v', '--version']);

export function detectProviderCliInfoRequest(args: readonly string[]): '--help' | '--version' | null {
  if (args.some((arg) => HELP_FLAGS.has(arg))) return '--help';
  if (args.some((arg) => VERSION_FLAGS.has(arg))) return '--version';
  return null;
}

export function maybePassthroughProviderCliInfoRequest(params: Readonly<{
  agentId: AgentId;
  args: readonly string[];
  processEnv?: NodeJS.ProcessEnv;
}>): boolean {
  const flag = detectProviderCliInfoRequest(params.args);
  if (!flag) return false;

  const launch = requireProviderCliLaunchSpec(params.agentId, { processEnv: params.processEnv });
  const invocation = resolveWindowsCommandInvocation({
    command: launch.command,
    args: [...launch.args, flag],
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
