import type { SpawnOptions } from 'node:child_process';

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
  return {
    command: params.command,
    args: (params.args ?? []).map((a) => String(a)),
    options: {
      cwd: params.cwd,
      env: params.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(process.platform === 'win32' ? { windowsHide: true } : null),
    },
  };
}

