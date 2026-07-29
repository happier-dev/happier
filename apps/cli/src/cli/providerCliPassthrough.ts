import { spawnSync } from 'node:child_process';
import { writeSync } from 'node:fs';

import { resolveWindowsCommandInvocation } from '@happier-dev/cli-common/process';
import type { CatalogAgentLookupId } from '@/agent/catalog/ids';

import { requireAgentCliLaunchSpec } from '@/packagedRuntime/managedTools/requireAgentCliLaunchSpec';

const HELP_FLAGS = new Set(['-h', '--help']);
const VERSION_FLAGS = new Set(['-v', '-V', '--version']);
const PROVIDER_CLI_PASSTHROUGH_MAX_BUFFER = 16 * 1024 * 1024;

export type ProviderCliInfoCommandPrefix = readonly string[];

function matchesInfoCommandPrefix(args: readonly string[], prefix: ProviderCliInfoCommandPrefix): boolean {
  if (prefix.length === 0 || args.length < prefix.length) return false;
  return prefix.every((part, index) => args[index] === part);
}

export function detectProviderCliInfoRequest(args: readonly string[]): string | null {
  const helpFlag = args.find((arg) => HELP_FLAGS.has(arg));
  if (helpFlag) return helpFlag;
  const versionFlag = args.find((arg) => VERSION_FLAGS.has(arg));
  if (versionFlag) return versionFlag;
  return null;
}

export function isProviderCliInfoCommandPrefixRequest(params: Readonly<{
  args: readonly string[];
  prefixes: readonly ProviderCliInfoCommandPrefix[];
}>): boolean {
  return params.prefixes.some((prefix) => matchesInfoCommandPrefix(params.args, prefix));
}

function writeProviderCliPassthroughOutput(
  fd: 1 | 2,
  output: Buffer | string | null | undefined,
): void {
  if (typeof output === 'string') {
    if (output.length > 0) writeSync(fd, output);
    return;
  }
  if (Buffer.isBuffer(output) && output.length > 0) {
    writeSync(fd, output);
  }
}

export function passthroughProviderCliArgs(params: Readonly<{
  agentId: CatalogAgentLookupId;
  providerArgs: readonly string[];
  processEnv?: NodeJS.ProcessEnv;
}>): void {
  const launch = requireAgentCliLaunchSpec(params.agentId, { processEnv: params.processEnv });
  const invocation = resolveWindowsCommandInvocation({
    command: launch.command,
    args: [...launch.args, ...params.providerArgs],
    env: params.processEnv ?? process.env,
    resolveCommandOnPath: false,
  });
  const result = spawnSync(invocation.command, invocation.args, {
    env: params.processEnv ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: PROVIDER_CLI_PASSTHROUGH_MAX_BUFFER,
    windowsHide: true,
    ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });

  writeProviderCliPassthroughOutput(1, result.stdout);
  writeProviderCliPassthroughOutput(2, result.stderr);

  if (result.error) {
    throw result.error;
  }
  if (typeof result.status === 'number' && result.status !== 0) {
    process.exit(result.status);
  }
  if (result.signal) {
    process.exit(1);
  }
}

export function maybePassthroughProviderCliInfoRequest(params: Readonly<{
  agentId: CatalogAgentLookupId;
  args: readonly string[];
  processEnv?: NodeJS.ProcessEnv;
}>): boolean {
  const flag = detectProviderCliInfoRequest(params.args);
  if (!flag) return false;

  passthroughProviderCliArgs({
    agentId: params.agentId,
    providerArgs: [flag],
    processEnv: params.processEnv,
  });
  return true;
}
