import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { configuration } from '@/configuration';

export type PluginStorePaths = Readonly<{
  happyHomeDir: string;
  rootDir: string;
  stateDir: string;
  stateFilePath: string;
  installedDir: string;
  cacheDir: string;
  logsDir: string;
  locksDir: string;
}>;

export const PLUGIN_MANIFEST_RELATIVE_PATH = join('.happier-plugin', 'plugin.json');

export function resolvePluginStorePaths(params?: Readonly<{ happyHomeDir?: string }>): PluginStorePaths {
  const happyHomeDir = params?.happyHomeDir ?? configuration.happyHomeDir;
  const rootDir = join(happyHomeDir, 'extensions', 'plugins');
  const stateDir = join(rootDir, 'state');
  return Object.freeze({
    happyHomeDir,
    rootDir,
    stateDir,
    stateFilePath: join(stateDir, 'plugin-state.v1.json'),
    installedDir: join(rootDir, 'installed'),
    cacheDir: join(rootDir, 'cache'),
    logsDir: join(rootDir, 'logs'),
    locksDir: join(rootDir, 'locks'),
  });
}

export async function ensurePluginStoreDirectories(params?: Readonly<{ happyHomeDir?: string }>): Promise<PluginStorePaths> {
  const paths = resolvePluginStorePaths(params);
  await Promise.all([
    mkdir(paths.stateDir, { recursive: true }),
    mkdir(paths.installedDir, { recursive: true }),
    mkdir(paths.cacheDir, { recursive: true }),
    mkdir(paths.logsDir, { recursive: true }),
    mkdir(paths.locksDir, { recursive: true }),
  ]);
  return paths;
}
