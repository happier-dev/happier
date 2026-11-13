import { homedir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { PluginError } from '@happier-dev/plugin-sdk';

type EnvLike = Readonly<Record<string, string | undefined>>;
export const GEMINI_NATIVE_PATH_ENV_KEYS = ['HOME', 'GEMINI_CLI_HOME', 'XDG_CONFIG_HOME',
  'GEMINI_CLI_SYSTEM_SETTINGS_PATH', 'GEMINI_CLI_SYSTEM_DEFAULTS_PATH'] as const;

/** Read native path selectors; callers without a host use the standalone process baseline. */
export function readGeminiNativePathEnvironment(
  values: EnvLike,
  unset: readonly string[],
  inherited: EnvLike = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const result: Record<string, string> = {};
  const readSelector = (env: EnvLike, key: string) => {
    if (platform !== 'win32') return env[key];
    // The host's Windows merge gives the last authored spelling authority.
    const name = Object.keys(env).filter(name => name.toUpperCase() === key).at(-1);
    return name === undefined ? undefined : env[name];
  };
  for (const key of GEMINI_NATIVE_PATH_ENV_KEYS) {
    if (unset.some(name => name.toUpperCase() === key)) continue;
    const value = readSelector(values, key) ?? readSelector(inherited, key);
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/** Native Gemini settings.ts owns these platform paths and selector semantics. */
export function resolveGeminiNativePolicyPaths(env: EnvLike, platform: NodeJS.Platform = process.platform) {
  const systemSettingsPath = env.GEMINI_CLI_SYSTEM_SETTINGS_PATH
    || (platform === 'darwin' ? '/Library/Application Support/GeminiCli/settings.json'
      : platform === 'win32' ? 'C:\\ProgramData\\gemini-cli\\settings.json' : '/etc/gemini-cli/settings.json');
  const pathApi = platform === 'win32' ? win32 : posix;
  const systemDefaultsPath = env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH
    || pathApi.join(pathApi.dirname(systemSettingsPath), 'system-defaults.json');
  if ([systemSettingsPath, systemDefaultsPath].some(path => !pathApi.isAbsolute(path)
    || (platform === 'win32' && pathApi.parse(path).root.length <= 1))) {
    throw new PluginError({ code: 'gemini_provider_auth_policy_unavailable', retryable: false,
      message: 'Gemini Provider binding requires fully qualified native System settings paths.' });
  }
  return { systemSettingsPath, systemDefaultsPath };
}

function readNonEmptyEnv(env: EnvLike, key: string): string | null {
  const value = env[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function resolveGeminiCliHome(env: EnvLike = process.env): string {
  return readNonEmptyEnv(env, 'GEMINI_CLI_HOME') ?? readNonEmptyEnv(env, 'HOME') ?? homedir();
}

export function resolveGeminiConfigPaths(env: EnvLike = process.env): Readonly<{
  cliHomeDir: string;
  geminiDir: string;
  xdgConfigHome: string;
  geminiXdgDir: string;
  userSettingsPath: string;
  userConfigPath: string;
  xdgConfigPath: string;
  userAuthPath: string;
  xdgAuthPath: string;
  userOauthCredsPath: string;
}> {
  const cliHomeDir = resolveGeminiCliHome(env);
  const xdgConfigHome = readNonEmptyEnv(env, 'XDG_CONFIG_HOME') ?? join(cliHomeDir, '.config');
  const geminiDir = join(cliHomeDir, '.gemini');
  const geminiXdgDir = join(xdgConfigHome, 'gemini');
  return {
    cliHomeDir,
    geminiDir,
    xdgConfigHome,
    geminiXdgDir,
    userSettingsPath: join(geminiDir, 'settings.json'),
    userConfigPath: join(geminiDir, 'config.json'),
    xdgConfigPath: join(geminiXdgDir, 'config.json'),
    userAuthPath: join(geminiDir, 'auth.json'),
    xdgAuthPath: join(geminiXdgDir, 'auth.json'),
    userOauthCredsPath: join(geminiDir, 'oauth_creds.json'),
  };
}
