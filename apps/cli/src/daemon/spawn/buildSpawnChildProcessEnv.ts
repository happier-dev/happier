import { stripNestedClaudeCodeEnv } from '@/utils/processEnv/stripNestedClaudeCodeEnv';

export function buildSpawnChildProcessEnv(params: {
  processEnv: NodeJS.ProcessEnv;
  extraEnv: Record<string, string | undefined>;
}): NodeJS.ProcessEnv {
  return stripNestedClaudeCodeEnv({ ...params.processEnv, ...params.extraEnv });
}

