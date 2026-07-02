import { homedir } from 'node:os';
import { join } from 'node:path';

type EnvLike = Readonly<Record<string, string | undefined>>;

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
