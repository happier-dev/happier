import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { resolveManagedToolsRoot } from '@happier-dev/cli-common/agents';
import { isCanonicalAbsolutePathInsideRoot, resolveCanonicalAbsolutePathComparisonIdentity, resolveHomeDirFromEnvironment } from '@happier-dev/cli-common/path';
import type { PluginStorePaths } from './paths';

/** Historical code location, retained only to retire its native traversal grants. */
export function resolveLegacyPluginGenerationRoot(happyHomeDir: string): string {
  return join(happyHomeDir, 'plugins', 'plugins', 'generations');
}

export function resolvePluginStorePathLayout(happyHomeDir: string, env: NodeJS.ProcessEnv = process.env): PluginStorePaths {
  const rootDir = join(happyHomeDir, 'plugins', 'plugins');
  const stateDir = join(rootDir, 'state');
  const toolsRoot = resolveManagedToolsRoot({ ...env, HAPPIER_HOME_DIR: happyHomeDir });
  const externalToolsRoot = !isCanonicalAbsolutePathInsideRoot(happyHomeDir, toolsRoot)
    && !isCanonicalAbsolutePathInsideRoot(resolveHomeDirFromEnvironment(env), toolsRoot);
  // Each private registry owns its generation retirement/GC, even when several
  // daemons share one installation. Code is the only state in this public root.
  const storeId = createHash('sha256').update(resolveCanonicalAbsolutePathComparisonIdentity(happyHomeDir) ?? happyHomeDir).digest('hex');
  const generationsDir = externalToolsRoot
    ? join(toolsRoot, 'plugins', storeId)
    : resolveLegacyPluginGenerationRoot(happyHomeDir);
  return Object.freeze({
    happyHomeDir,
    rootDir,
    stateDir,
    registryCurrentFilePath: join(stateDir, 'plugin-registry-current.v1.json'),
    registryCommitLockFilePath: join(stateDir, 'plugin-registry-commit.v1.lock'),
    stateRevisionsDir: join(rootDir, 'state-revisions'),
    generationsDir,
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

