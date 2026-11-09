import { readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

export const BUNDLED_PLUGIN_MANIFEST_RELATIVE_PATH = '.happier-plugin/plugin.json';

function isRegularFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isRelativePathInsideRoot(relativePath) {
  return Boolean(
    relativePath
      && relativePath !== '..'
      && !relativePath.startsWith('../')
      && !relativePath.startsWith('..\\')
      && !relativePath.startsWith('/')
      && !relativePath.startsWith('\\'),
  );
}

/**
 * A bundled plugin package declares the resources it ships in its projected
 * manifest, including inert registry catalogs. Dynamic Resources and remote
 * registry sources contribute no packaged bytes.
 */
function readDeclaredResourcePaths(packageRoot) {
  let manifest;
  let resources;
  try {
    manifest = JSON.parse(
      readFileSync(join(packageRoot, '.happier-plugin', 'plugin.json'), 'utf8'),
    );
    resources = manifest?.contributes?.resources;
  } catch {
    return { ok: false, problem: `${BUNDLED_PLUGIN_MANIFEST_RELATIVE_PATH} is missing or unreadable` };
  }
  if (!Array.isArray(resources)) {
    return {
      ok: false,
      problem: `${BUNDLED_PLUGIN_MANIFEST_RELATIVE_PATH} declares no contributes.resources array`,
    };
  }
  const declaredPaths = [
    ...resources.filter(resource => resource?.path !== undefined).map(resource => resource.path),
    ...(manifest.contributes.registrySources ?? [])
      .filter(source => source?.packageContent !== undefined).map(source => source.packageContent?.path),
  ];
  const paths = [];
  for (const path of declaredPaths) {
    if (typeof path !== 'string' || !path.trim()) {
      return {
        ok: false,
        problem: `${BUNDLED_PLUGIN_MANIFEST_RELATIVE_PATH} declares a resource with a non-path location`,
      };
    }
    paths.push(path);
  }
  return { ok: true, paths };
}

function resolveDeclaredResource(packageRoot, declaredPath) {
  const resourcePath = resolve(packageRoot, declaredPath);
  return {
    resourcePath,
    insideRoot: isRelativePathInsideRoot(relative(packageRoot, resourcePath)),
  };
}

/**
 * The packaged resource paths a bundled plugin package must carry, as declared
 * by its own manifest. Escaping declarations are excluded here and reported by
 * `findUnservableBundledPluginPackageResources` instead, so a malformed manifest
 * can never direct a copy outside the package root.
 *
 * @param {string} packageRoot
 * @returns {readonly string[]}
 */
export function readBundledPluginPackageResourceRelativePaths(packageRoot) {
  const declared = readDeclaredResourcePaths(packageRoot);
  if (!declared.ok) return [];
  return declared.paths.filter(
    (declaredPath) => resolveDeclaredResource(packageRoot, declaredPath).insideRoot,
  );
}

/**
 * Every packaged resource this bundled plugin package declares but cannot serve.
 * An empty result is the canonical "this package tree matches its own manifest"
 * decision, shared by the artifact packager and the pinned runner snapshot.
 *
 * @param {string} packageRoot
 * @returns {readonly string[]} human-readable problems, most specific first.
 */
export function findUnservableBundledPluginPackageResources(packageRoot) {
  const declared = readDeclaredResourcePaths(packageRoot);
  if (!declared.ok) return [declared.problem];
  const problems = [];
  for (const declaredPath of declared.paths) {
    const { resourcePath, insideRoot } = resolveDeclaredResource(packageRoot, declaredPath);
    if (!insideRoot) {
      problems.push(`${declaredPath} (escapes the package root)`);
      continue;
    }
    if (!isRegularFile(resourcePath)) {
      problems.push(`${declaredPath} (declared by the manifest, absent from the package)`);
    }
  }
  return problems;
}
