import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { createRequire, isBuiltin } from 'node:module';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileDigestMetadataIdentity, readCachedFileDigestSync } from '../utils/fs/cached_file_digest.mjs';
import { collectExternalRuntimeDependencies, isInternalWorkspacePackageName, resolveInstalledRuntimePackage } from '../../../../packages/cli-common/workspaceRuntimeDependencies.mjs';

/** The installed external input view, independent of workspace link wiring.
 * Inspect public module roots and their physical dependency links, not pnpm's
 * private store (which also retains packages no longer installed). Include all
 * workspace roots: compiler paths and ambient type lookup can reach beyond the
 * public SDK's runtime dependencies. The installation's existing publication
 * check still rejects any dependency writer overlapping this finite build.
 */
export function readSourceAuthorDependencyIdentity({ sourceRepoDir, repoDir, workspacePackages, compilerPath, signal }) {
  return readInstalledDependencyIdentity({ sourceRepoDir, repoDir, workspacePackages, compilerPath, signal });
}

/** External imports emitted by the runtime select its installed package closure.
 * Reuse the author producer's file identity, but omit compiler/ambient lookup
 * roots: those are build inputs, not dependencies of an already emitted CLI. */
export function readSourceRuntimeDependencyIdentity({ imports, signal }) {
  return readInstalledDependencyIdentity({ runtimeImports: imports, signal });
}

function readInstalledDependencyIdentity({ sourceRepoDir, repoDir, workspacePackages = new Map(), compilerPath, runtimeImports, signal }) {
  const hash = createHash('sha256');
  const visited = new Set();
  const moduleRoots = new Set();
  const sourceRoots = [...workspacePackages.values()].map(({root}) => join(sourceRepoDir, relative(repoDir, root)));
  const workspaceNames = new Set(workspacePackages.keys());
  const entries = directory => existsSync(directory)
    ? readdirSync(directory, {withFileTypes:true}).sort((a,b) => a.name.localeCompare(b.name)) : [];
  const file = path => {
    const info = statSync(path, {bigint:true});
    // Author builds retain their metadata proof. Runtime freshness compares
    // content: pnpm can change shared-file ctimes during unrelated workspace
    // wiring. The digest owner uses metadata only to reuse unchanged digests.
    const identity = runtimeImports ? readCachedFileDigestSync(path, info) : fileDigestMetadataIdentity(info);
    hash.update(JSON.stringify([path, String(info.mode), identity]));
  };
  const directory = path => {
    signal?.throwIfAborted();
    const physical = realpathSync(path);
    if (visited.has(physical)) return;
    visited.add(physical);
    for (const entry of entries(physical)) {
      const child = join(physical, entry.name);
      if (entry.name === 'node_modules') { if (!runtimeImports) modules(child); continue; }
      if (entry.isSymbolicLink()) hash.update(JSON.stringify([child, readlinkSync(child)]));
      const info = entry.isSymbolicLink() ? statSync(child) : entry;
      if (info.isDirectory()) directory(child);
      else if (info.isFile()) file(child);
    }
  };
  const installedPackage = (name, path) => {
    if (workspaceNames.has(name) || isInternalWorkspacePackageName(name)) return;
    const physical = realpathSync(path);
    // Include resolution topology even when two public links share one tree.
    hash.update(JSON.stringify([path, physical]));
    if (visited.has(physical)) return;
    directory(physical);
    if (runtimeImports) {
      const packageJsonPath = join(physical, 'package.json');
      const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
      // Peers can supply runtime imports too. Keep an absent peer observable,
      // without turning this inventory into a new package-install validator.
      for (const dependency of collectExternalRuntimeDependencies({ ...manifest,
        optionalDependencies: { ...manifest.peerDependencies, ...manifest.optionalDependencies } })) {
        let installed;
        try {
          installed = resolveInstalledRuntimePackage({ packageName: dependency.name, resolveFromPackageJsonPath: packageJsonPath });
        } catch (error) {
          if (!dependency.optional || error.code !== 'MODULE_NOT_FOUND') throw error;
          hash.update(JSON.stringify([physical, dependency.name, 'absent']));
          continue;
        }
        installedPackage(dependency.name, installed.packageDir);
      }
      return;
    }
    // pnpm's transitive dependencies are siblings in its virtual module root,
    // not necessarily children of the installed package. Node owns lookup.
    for (const root of createRequire(join(physical, 'package.json')).resolve.paths(name) ?? []) modules(root);
  };
  const modules = path => {
    if (moduleRoots.has(path)) return;
    moduleRoots.add(path);
    for (const entry of entries(path)) {
      if (entry.name.startsWith('.')) continue;
      const child = join(path, entry.name);
      if (entry.name.startsWith('@')) {
        for (const scoped of entries(child)) {
          if (!scoped.name.startsWith('.') && (scoped.isDirectory() || scoped.isSymbolicLink())) {
            installedPackage(`${entry.name}/${scoped.name}`, join(child, scoped.name));
          }
        }
      } else if (entry.isDirectory() || entry.isSymbolicLink()) installedPackage(entry.name, child);
    }
  };
  if (runtimeImports) {
    for (const { path: specifier, resolveFrom } of [...runtimeImports].sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b)))) {
      if (isBuiltin(specifier)) continue;
      const path = specifier.startsWith('file:') ? fileURLToPath(specifier) : specifier;
      if (!isAbsolute(path)) {
        const name = path.startsWith('@') ? path.split('/').slice(0, 2).join('/') : path.split('/')[0];
        let installed;
        try { installed = resolveInstalledRuntimePackage({ packageName: name, resolveFromPackageJsonPath: resolveFrom }); }
        catch (error) {
          if (error.code !== 'MODULE_NOT_FOUND') throw error;
          hash.update(JSON.stringify([resolveFrom, path, 'absent']));
          continue;
        }
        installedPackage(name, installed.packageDir);
        continue;
      }
      // A removed import must refuse rather than accidentally inventorying an
      // ancestor workspace after the installed package directory disappears.
      realpathSync(path);
      let root = dirname(path);
      let manifest;
      for (;;) {
        manifest = existsSync(join(root, 'package.json'))
          ? JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) : null;
        if (typeof manifest?.name === 'string' || dirname(root) === root) break;
        root = dirname(root);
      }
      if (!manifest?.name) file(path);
      else installedPackage(manifest.name, root);
    }
  } else for (const root of [sourceRepoDir, ...sourceRoots].sort()) modules(join(root, 'node_modules'));
  // The compiler selector can live outside a scratch repository's install.
  if (compilerPath) file(compilerPath);
  return hash.digest('hex');
}
