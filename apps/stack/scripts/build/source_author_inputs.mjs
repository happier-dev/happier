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
 * roots: those are build inputs, not dependencies of an already emitted CLI.
 * Package compilation also uses this closure's declaration-only projection
 * for development/peer inputs, without treating their JS tooling as runtime. */
export function readSourceRuntimeDependencyIdentity({ imports, declarationsOnly = false, identityPathFor, signal }) {
  return readInstalledDependencyIdentity({ runtimeImports: imports, declarationsOnly, identityPathFor, signal });
}

function readInstalledDependencyIdentity({ sourceRepoDir, repoDir, workspacePackages = new Map(), compilerPath, runtimeImports,
  declarationsOnly = false, identityPathFor = path => path, signal }) {
  const hash = createHash('sha256');
  const visited = new Set();
  const moduleRoots = new Set();
  const sourceRoots = [...workspacePackages.values()].map(({root}) => join(sourceRepoDir, relative(repoDir, root)));
  const workspaceNames = new Set(workspacePackages.keys());
  const entries = directory => existsSync(directory)
    ? readdirSync(directory, {withFileTypes:true}).sort((a,b) => a.name.localeCompare(b.name)) : [];
  const file = (path, identityPath = identityPathFor(path)) => {
    const info = statSync(path, {bigint:true});
    // Author builds retain their metadata proof. Runtime freshness compares
    // content: pnpm can change shared-file ctimes during unrelated workspace
    // wiring. The digest owner uses metadata only to reuse unchanged digests.
    const identity = runtimeImports ? readCachedFileDigestSync(path, info) : fileDigestMetadataIdentity(info);
    hash.update(JSON.stringify([identityPath, String(info.mode), identity]));
  };
  const directory = (path, identityPath = identityPathFor(path)) => {
    signal?.throwIfAborted();
    const physical = realpathSync(path);
    if (visited.has(physical)) return;
    visited.add(physical);
    for (const entry of entries(physical)) {
      const child = join(physical, entry.name);
      if (entry.name === 'node_modules') { if (!runtimeImports) modules(child); continue; }
      if (!declarationsOnly && entry.isSymbolicLink()) hash.update(JSON.stringify([identityPathFor(child), readlinkSync(child)]));
      const info = entry.isSymbolicLink() ? statSync(child) : entry;
      const childIdentityPath = declarationsOnly ? join(identityPath, entry.name) : identityPathFor(child);
      if (info.isDirectory()) directory(child, childIdentityPath);
      else if (info.isFile() && (!declarationsOnly || /\.(?:ts|tsx|mts|cts|json)$/.test(entry.name))) file(child, childIdentityPath);
    }
  };
  const installedPackage = (name, path, logicalPath = name) => {
    if (workspaceNames.has(name) || isInternalWorkspacePackageName(name)) return;
    const physical = realpathSync(path);
    // Runtime consumes physical topology. Declaration inputs use logical edges:
    // a pnpm JS-only patch can relocate an otherwise identical type package.
    hash.update(JSON.stringify(declarationsOnly ? [logicalPath] : [identityPathFor(path), identityPathFor(physical)]));
    if (visited.has(physical)) return;
    directory(physical, declarationsOnly ? logicalPath : identityPathFor(physical));
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
          hash.update(JSON.stringify([declarationsOnly ? logicalPath : identityPathFor(physical), dependency.name, 'absent']));
          continue;
        }
        installedPackage(dependency.name, installed.packageDir, join(logicalPath, 'node_modules', dependency.name));
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
          hash.update(JSON.stringify([identityPathFor(resolveFrom), path, 'absent']));
          continue;
        }
        installedPackage(name, installed.packageDir, `${identityPathFor(resolveFrom)}:${path}`);
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
