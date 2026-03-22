import { createHash } from 'node:crypto';
import { join } from 'node:path';

function resolveHappierScopedXdgConfigHome(baseEnv: NodeJS.ProcessEnv): string | null {
  const happierHomeDir = typeof baseEnv.HAPPIER_HOME_DIR === 'string' ? baseEnv.HAPPIER_HOME_DIR.trim() : '';
  if (happierHomeDir) {
    return join(happierHomeDir, '.config');
  }

  const explicitXdgConfigHome = typeof baseEnv.XDG_CONFIG_HOME === 'string' ? baseEnv.XDG_CONFIG_HOME.trim() : '';
  return explicitXdgConfigHome || null;
}

function resolveHostHomeDir(baseEnv: NodeJS.ProcessEnv): string | null {
  const explicitHomeDir = typeof baseEnv.HOME === 'string' ? baseEnv.HOME.trim() : '';
  if (explicitHomeDir) return explicitHomeDir;

  const explicitUserProfile = typeof baseEnv.USERPROFILE === 'string' ? baseEnv.USERPROFILE.trim() : '';
  return explicitUserProfile || null;
}

function resolveHostXdgDir(
  baseEnv: NodeJS.ProcessEnv,
  key: 'XDG_DATA_HOME' | 'XDG_STATE_HOME' | 'XDG_CACHE_HOME',
): string | null {
  const explicit = typeof baseEnv[key] === 'string' ? baseEnv[key].trim() : '';
  if (explicit) return explicit;

  const hostHomeDir = resolveHostHomeDir(baseEnv);
  if (!hostHomeDir) return null;

  switch (key) {
    case 'XDG_DATA_HOME':
      return join(hostHomeDir, '.local', 'share');
    case 'XDG_STATE_HOME':
      return join(hostHomeDir, '.local', 'state');
    case 'XDG_CACHE_HOME':
      return join(hostHomeDir, '.cache');
  }
}

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

  const happierScopedXdgConfigHome = resolveHappierScopedXdgConfigHome(params.baseEnv);
  if (happierScopedXdgConfigHome) {
    env.XDG_CONFIG_HOME = happierScopedXdgConfigHome;
  }

  const happierHomeDir = typeof params.baseEnv.HAPPIER_HOME_DIR === 'string' ? params.baseEnv.HAPPIER_HOME_DIR.trim() : '';
  if (happierHomeDir) {
    env.HOME = happierHomeDir;
    if (process.platform === 'win32') {
      env.USERPROFILE = happierHomeDir;
    }

    const hostXdgDataHome = resolveHostXdgDir(params.baseEnv, 'XDG_DATA_HOME');
    if (hostXdgDataHome) {
      env.XDG_DATA_HOME = hostXdgDataHome;
    }

    const hostXdgStateHome = resolveHostXdgDir(params.baseEnv, 'XDG_STATE_HOME');
    if (hostXdgStateHome) {
      env.XDG_STATE_HOME = hostXdgStateHome;
    }

    const hostXdgCacheHome = resolveHostXdgDir(params.baseEnv, 'XDG_CACHE_HOME');
    if (hostXdgCacheHome) {
      env.XDG_CACHE_HOME = hostXdgCacheHome;
    }
  }

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

export function resolveOpenCodeManagedServerLaunchFingerprint(params: Readonly<{
  baseEnv: NodeJS.ProcessEnv;
  xdgRootDir: string | null;
  isolateConfig: boolean;
}>): string {
  const env = resolveOpenCodeManagedServerChildEnv(params);
  const relevant = {
    HOME: typeof env.HOME === 'string' ? env.HOME : '',
    HAPPIER_HOME_DIR: typeof env.HAPPIER_HOME_DIR === 'string' ? env.HAPPIER_HOME_DIR : '',
    XDG_CONFIG_HOME: typeof env.XDG_CONFIG_HOME === 'string' ? env.XDG_CONFIG_HOME : '',
    XDG_DATA_HOME: typeof env.XDG_DATA_HOME === 'string' ? env.XDG_DATA_HOME : '',
    XDG_STATE_HOME: typeof env.XDG_STATE_HOME === 'string' ? env.XDG_STATE_HOME : '',
    XDG_CACHE_HOME: typeof env.XDG_CACHE_HOME === 'string' ? env.XDG_CACHE_HOME : '',
    OPENCODE_CONFIG_CONTENT: typeof env.OPENCODE_CONFIG_CONTENT === 'string' ? env.OPENCODE_CONFIG_CONTENT : '',
    OPENAI_API_KEY: typeof env.OPENAI_API_KEY === 'string' ? env.OPENAI_API_KEY : '',
    ANTHROPIC_API_KEY: typeof env.ANTHROPIC_API_KEY === 'string' ? env.ANTHROPIC_API_KEY : '',
    OPENCODE_SERVER_USERNAME: typeof env.OPENCODE_SERVER_USERNAME === 'string' ? env.OPENCODE_SERVER_USERNAME : '',
    OPENCODE_SERVER_PASSWORD: typeof env.OPENCODE_SERVER_PASSWORD === 'string' ? env.OPENCODE_SERVER_PASSWORD : '',
  };

  return createHash('sha256').update(JSON.stringify(relevant)).digest('hex');
}
