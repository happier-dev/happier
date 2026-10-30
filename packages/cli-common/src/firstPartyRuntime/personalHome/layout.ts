import { homedir } from 'node:os';
import { normalize, posix, resolve, win32 } from 'node:path';

import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import { resolveRelayRuntimeDefaults } from '../relayRuntime.js';
import { expandHomeDirPath } from '../../path/expandHomeDirPath.js';
import {
  resolveManagedServerLightPathEnvValue,
  resolvePersonalHomePrivateFilesDir,
  resolvePersonalHomeSqliteDatabasePath,
} from './pathResolvers.js';

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

/** Exact runtime-owned files which may be left alongside the durable Home data.
 * Keep this list at the layout owner so lifecycle writers and destructive
 * operations cannot drift into similar-but-different paths. */
export type PersonalHomeRuntimeArtifactPaths = Readonly<{
  startupReceiptPath: string;
  irohEndpointDescriptorPath: string;
  homeConnectionDescriptorPath: string;
  updateRecoveryPath: string;
  restoreJournalPath: string;
  relocationSourcePath: string;
  relocationDestinationPath: string;
  operationLockPath: string;
}>;

type HomeRuntimeLayoutOptions = Readonly<{
  env?: Readonly<Record<string, string | undefined>>;
  homeDir?: string;
  platform?: NodeJS.Platform;
  mode?: 'user' | 'system';
  channel?: PublicReleaseRingId;
}>;

function resolveHomeRuntimeDataPaths(params: HomeRuntimeLayoutOptions) {
  const env = params.env ?? process.env;
  const platform = params.platform ?? process.platform;
  const mode = params.mode ?? 'user';
  const fallbackHome = params.homeDir ?? homedir();
  const pathEnv = platform === 'win32'
    ? { ...env, USERPROFILE: fallbackHome }
    : { ...env, HOME: fallbackHome };
  const defaults = resolveRelayRuntimeDefaults({ platform, mode, channel: params.channel ?? 'stable', homeDir: fallbackHome });
  const api = platform === 'win32' ? win32 : posix;
  const absolute = (value: string): string => api.resolve(expandHomeDirPath(value, pathEnv, platform));
  const installRoot = absolute(String(env.HAPPIER_SELF_HOST_INSTALL_ROOT ?? defaults.installRoot));
  const configDir = absolute(String(env.HAPPIER_SELF_HOST_CONFIG_DIR ?? defaults.configDir));
  const dataDir = absolute(
    resolveManagedServerLightPathEnvValue(env, 'HAPPIER_SERVER_LIGHT_DATA_DIR', 'HAPPY_SERVER_LIGHT_DATA_DIR')
      || defaults.dataDir,
  );
  return { env, pathEnv, platform, mode, defaults, api, absolute, installRoot, configDir, dataDir };
}

/** The transport key belongs to every Home, independently of its database provider. */
export function resolveHomeIrohEndpointKeyPath(params: HomeRuntimeLayoutOptions = {}): string {
  const { api, dataDir } = resolveHomeRuntimeDataPaths(params);
  return api.resolve(api.join(dataDir, 'runtime', 'iroh', 'endpoint.key'));
}

export function resolvePersonalHomeRuntimeLayout(params: HomeRuntimeLayoutOptions = {}): PersonalHomeRuntimeLayout {
  const { env, pathEnv, platform, mode, defaults, api, absolute, installRoot, configDir, dataDir } = resolveHomeRuntimeDataPaths(params);
  const filesDir = absolute(
    resolveManagedServerLightPathEnvValue(env, 'HAPPIER_SERVER_LIGHT_FILES_DIR', 'HAPPY_SERVER_LIGHT_FILES_DIR')
      || api.join(dataDir, 'files'),
  );
  const databasePath = resolvePersonalHomeSqliteDatabasePath({ dataDir, env: pathEnv, platform });
  const logsDir = absolute(String(env.HAPPIER_SELF_HOST_LOG_DIR ?? defaults.logDir));
  const privateFilesDir = resolvePersonalHomePrivateFilesDir({ dataDir, env: pathEnv, platform });
  return Object.freeze({ installRoot, configDir, dataDir, databasePath, publicFilesDir: filesDir, privateFilesDir,
    masterSecretPath: api.resolve(api.join(dataDir, 'handy-master-secret.txt')),
    backupsDir: api.resolve(api.join(dataDir, 'backups')), derivedDataDir: api.resolve(api.join(dataDir, 'derived')), logsDir,
    irohEndpointKeyPath: resolveHomeIrohEndpointKeyPath(params), mode, platform });
}

export function resolvePersonalHomeRuntimeArtifactPaths(layout: PersonalHomeRuntimeLayout): PersonalHomeRuntimeArtifactPaths {
  const api = layout.platform === 'win32' ? win32 : posix;
  const dataDir = api.resolve(layout.dataDir);
  const runtimeDir = api.resolve(dataDir, 'runtime');
  const operationsDir = api.resolve(dataDir, '.operations');
  return Object.freeze({
    startupReceiptPath: api.resolve(dataDir, 'startup-receipt.json'),
    irohEndpointDescriptorPath: api.resolve(api.dirname(layout.irohEndpointKeyPath), 'home.descriptor.json'),
    homeConnectionDescriptorPath: api.resolve(runtimeDir, 'home.descriptor.json'),
    updateRecoveryPath: api.resolve(operationsDir, 'runtime-update-recovery.v1.json'),
    restoreJournalPath: api.resolve(operationsDir, 'restore-journal.json'),
    relocationSourcePath: api.resolve(operationsDir, 'relocation-source.json'),
    relocationDestinationPath: api.resolve(operationsDir, 'relocation-destination.json'),
    operationLockPath: api.resolve(operationsDir, 'lock'),
  });
}

export function assertLayoutPath(layout: PersonalHomeRuntimeLayout, path: string): string {
  const root = normalize(resolve(layout.dataDir));
  const candidate = normalize(resolve(path));
  if (candidate !== root && !candidate.startsWith(`${root}/`) && !candidate.startsWith(`${root}\\`)) {
    throw new Error('Personal Home path escapes data root');
  }
  return candidate;
}
