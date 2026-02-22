import { buildHappyCliSubprocessLaunchSpec } from '@/utils/spawnHappyCLI';
import type { CatalogAgentId } from '@/backends/types';

export function buildTmuxWindowEnv(
  daemonEnv: NodeJS.ProcessEnv,
  extraEnv: Record<string, string>,
): Record<string, string> {
  const essentialKeys = [
    'PATH',
    'HOME',
    'SHELL',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TERM',
    'TMPDIR',
    'TSX_TSCONFIG_PATH',
    'USER',
    'LOGNAME',
  ] as const;

  const filteredDaemonEnv = Object.fromEntries(
    essentialKeys
      .map((key) => [key, daemonEnv[key]] as const)
      .filter(([, value]) => typeof value === 'string' && value.length > 0),
  ) as Record<string, string>;

  return { ...filteredDaemonEnv, ...extraEnv };
}

export function buildTmuxSpawnConfig(params: {
  agent: CatalogAgentId;
  directory: string;
  extraEnv: Record<string, string>;
  tmuxCommandEnv?: Record<string, string>;
  extraArgs?: string[];
}): {
  commandTokens: string[];
  tmuxEnv: Record<string, string>;
  tmuxCommandEnv: Record<string, string>;
  directory: string;
} {
  const args = [
    params.agent,
    '--happy-starting-mode',
    'remote',
    '--started-by',
    'daemon',
    ...(params.extraArgs ?? []),
  ];

  const launchSpec = buildHappyCliSubprocessLaunchSpec(args);
  const commandTokens = [launchSpec.filePath, ...launchSpec.args];

  const tmuxEnv = buildTmuxWindowEnv(process.env, { ...params.extraEnv, ...(launchSpec.env ?? {}) });

  const tmuxCommandEnv: Record<string, string> = { ...(params.tmuxCommandEnv ?? {}) };
  const tmuxTmpDir = tmuxCommandEnv.TMUX_TMPDIR;
  if (typeof tmuxTmpDir !== 'string' || tmuxTmpDir.length === 0) {
    delete tmuxCommandEnv.TMUX_TMPDIR;
  }

  return {
    commandTokens,
    tmuxEnv,
    tmuxCommandEnv,
    directory: params.directory,
  };
}
