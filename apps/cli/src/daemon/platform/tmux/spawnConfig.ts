import { buildHappyCliSubprocessLaunchSpec, type HappyCliSubprocessLaunchOptions } from '@/utils/spawnHappyCLI';
import type { CatalogAgentId } from '@/agent/catalog/ids';
import { createAllowedEnvKeySet, isAllowedEnvKey } from '@/utils/env/envKeyAllowlist';
import { buildScopedProcessEnv } from '@/utils/processEnv/buildScopedProcessEnv';
import { finalizeSessionChildEnvironment } from '@/session/runtime/control/finalizeSessionChildEnvironment';
import { selectTrustedSessionControlEnvironment } from '@/session/runtime/control/sessionControlEnvironment';
import { resolveStackProcessKindOverrideForSessionSpawn } from '@/daemon/spawn/resolveStackProcessKindOverrideForSessionSpawn';

type TmuxSpawnAgentId = CatalogAgentId | 'acp-catalog';

export function buildTmuxWindowEnv(
  daemonEnv: NodeJS.ProcessEnv,
  extraEnv: Record<string, string>,
  platform: NodeJS.Platform = process.platform,
  unsetEnvKeys?: readonly string[],
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

  const merged = buildScopedProcessEnv({
    baseEnv: filteredDaemonEnv,
    explicitEnv: extraEnv,
    unsetEnvKeys,
  });
  const stackProcessKindOverride = resolveStackProcessKindOverrideForSessionSpawn(daemonEnv);
  return finalizeSessionChildEnvironment({
    environment: merged,
    canonicalSessionControlEnvironment: selectTrustedSessionControlEnvironment(extraEnv),
    enableCgroupSelfMigration:
      String(daemonEnv.HAPPIER_DAEMON_STARTUP_SOURCE ?? '').trim() === 'background-service',
    stackProcessKind:
      stackProcessKindOverride.HAPPIER_STACK_PROCESS_KIND === 'session' ? 'session' : null,
  }) as Record<string, string>;
}

export function buildTmuxSpawnConfig(params: {
  agent: TmuxSpawnAgentId;
  directory: string;
  extraEnv: Record<string, string>;
  tmuxCommandEnv?: Record<string, string>;
  unsetEnvKeys?: readonly string[];
  extraArgs?: string[];
  launchOptions?: HappyCliSubprocessLaunchOptions;
}): {
  commandTokens: string[];
  tmuxEnv: Record<string, string>;
  tmuxCommandEnv: Record<string, string>;
  directory: string;
  unsetEnvKeys: readonly string[];
} {
  const args = [
    params.agent,
    '--happy-starting-mode',
    'remote',
    '--started-by',
    'daemon',
    ...(params.extraArgs ?? []),
  ];

  const launchSpec = buildHappyCliSubprocessLaunchSpec(args, params.launchOptions);
  const commandTokens = [launchSpec.filePath, ...launchSpec.args];

  const tmuxEnv = buildTmuxWindowEnv(
    process.env,
    { ...params.extraEnv, ...(launchSpec.env ?? {}) },
    process.platform,
    params.unsetEnvKeys,
  );

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
    unsetEnvKeys: params.unsetEnvKeys ?? [],
  };
}
