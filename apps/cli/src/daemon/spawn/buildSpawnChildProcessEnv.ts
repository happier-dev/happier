import { stripNestedSessionDetectionEnv } from '@/utils/processEnv/stripNestedSessionDetectionEnv';

export function buildSpawnChildProcessEnv(params: {
  processEnv: NodeJS.ProcessEnv;
  extraEnv: Record<string, string | undefined>;
}): NodeJS.ProcessEnv {
  return stripNestedSessionDetectionEnv({ ...params.processEnv, ...params.extraEnv });
}
