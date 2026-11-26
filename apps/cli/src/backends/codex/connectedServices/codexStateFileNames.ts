import { readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'smol-toml';

import { findConnectedServiceChildSelection } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { readConnectedServiceStateSharingManifest } from '@/daemon/connectedServices/stateSharing/connectedServiceStateSharingManifest';
import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';
import { resolveConfiguredCodexHome } from '../utils/resolveConfiguredCodexHome';

async function resolveCodexSqliteLaunchPin(env: NodeJS.ProcessEnv, cwd: string): Promise<string | null> {
  const root = env.CODEX_SQLITE_HOME?.trim();
  if (!root) return null;
  const home = resolve(cwd, resolveConfiguredCodexHome(env));
  const managed = findConnectedServiceChildSelection(env, 'openai-codex')
    || (env.CODEX_HOME && (await readConnectedServiceStateSharingManifest(home)).lastSyncAtMs > 0);
  return managed ? resolve(cwd, expandHomeDirPath(root, env)) : null;
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

function readConfig(path: string): Record<string, unknown> {
  try {
    return parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

/** The local launch's SQLite root. Unresolved configuration carries no database authority. */
export function resolveConfiguredCodexSqliteHome(
  env: NodeJS.ProcessEnv,
  cwd = process.cwd(),
  options?: Readonly<{ launchPin?: string | null; configOverrides?: readonly string[] }>,
): string | null {
  const codexHome = resolve(cwd, resolveConfiguredCodexHome(env));
  try {
    // Managed requirements can override even CLI configuration. Without the
    // native configuration decision, do not use a guessed index in these homes.
    if (exists(join(codexHome, 'cloud-config-bundle-cache.json'))
      || (process.platform !== 'win32' && ['/etc/codex/requirements.toml', '/etc/codex/managed_config.toml'].some(exists))) return null;
    const user = readConfig(join(codexHome, 'config.toml'));
    if ((user.cli_auth_credentials_store === 'keyring' || user.cli_auth_credentials_store === 'auto')
      || options?.configOverrides?.some(value => /^\s*cli_auth_credentials_store\s*=/u.test(value))) return null;
    const explicit = options?.configOverrides?.filter(value => /^\s*sqlite_home\s*=/u.test(value)).at(-1);
    const pinned = explicit ? parse(explicit).sqlite_home : options?.launchPin;
    if (pinned != null) return typeof pinned === 'string' && pinned ? resolve(cwd, pinned) : null;
    // Project settings require native trust/layer resolution. A layer with no
    // SQLite setting cannot displace the selected user directory.
    if (user.project_root_markers !== undefined
      || options?.configOverrides?.some(value => /^\s*project_root_markers\s*=/u.test(value))) return null;
    const system = process.platform === 'win32' ? {} : readConfig('/etc/codex/config.toml');
    if (system.cli_auth_credentials_store !== undefined || system.project_root_markers !== undefined) return null;
    const workingDirectory = resolve(cwd);
    let projectRoot = workingDirectory;
    for (let directory = workingDirectory;;) {
      const marker = join(directory, '.git');
      if (exists(marker)) {
        const metadata = statSync(marker);
        if (!metadata.isDirectory() || exists(join(marker, 'HEAD'))) {
          projectRoot = directory;
          break;
        }
      }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    for (let directory = workingDirectory;; directory = dirname(directory)) {
      const project = join(directory, '.codex');
      if (project !== codexHome) {
        const config = readConfig(join(project, 'config.toml'));
        if (config.sqlite_home !== undefined || config.cli_auth_credentials_store !== undefined) return null;
      }
      if (directory === projectRoot) break;
    }
    const configured = user.sqlite_home ?? system.sqlite_home;
    if (configured !== undefined) {
      if (typeof configured !== 'string' || !configured) return null;
      const path = expandHomeDirPath(configured, env);
      return isAbsolute(path) ? path : resolve(user.sqlite_home === undefined ? '/etc/codex' : codexHome, path);
    }
    const environment = env.CODEX_SQLITE_HOME?.trim();
    return environment ? resolve(cwd, expandHomeDirPath(environment, env)) : codexHome;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** A loaded native server can prove layers that cannot be resolved from local configuration. */
export async function resolveCodexSqliteLaunch(params: Readonly<{
  env: NodeJS.ProcessEnv;
  cwd: string;
  configOverrides?: readonly string[];
  materialized?: boolean;
  readNativeConfig?: (method: string, params?: unknown) => Promise<unknown>;
}>): Promise<Readonly<{ launchPin: string | null; sqliteHome: string | null }>> {
  const configuredOverride = params.configOverrides?.some(value => /^\s*sqlite_home\s*=/u.test(value));
  const launchPin = configuredOverride ? null : params.materialized && params.env.CODEX_SQLITE_HOME?.trim()
    ? resolve(params.cwd, expandHomeDirPath(params.env.CODEX_SQLITE_HOME.trim(), params.env))
    : await resolveCodexSqliteLaunchPin(params.env, params.cwd);
  const sqliteHome = resolveConfiguredCodexSqliteHome(params.env, params.cwd, { launchPin, configOverrides: params.configOverrides });
  if (sqliteHome || !params.readNativeConfig) return { launchPin, sqliteHome };
  try {
    const [required, configured] = await Promise.all([
      params.readNativeConfig('configRequirements/read'),
      params.readNativeConfig('config/read', { cwd: params.cwd }),
    ]);
    const requirements = asRecord(required)?.requirements;
    const config = asRecord(asRecord(configured)?.config);
    if ((requirements !== null && !asRecord(requirements)) || !config) return { launchPin, sqliteHome: null };
    const nativePath = asRecord(requirements)?.sqliteHome ?? config.sqlite_home;
    if (nativePath == null) {
      const environment = params.env.CODEX_SQLITE_HOME?.trim();
      return { launchPin, sqliteHome: environment
        ? resolve(params.cwd, expandHomeDirPath(environment, params.env))
        : resolve(params.cwd, resolveConfiguredCodexHome(params.env)) };
    }
    if (typeof nativePath !== 'string') return { launchPin, sqliteHome: null };
    const path = nativePath.startsWith('file:') ? fileURLToPath(nativePath) : nativePath;
    return { launchPin, sqliteHome: isAbsolute(path) ? path : null };
  } catch {
    return { launchPin, sqliteHome: null };
  }
}
