import { stripNestedSessionDetectionEnv } from '@/utils/processEnv/stripNestedSessionDetectionEnv';

export function buildSpawnChildProcessEnv(params: {
  processEnv: NodeJS.ProcessEnv;
  extraEnv: Record<string, string | undefined>;
}): NodeJS.ProcessEnv {
  const env = stripNestedSessionDetectionEnv({ ...params.processEnv, ...params.extraEnv });
  delete env.HAPPIER_SESSION_AUTOSTART_DAEMON;
  if (String(params.processEnv.HAPPIER_DAEMON_STARTUP_SOURCE ?? '').trim() === 'background-service') {
    env.HAPPIER_DAEMON_SPAWN_SELF_MIGRATE_CGROUP = '1';
  } else {
    delete env.HAPPIER_DAEMON_SPAWN_SELF_MIGRATE_CGROUP;
  }
  return env;
}
