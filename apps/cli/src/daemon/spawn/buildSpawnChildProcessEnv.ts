import { stripNestedSessionDetectionEnv } from '@/utils/processEnv/stripNestedSessionDetectionEnv';

export function buildSpawnChildProcessEnv(params: {
  processEnv: NodeJS.ProcessEnv;
  extraEnv: Record<string, string | undefined>;
}): NodeJS.ProcessEnv {
  const env = stripNestedSessionDetectionEnv({ ...params.processEnv, ...params.extraEnv });
  delete env.HAPPIER_SESSION_AUTOSTART_DAEMON;
  return env;
}
