import { moveProcessOutOfDaemonServiceCgroup } from './migrateTrackedSessionsOutOfDaemonServiceCgroup';

export const HAPPIER_DAEMON_SPAWN_SELF_MIGRATE_CGROUP_ENV_KEY = 'HAPPIER_DAEMON_SPAWN_SELF_MIGRATE_CGROUP';

function isTruthyEnvFlag(raw: string | undefined): boolean {
  const normalized = (raw ?? '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'y';
}

export async function selfMigrateDaemonSpawnedSessionProcessOutOfDaemonServiceCgroup(params: Readonly<{
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  pid?: number;
  procfsRootDir?: string;
  cgroupRootDir?: string;
}> = {}): Promise<Awaited<ReturnType<typeof moveProcessOutOfDaemonServiceCgroup>>> {
  const env = params.env ?? process.env;
  const enabled = isTruthyEnvFlag(env[HAPPIER_DAEMON_SPAWN_SELF_MIGRATE_CGROUP_ENV_KEY]);
  delete env[HAPPIER_DAEMON_SPAWN_SELF_MIGRATE_CGROUP_ENV_KEY];

  if (!enabled) {
    return null;
  }
  if ((params.platform ?? process.platform) !== 'linux') {
    return null;
  }

  const pid = params.pid ?? process.pid;
  return await moveProcessOutOfDaemonServiceCgroup({
    pid,
    daemonPid: pid,
    procfsRootDir: params.procfsRootDir,
    cgroupRootDir: params.cgroupRootDir,
  });
}
