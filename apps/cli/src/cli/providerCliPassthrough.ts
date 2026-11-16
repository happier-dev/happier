import { spawnSync } from 'node:child_process';
import { writeSync } from 'node:fs';

import { resolveWindowsCommandInvocation } from '@happier-dev/cli-common/process';
import type { CatalogAgentLookupId } from '@/agent/catalog/ids';
import { sessionProcessEnvironment, sessionWorkingDirectory } from '@/agent/runtime/lifecycle/hostedSessionScope';

import { requireAgentCliLaunchSpec } from '@/packagedRuntime/managedTools/requireAgentCliLaunchSpec';
import { detectProviderCliInfoRequest } from './providerCliInfoRequest';
export {
  detectProviderCliInfoRequest,
  isProviderCliInfoCommandPrefixRequest,
  type ProviderCliInfoCommandPrefix,
} from './providerCliInfoRequest';

const PROVIDER_CLI_PASSTHROUGH_MAX_BUFFER = 16 * 1024 * 1024;

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
  const processEnv = params.processEnv ?? sessionProcessEnvironment();
  const launch = requireAgentCliLaunchSpec(params.agentId, { processEnv });
  const invocation = resolveWindowsCommandInvocation({
    command: launch.command,
    args: [...launch.args, ...params.providerArgs],
    env: processEnv,
    resolveCommandOnPath: false,
  });
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: sessionWorkingDirectory(),
    env: processEnv,
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
