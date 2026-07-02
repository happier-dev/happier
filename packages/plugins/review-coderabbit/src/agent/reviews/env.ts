import { join } from 'node:path';

export function buildCodeRabbitEnv(params: Readonly<{
  baseEnv: Readonly<Record<string, string | undefined>>;
  homeDir: string | null | undefined;
}>): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = { ...params.baseEnv };
  const homeDir = String(params.homeDir ?? '').trim();
  if (!homeDir) return merged;

  merged.CODERABBIT_HOME = join(homeDir, '.coderabbit');
  merged.XDG_CONFIG_HOME = join(homeDir, '.config');
  merged.XDG_CACHE_HOME = join(homeDir, '.cache');
  merged.XDG_STATE_HOME = join(homeDir, '.local', 'state');
  merged.XDG_DATA_HOME = join(homeDir, '.local', 'share');
  return merged;
}
