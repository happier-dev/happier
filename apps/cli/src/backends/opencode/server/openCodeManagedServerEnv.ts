import { join } from 'node:path';

export function resolveOpenCodeManagedServerChildEnv(params: Readonly<{
  baseEnv: NodeJS.ProcessEnv;
  xdgRootDir: string | null;
  isolateConfig: boolean;
}>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...params.baseEnv,
    // Ensure the subprocess has a stable, explicit config envelope.
    OPENCODE_CONFIG_CONTENT: params.baseEnv.OPENCODE_CONFIG_CONTENT ?? '{}',
  };

  const xdgRootDir = typeof params.xdgRootDir === 'string' ? params.xdgRootDir.trim() : '';
  if (!xdgRootDir) return env;

  env.XDG_DATA_HOME = join(xdgRootDir, 'data');
  env.XDG_STATE_HOME = join(xdgRootDir, 'state');
  env.XDG_CACHE_HOME = join(xdgRootDir, 'cache');
  if (params.isolateConfig) {
    env.XDG_CONFIG_HOME = join(xdgRootDir, 'config');
  }
  return env;
}
