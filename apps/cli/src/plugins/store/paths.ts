import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { configuration } from '../../configuration';

export type PluginStorePaths = Readonly<{
  happyHomeDir: string;
  rootDir: string;
  stateDir: string;
  registryCurrentFilePath: string;
  registryCommitLockFilePath: string;
  stateRevisionsDir: string;
  generationsDir: string;
  marketplaceSourceRegistryFilePath: string;
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
  const happyHomeDir = params?.happyHomeDir ?? configuration.happyHomeDir;
  const rootDir = join(happyHomeDir, 'plugins', 'plugins');
  const stateDir = join(rootDir, 'state');
  return Object.freeze({
    happyHomeDir,
    rootDir,
    stateDir,
    registryCurrentFilePath: join(stateDir, 'plugin-registry-current.v1.json'),
    registryCommitLockFilePath: join(stateDir, 'plugin-registry-commit.v1.lock'),
    stateRevisionsDir: join(rootDir, 'state-revisions'),
    generationsDir: join(rootDir, 'generations'),
    marketplaceSourceRegistryFilePath: join(stateDir, 'marketplace-source-registry.v1.json'),
    npmRegistryProfilesFilePath: join(stateDir, 'npm-registry-profiles.v1.json'),
    installedDir: join(rootDir, 'installed'),
    cacheDir: join(rootDir, 'cache'),
    logsDir: join(rootDir, 'logs'),
    locksDir: join(rootDir, 'locks'),
    storageDir: join(rootDir, 'storage'),
    secretsDir: join(rootDir, 'secrets'),
    settingsDir: join(rootDir, 'settings'),
  });
}

export async function ensurePluginStoreDirectories(params?: Readonly<{ happyHomeDir?: string }>): Promise<PluginStorePaths> {
  const paths = resolvePluginStorePaths(params);
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
