import { dirname, join } from 'node:path';

import { configuration } from '../../configuration';
import { resolvePluginStorePathLayout } from './pathLayout';
import { ensurePluginGenerationDirectories } from './generationDirectories';
import { ensurePrivateDirectoryPreservingTraversal, ensureProtectedLocalStateDirectory } from '@/utils/fs/protectedLocalState';

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
  await ensurePrivateDirectoryPreservingTraversal(dirname(paths.rootDir));
  await ensurePrivateDirectoryPreservingTraversal(paths.rootDir);
  await ensurePluginGenerationDirectories(paths);
  await Promise.all([
    paths.stateDir, paths.stateRevisionsDir, paths.installedDir, paths.cacheDir,
    paths.logsDir, paths.locksDir, paths.storageDir, paths.secretsDir, paths.settingsDir,
  ].map(path => ensureProtectedLocalStateDirectory(path, { authority: 'owned' })));
  return paths;
}
