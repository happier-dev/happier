import { spawnSync } from 'node:child_process';

import type { AgentId } from '@happier-dev/agents';

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
  const result = spawnSync(launch.command, [...launch.args, flag], {
    env: params.processEnv ?? process.env,
    stdio: 'inherit',
    windowsHide: true,
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
