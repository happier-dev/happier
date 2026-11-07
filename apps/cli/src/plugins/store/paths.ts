import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { configuration } from '../../configuration';
import { resolvePluginStorePathLayout } from './pathLayout';
import { ensureProtectedLocalStateDirectory } from '@/utils/fs/protectedLocalState';

export type PluginStorePaths = Readonly<{
  happyHomeDir: string;
  rootDir: string;
  stateDir: string;
  registryCurrentFilePath: string;
  registryCommitLockFilePath: string;
  stateRevisionsDir: string;
  generationsDir: string;
  npmRegistryProfilesFilePath: string;
  installedDir: string;
  cacheDir: string;
  logsDir: string;
  locksDir: string;
  storageDir: string;
  secretsDir: string;
  settingsDir: string;
}>;

export const PLUGIN_MANIFEST_RELATIVE_PATH = join('.happier-plugin', 'plugin.json');

export function resolvePluginStorePaths(params?: Readonly<{ happyHomeDir?: string }>): PluginStorePaths {
  return resolvePluginStorePathLayout(params?.happyHomeDir ?? configuration.happyHomeDir);
}
export async function ensurePluginStoreDirectories(params?: Readonly<{ happyHomeDir?: string }>): Promise<PluginStorePaths> {
  const paths = resolvePluginStorePaths(params);
  await ensureProtectedLocalStateDirectory(dirname(paths.rootDir), { authority: 'owned' });
  await Promise.all([
    mkdir(paths.stateDir, { recursive: true }),
    mkdir(paths.stateRevisionsDir, { recursive: true }),
    mkdir(paths.generationsDir, { recursive: true }),
    mkdir(paths.installedDir, { recursive: true }),
    mkdir(paths.cacheDir, { recursive: true }),
    mkdir(paths.logsDir, { recursive: true }),
    mkdir(paths.locksDir, { recursive: true }),
    mkdir(paths.storageDir, { recursive: true }),
    mkdir(paths.secretsDir, { recursive: true }),
    mkdir(paths.settingsDir, { recursive: true }),
  ]);
  return paths;
}
