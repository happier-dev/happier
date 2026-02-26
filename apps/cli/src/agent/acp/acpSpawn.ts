import type { SpawnOptions } from 'node:child_process';

import { resolveWindowsCommandInvocation } from '@happier-dev/cli-common/process';

export type AcpSpawnSpec = {
  command: string;
  args: string[];
  options: SpawnOptions;
};

export function buildAcpSpawnSpec(params: {
  command: string;
  args: readonly unknown[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): AcpSpawnSpec {
  const args = (params.args ?? []).map((a) => String(a));
  const invocation = resolveWindowsCommandInvocation({
    command: params.command,
    args,
    env: params.env,
    resolveCommandOnPath: true,
  });

  return {
    command: invocation.command,
    args: invocation.args,
    options: {
      cwd: params.cwd,
      env: params.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(process.platform === 'win32'
        ? { windowsHide: true, windowsVerbatimArguments: invocation.windowsVerbatimArguments }
        : null),
    },
  };
}
