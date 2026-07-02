import { buildHappyCliSubprocessLaunchSpec } from '@/utils/spawnHappyCLI';
import type { CatalogAgentId } from '@/backends/types';
import { createAllowedEnvKeySet, isAllowedEnvKey } from '@/utils/env/envKeyAllowlist';

type TmuxSpawnAgentId = CatalogAgentId | 'acp-catalog';

export function buildTmuxWindowEnv(
  daemonEnv: NodeJS.ProcessEnv,
  extraEnv: Record<string, string>,
  platform: NodeJS.Platform = process.platform,
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

  const allowedKeys = createAllowedEnvKeySet(essentialKeys, platform);
  const filteredDaemonEnv = Object.fromEntries(
    Object.entries(daemonEnv)
      .filter(([key, value]) => (
        isAllowedEnvKey(key, allowedKeys, platform)
        && typeof value === 'string'
        && value.length > 0
      )),
  ) as Record<string, string>;

  return { ...filteredDaemonEnv, ...extraEnv };
}

export function buildTmuxSpawnConfig(params: {
  agent: TmuxSpawnAgentId;
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
