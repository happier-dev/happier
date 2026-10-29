import { resolve } from 'node:path';

import { readWorkspaceComponentDependencyGraph } from './ensureWorkspacePackagesBuilt.mjs';
import { resolvePackageDeclarationTarget } from './packageBuildOutputTargets.mjs';

/** Host programs must not acquire a second type identity from a package's
 * bundled workspace copies. Follow public export targets, including subpaths
 * whose public names differ from their filenames. SDK publication itself
 * continues to compile and ship its self-contained bundled declarations.
 */
export async function readWorkspaceTypecheckDeclarationPaths(componentDir) {
  const graph = await readWorkspaceComponentDependencyGraph(componentDir);
  if (!graph) return {};
  const bundled = new Set([...graph.closure].flatMap(name => {
    const manifest = graph.packageJsonByDir.get(graph.packageDirsByName.get(name));
    return manifest.bundledDependencies ?? manifest.bundleDependencies ?? [];
  }));
  const paths = {};
  for (const name of bundled) {
    const directory = graph.packageDirsByName.get(name);
    if (!directory) continue;
    const manifest = graph.packageJsonByDir.get(directory);
    const entries = Object.keys(manifest.exports ?? {}).some(key => key.startsWith('.'))
      ? Object.entries(manifest.exports) : [['.', manifest.exports ?? manifest.types]];
    for (const [subpath, value] of entries) {
      const target = resolvePackageDeclarationTarget(value);
      if (!target) continue;
      paths[subpath === '.' ? name : `${name}/${subpath.slice(2)}`] = [resolve(directory, target)];
    }
  }
  return paths;
}
