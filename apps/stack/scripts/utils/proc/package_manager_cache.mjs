import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expandHome } from '../paths/canonical_home.mjs';
import { reapHistoricalTempRoots } from '../dev_targets/historical_temp_roots.mjs';

export function resolvePackageManagerCachePaths(cacheBaseDir) {
  const base = resolve(expandHome(cacheBaseDir));
  return { XDG_CACHE_HOME: join(base, 'xdg'), YARN_CACHE_FOLDER: join(base, 'yarn'),
    npm_config_cache: join(base, 'npm'), COREPACK_HOME: join(base, 'corepack') };
}

// Yarn Classic v6 stores one package's remote resolution beneath each npm-*
// directory. This is the observed worker layout; unknown layouts/metadata are
// retained. Lockfile membership, rather than a guessed age/size quota, owns
// eviction eligibility. Custody remains the only deletion/process-use owner.
export function pruneWorkerYarnCache({ cacheBaseDir, repositoryDirectories, runtimeBuildRoot, procRoot = '/proc', ownerUid = process.getuid() }) {
  const retained = reason => {
    console.error(`[preferred-execution] retaining worker Yarn cache: ${reason}`);
    return { reclaimedBytes: 0, reclaimedRoots: 0, retainedRoots: 0, observationUnavailable: reason };
  };
  if (!repositoryDirectories?.length) return retained('protected repositories unavailable');
  const repositories = new Set(repositoryDirectories);
  const resolutions = new Set();
  try {
    if (runtimeBuildRoot) {
      for (const stack of readdirSync(runtimeBuildRoot, { withFileTypes: true })) {
        if (!stack.isDirectory()) continue;
        const stackDir = join(runtimeBuildRoot, stack.name);
        for (const entry of readdirSync(stackDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const candidate = entry.name === 'repo' ? join(stackDir, entry.name) : join(stackDir, entry.name, 'repo');
          try {
            if (lstatSync(join(candidate, 'yarn.lock')).isFile()) repositories.add(candidate);
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
      }
    }
    for (const repo of repositories) {
      const lock = readFileSync(join(repo, 'yarn.lock'), 'utf8');
      if (!/^# yarn lockfile v1\s*$/m.test(lock)) return retained('unsupported protected lockfile');
      for (const match of lock.matchAll(/^ {2}resolved (.+)$/gm)) {
        const value = JSON.parse(match[1]);
        if (typeof value !== 'string') return retained('invalid protected resolution');
        resolutions.add(value);
      }
    }
  } catch (error) { return retained(`protected lockfile observation failed (${error.code ?? error.name})`); }
  if (!resolutions.size) return retained('no protected resolutions observed');
  const parent = join(resolvePackageManagerCachePaths(cacheBaseDir).YARN_CACHE_FOLDER, 'v6');
  let names;
  try {
    if (!lstatSync(parent).isDirectory()) return retained('unsupported cache layout');
    names = readdirSync(parent).filter(name => name.startsWith('npm-'));
  } catch (error) { return retained(`cache observation failed (${error.code ?? error.name})`); }
  const candidates = [];
  for (const name of names) {
    try {
      const directory = join(parent, name);
      if (!lstatSync(directory).isDirectory()) continue;
      const modules = join(directory, 'node_modules');
      if (!lstatSync(modules).isDirectory()) continue;
      const packages = readdirSync(modules);
      if (packages.length !== 1) continue;
      let packageDir = join(modules, packages[0]);
      if (!lstatSync(packageDir).isDirectory()) continue;
      if (packages[0].startsWith('@')) {
        const scoped = readdirSync(packageDir);
        if (scoped.length !== 1) continue;
        packageDir = join(packageDir, scoped[0]);
        if (!lstatSync(packageDir).isDirectory()) continue;
      }
      const metadataPath = join(packageDir, '.yarn-metadata.json');
      if (!lstatSync(metadataPath).isFile()) continue;
      const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
      const resolved = metadata?.remote?.resolved;
      if (typeof resolved === 'string' && resolved && !resolutions.has(resolved)) candidates.push(name);
    } catch { /* Incomplete downloads and unknown entries are retained. */ }
  }
  return reapHistoricalTempRoots(parent, procRoot, { candidateNames: candidates, minimumAgeMs: 0, ownerUid });
}
