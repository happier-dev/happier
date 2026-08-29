import { homedir } from 'node:os';
import { isAbsolute, join, normalize, resolve } from 'node:path';

import { resolveRelayRuntimeDefaults } from '../relayRuntime.js';

export type PersonalHomeRuntimeLayout = Readonly<{
  installRoot: string;
  configDir: string;
  dataDir: string;
  databasePath: string;
  publicFilesDir: string;
  privateFilesDir: string;
  masterSecretPath: string;
  backupsDir: string;
  derivedDataDir: string;
  logsDir: string;
  // These fields are retained while the in-flight operations lane consumes this shape.
  irohEndpointKeyPath: string;
  mode: 'user' | 'system';
  platform: NodeJS.Platform;
}>;

export function resolvePersonalHomeRuntimeLayout(params: Readonly<{
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
  mode?: 'user' | 'system';
}> = {}): PersonalHomeRuntimeLayout {
  const env = params.env ?? process.env;
  const platform = params.platform ?? process.platform;
  const mode = params.mode ?? 'user';
  const fallbackHome = params.homeDir ?? homedir();
  const defaults = resolveRelayRuntimeDefaults({ platform, mode, channel: 'stable', homeDir: fallbackHome });
  const installRoot = resolve(String(env.HAPPIER_SELF_HOST_INSTALL_ROOT ?? defaults.installRoot));
  const configDir = resolve(String(env.HAPPIER_SELF_HOST_CONFIG_DIR ?? defaults.configDir));
  const dataDir = resolve(String(env.HAPPIER_SERVER_LIGHT_DATA_DIR ?? env.HAPPY_SERVER_LIGHT_DATA_DIR ?? defaults.dataDir));
  const filesDir = resolve(String(env.HAPPIER_SERVER_LIGHT_FILES_DIR ?? env.HAPPY_SERVER_LIGHT_FILES_DIR ?? join(dataDir, 'files')));
  const databasePath = resolve(String(env.HAPPIER_SERVER_LIGHT_DATABASE_PATH ?? join(dataDir, 'happier-server-light.sqlite')));
  const logsDir = resolve(String(env.HAPPIER_SELF_HOST_LOG_DIR ?? defaults.logDir));
  const privateFilesDir = resolve(join(filesDir, 'private'));
  return Object.freeze({ installRoot, configDir, dataDir, databasePath, publicFilesDir: filesDir, privateFilesDir,
    masterSecretPath: resolve(join(dataDir, 'handy-master-secret.txt')),
    backupsDir: resolve(join(dataDir, 'backups')), derivedDataDir: resolve(join(dataDir, 'derived')), logsDir,
    irohEndpointKeyPath: resolve(join(dataDir, 'runtime', 'iroh', 'endpoint.key')), mode, platform });
}

export function assertLayoutPath(layout: PersonalHomeRuntimeLayout, path: string): string {
  const root = normalize(resolve(layout.dataDir));
  const candidate = normalize(resolve(path));
  if (candidate !== root && !candidate.startsWith(`${root}/`) && !candidate.startsWith(`${root}\\`)) {
    throw new Error('Personal Home path escapes data root');
  }
  return candidate;
}
