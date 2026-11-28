import { buildHappyCliSubprocessLaunchSpec, type HappyCliSubprocessLaunchOptions } from '@/utils/spawnHappyCLI';
import type { CatalogAgentId } from '@/backends/types';
import { buildSpawnChildProcessEnv, DAEMON_DECIDED_CHILD_ENV_KEYS } from '../../spawn/buildSpawnChildProcessEnv';
import type { HappierRuntimeServerContext } from '@/utils/env/resolveHappierRuntimeContextEnv';
import { DBUS_SESSION_BUS_ADDRESS_ENV_KEY } from '@/utils/env/linuxUserSessionEnv';
import { POSIX_USER_CACHE_ENV_KEYS } from '@/utils/env/userCacheEnvironment';
import { resolveSystemdUserSessionLaunchSpec } from '../linux/resolveSystemdUserSessionLaunchSpec';

type TmuxSpawnAgentId = CatalogAgentId | 'acp-catalog';

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
    DBUS_SESSION_BUS_ADDRESS_ENV_KEY,
    'XDG_RUNTIME_DIR',
  ] as const;

  const filteredDaemonEnv = Object.fromEntries(
    essentialKeys
      .map((key) => [key, daemonEnv[key]] as const)
      .filter(([, value]) => typeof value === 'string' && value.length > 0),
  ) as Record<string, string>;

  // tmux keeps its own environment across daemon restarts. An empty cache
  // path restores the tool's default instead of inheriting a stale path.
  const userCacheEnv = Object.fromEntries(POSIX_USER_CACHE_ENV_KEYS.map((key) => [key, daemonEnv[key] ?? '']));
  return { ...filteredDaemonEnv, ...userCacheEnv, ...extraEnv };
}

type HostedRunnerSpawnParams = {
  agent: TmuxSpawnAgentId;
  directory: string;
  extraEnv: Record<string, string>;
  startingMode?: 'local' | 'remote';
  tmuxCommandEnv?: Record<string, string>;
  extraArgs?: string[];
  launchOptions?: HappyCliSubprocessLaunchOptions;
  processEnv?: NodeJS.ProcessEnv;
  homeDir?: string;
  serverSelectionEnv?: HappierRuntimeServerContext;
};

export async function buildHostedRunnerSpawnConfig(params: HostedRunnerSpawnParams & Readonly<{
  host: 'tmux' | 'zellij' | 'herdr';
}>): Promise<{
  commandTokens: string[];
  tmuxEnv: Record<string, string>;
  childEnv: Record<string, string>;
  tmuxCommandEnv: Record<string, string>;
  directory: string;
}> {
  const args = [
    params.agent,
    '--happy-starting-mode',
    params.startingMode ?? 'remote',
    '--started-by',
    'daemon',
    ...(params.extraArgs ?? []),
  ];

  const launchSpec = buildHappyCliSubprocessLaunchSpec(args, params.launchOptions);
  const processEnv = params.processEnv ?? process.env;
  const extraEnv = { ...params.extraEnv, ...(launchSpec.env ?? {}) };
  // tmux's server environment may be stale; empty values explicitly mask inherited keys.
  const childEnv = buildSpawnChildProcessEnv({
    processEnv,
    extraEnv,
    homeDir: params.homeDir,
    serverSelectionEnv: params.serverSelectionEnv,
  });
  const daemonDecidedEnv = Object.fromEntries(
    DAEMON_DECIDED_CHILD_ENV_KEYS.map((key) => [key, childEnv[key] ?? '']),
  );
  const tmuxEnv = buildTmuxWindowEnv(processEnv, { ...extraEnv, ...daemonDecidedEnv });
  const fullChildEnv = {
    ...Object.fromEntries(Object.entries(childEnv).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
    ...daemonDecidedEnv,
  };
  const scopedLaunchSpec = await resolveSystemdUserSessionLaunchSpec({
    launchSpec,
    environment: params.host === 'tmux' ? tmuxEnv : fullChildEnv,
  });
  const effectiveLaunchSpec = scopedLaunchSpec ?? launchSpec;
  const commandTokens = [effectiveLaunchSpec.filePath, ...effectiveLaunchSpec.args];

  const tmuxCommandEnv: Record<string, string> = { ...(params.tmuxCommandEnv ?? {}) };
  const tmuxTmpDir = tmuxCommandEnv.TMUX_TMPDIR;
  if (typeof tmuxTmpDir !== 'string' || tmuxTmpDir.length === 0) {
    delete tmuxCommandEnv.TMUX_TMPDIR;
  }

  return {
    commandTokens,
    tmuxEnv: { ...tmuxEnv, ...(effectiveLaunchSpec.env ?? {}) },
    childEnv: { ...fullChildEnv, ...(effectiveLaunchSpec.env ?? {}) },
    tmuxCommandEnv,
    directory: params.directory,
  };
}

export async function buildTmuxSpawnConfig(params: HostedRunnerSpawnParams) {
  return await buildHostedRunnerSpawnConfig({ ...params, host: 'tmux' });
}
