import {
  collectExternalRuntimeDependencies,
  collectInternalRuntimeWorkspaceDepNames,
} from '../../../packages/cli-common/workspaceRuntimeDependencies.mjs';
import { readWorkspacePackages } from '../../../packages/cli-common/sourceRuntimeEntries.mjs';

/**
 * Bun does not include packages reached only through createRequire() in a
 * standalone executable. Keep the hsetup preload derived from the same
 * workspace package manifests that own its runtime closure.
 */
export async function resolveHsetupRuntimeDependencyNames(repoRoot) {
  const workspacePackages = await readWorkspacePackages(repoRoot);
  const packageClosure = [];
  const queued = new Set(['@happier-dev/bootstrap']);
  while (queued.size > 0) {
    const packageName = queued.values().next().value;
    queued.delete(packageName);
    if (packageClosure.includes(packageName)) continue;
    packageClosure.push(packageName);
    const packageInfo = workspacePackages.get(packageName);
    if (!packageInfo) continue;
    for (const dependencyName of collectInternalRuntimeWorkspaceDepNames(packageInfo.manifest)) {
      if (workspacePackages.has(dependencyName)) queued.add(dependencyName);
    }
  }
  const dependencies = new Set();

  for (const packageName of packageClosure) {
    const packageInfo = workspacePackages.get(packageName);
    if (!packageInfo) continue;
    for (const dependency of collectExternalRuntimeDependencies(packageInfo.manifest)) {
      if (!dependency.optional) dependencies.add(dependency.name);
    }
  }

  return [...dependencies].sort((left, right) => left.localeCompare(right));
}

export function renderHsetupBundleEntrypoint({ dependencyNames, hsetupEntrypoint }) {
  const imports = dependencyNames.map((name) => `import ${JSON.stringify(name)};`).join('\n');
  return `${imports}\nawait import(${JSON.stringify(hsetupEntrypoint)});\n`;
}
