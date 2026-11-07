import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCachedFileDigestSync } from '../utils/fs/cached_file_digest.mjs';
import { collectExternalRuntimeDependencies, isInternalWorkspacePackageName, resolveInstalledRuntimePackage } from '../../../../packages/cli-common/workspaceRuntimeDependencies.mjs';

/** External imports emitted by the runtime select its installed package closure.
 * Compiler/ambient lookup roots are build inputs, not dependencies of an
 * already emitted CLI.
 * Package compilation also uses this closure's declaration-only projection
 * for development/peer inputs, without treating their JS tooling as runtime. */
export function readSourceRuntimeDependencyIdentity({ imports: runtimeImports,
  declarationsOnly = false, identityPathFor = path => path, signal }) {
  const hash = createHash('sha256');
  const visited = new Set();
  const entries = directory => existsSync(directory)
    ? readdirSync(directory, {withFileTypes:true}).sort((a,b) => a.name.localeCompare(b.name)) : [];
  const file = (path, identityPath = identityPathFor(path)) => {
    const info = statSync(path, {bigint:true});
    // pnpm can replace identical files during workspace-only wiring. The
    // digest owner uses metadata only to reuse unchanged content digests.
    const identity = readCachedFileDigestSync(path, info);
    hash.update(JSON.stringify([identityPath, String(info.mode), identity]));
  };
  const directory = (path, identityPath = identityPathFor(path)) => {
    signal?.throwIfAborted();
    const physical = realpathSync(path);
    if (visited.has(physical)) return;
    visited.add(physical);
    for (const entry of entries(physical)) {
      const child = join(physical, entry.name);
      if (entry.name === 'node_modules') continue;
      if (!declarationsOnly && entry.isSymbolicLink()) hash.update(JSON.stringify([identityPathFor(child), readlinkSync(child)]));
      const info = entry.isSymbolicLink() ? statSync(child) : entry;
      const childIdentityPath = declarationsOnly ? join(identityPath, entry.name) : identityPathFor(child);
      if (info.isDirectory()) directory(child, childIdentityPath);
      else if (info.isFile() && (!declarationsOnly || /\.(?:ts|tsx|mts|cts|json)$/.test(entry.name))) file(child, childIdentityPath);
    }
  };
  const installedPackage = (name, path, logicalPath = name) => {
    if (isInternalWorkspacePackageName(name)) return;
    const physical = realpathSync(path);
    // Runtime consumes physical topology. Declaration inputs use logical edges:
    // a pnpm JS-only patch can relocate an otherwise identical type package.
    hash.update(JSON.stringify(declarationsOnly ? [logicalPath] : [identityPathFor(path), identityPathFor(physical)]));
    if (visited.has(physical)) return;
    directory(physical, declarationsOnly ? logicalPath : identityPathFor(physical));
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

  };
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
    try { realpathSync(path); }
    catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      // Match missing bare imports: invalidate the closure, leaving finite
      // build admission to discard a snapshot spanning an install relayout.
      hash.update(JSON.stringify([identityPathFor(resolveFrom), path, 'absent']));
      continue;
    }
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
  return hash.digest('hex');
}
