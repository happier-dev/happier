import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire, isBuiltin } from 'node:module';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import cliDistBuildManifest from '../../../../../packages/cli-common/cliDistBuildManifest.cjs';
import { collectInternalWorkspaceDependencyNames } from '../../../../../scripts/workspaces/workspacePackageDependencies.mjs';

/** Discover native test inputs before component-wide workspace preparation.
 * Installed third-party modules need dependency admission, not workspace dist.
 * An entry declaration can establish source preparation for suites whose graph
 * uses dynamic tooling. It retains dependencies and normal validation admission;
 * it does not establish a complete input inventory for source watchers.
 * Undeclared incomplete graphs retain workspace preparation. */
export function readNativeTestPreparationDemand(repoDir, entryPath, { sourceCondition = false, declaredOnly = false } = {}) {
  let root;
  try { root = realpathSync(repoDir); }
  catch { return null; }
  const entries = new Set((Array.isArray(entryPath) ? entryPath : [entryPath]).map(path => resolve(root, path)));
  const pending = [...entries];
  const files = new Set();
  let requiresDependencyBootstrap = false;
  let hasProcessBoundary = false;
  while (pending.length) {
    let path = pending.pop();
    try {
      if (lstatSync(path).isSymbolicLink()) return null;
      path = realpathSync(path);
    } catch { return null; }
    if (files.has(path)) continue;
    const local = relative(root, path);
    if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)
      || local.split(sep).includes('dist') || !/\.(?:mjs|cjs|js|mts|cts|ts)$/.test(path)) return null;
    let source;
    try { source = readFileSync(path, 'utf8'); }
    catch { return null; }
    // The suite owns its preparation declaration. `source-condition` holds only
    // when the run selects authored exports (--conditions=happier-source).
    const declared = entries.has(path) && /\.test\.mjs$/.test(path)
      ? /^\/\/ @happier-test-preparation (source|source-condition)\r?\n/.exec(source)?.[1] : undefined;
    if (declared === 'source-condition' && !sourceCondition) return null;
    // A loader or NODE_OPTIONS can change module loading, so only the suite's
    // own declaration (never graph discovery) decides preparation then.
    if (declaredOnly && !declared) return null;
    if (declared) {
      requiresDependencyBootstrap = true;
      files.add(path);
      continue;
    }
    files.add(path);
    if (/\b(?:import|require)\s*\(\s*[^'"\s]/.test(source)
      || /(?<![\w$.])(?:(?:globalThis|global)\s*\.\s*)?(?:eval|Function)\s*\(/.test(source)) return null;
    for (const specifier of cliDistBuildManifest.extractModuleSpecifiers(source)) {
      if (isBuiltin(specifier)) {
        const builtin = specifier.replace(/^node:/, '');
        if (['module', 'vm', 'worker_threads', 'cluster'].includes(builtin)) return null;
        if (builtin === 'child_process') hasProcessBoundary = true;
      } else if (specifier.startsWith('./') || specifier.startsWith('../')) {
        pending.push(resolve(dirname(path), specifier));
      } else {
        const packageName = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
        // The dependency owner recognizes copied first-party packages too;
        // a physical node_modules location alone is not third-party evidence.
        if (collectInternalWorkspaceDependencyNames({ dependencies: { [packageName]: '*' } }).length) return null;
        let installedPath;
        try { installedPath = realpathSync(createRequire(path).resolve(specifier)); }
        catch { return null; }
        // Workspace links resolve into packages/apps, outside node_modules.
        // Resolve at the importing file so nested dependencies use Node's owner.
        const installedRelative = relative(root, installedPath);
        if (installedRelative === '..' || installedRelative.startsWith(`..${sep}`)
          || isAbsolute(installedRelative) || !installedRelative.split(sep).includes('node_modules')) return null;
        requiresDependencyBootstrap = true;
      }
    }
  }
  return { sourceInputs: requiresDependencyBootstrap ? null : [...files].map(path => relative(root, path).split(sep).join('/')).sort(), requiresDependencyBootstrap, hasProcessBoundary };
}

/** Watchers without installed-dependency inputs retain their source-only scope. */
export function readNativeTestSourceInputs(repoDir, entryPath) {
  const demand = readNativeTestPreparationDemand(repoDir, entryPath);
  return demand && !demand.requiresDependencyBootstrap && !demand.hasProcessBoundary ? demand.sourceInputs : null;
}
