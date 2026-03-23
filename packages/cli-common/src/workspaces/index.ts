import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, 'package.json')) && existsSync(resolve(dir, 'yarn.lock'))) {
      return dir;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Repository root not found starting from ${startDir}`);
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path: string, value: any): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function sleepSync(ms: number): void {
  if (!ms || ms <= 0) return;
  const buf = new SharedArrayBuffer(4);
  const arr = new Int32Array(buf);
  Atomics.wait(arr, 0, 0, ms);
}

function isRetryableRmError(err: unknown): boolean {
  const code = err && typeof err === 'object' ? Reflect.get(err, 'code') : null;
  return code === 'ENOTEMPTY' || code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
}

export function sanitizeBundledPackageJson(raw: any): any {
  const {
    name,
    version,
    type,
    main,
    module,
    types,
    exports,
    dependencies,
    peerDependencies,
    optionalDependencies,
    engines,
  } = raw ?? {};

  return {
    name,
    version,
    private: true,
    type,
    main,
    module,
    types,
    exports,
    dependencies,
    peerDependencies,
    optionalDependencies,
    engines,
  };
}

export function rmDirSafeSync(
  path: string,
  opts: Readonly<{
    recursive?: boolean;
    force?: boolean;
    retries?: number;
    delayMs?: number;
    rmSyncImpl?: typeof rmSync;
  }> = {},
): void {
  const {
    recursive = true,
    force = true,
    retries = 5,
    delayMs = 25,
    rmSyncImpl = rmSync,
  } = opts;

  const maxAttempts = Math.max(1, Number.isFinite(retries) ? retries + 1 : 1);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      rmSyncImpl(path, { recursive, force });
      return;
    } catch (error) {
      if (!isRetryableRmError(error) || attempt === maxAttempts - 1) throw error;
      sleepSync(delayMs);
    }
  }
}

function resetDir(path: string): void {
  removeStaleBundledWorkspaceTempDirs(path);
  rmDirSafeSync(path);
  mkdirSync(path, { recursive: true });
}

function copyIfExists(src: string, dest: string): boolean {
  if (!existsSync(src)) return false;
  cpSync(src, dest, { recursive: true });
  return true;
}

function isBundledWorkspaceTempDirName(name: string): boolean {
  return name.startsWith('dist.__sync_tmp__.') || name.startsWith('dist.__sync_backup__.');
}

function removeStaleBundledWorkspaceTempDirs(targetDir: string): void {
  if (!existsSync(targetDir)) return;

  for (const entry of readdirSync(targetDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!isBundledWorkspaceTempDirName(entry.name)) continue;
    rmDirSafeSync(resolve(targetDir, entry.name));
  }
}

export function bundleWorkspacePackage(params: Readonly<{
  packageName: string;
  srcDir: string;
  destDir: string;
  includeFiles?: string[];
}>): void {
  const srcPackageJsonPath = resolve(params.srcDir, 'package.json');
  if (!existsSync(srcPackageJsonPath)) {
    throw new Error(`Missing workspace package.json for ${params.packageName}: ${srcPackageJsonPath}`);
  }

  const rawPackageJson = readJson(srcPackageJsonPath);
  if (rawPackageJson.name !== params.packageName) {
    throw new Error(
      `Unexpected package name at ${srcPackageJsonPath}: expected ${params.packageName}, got ${rawPackageJson.name}`,
    );
  }

  const distDir = resolve(params.srcDir, 'dist');
  if (!existsSync(distDir)) {
    throw new Error(`Missing dist/ for ${params.packageName}. Run its build first.`);
  }

  resetDir(params.destDir);
  cpSync(distDir, resolve(params.destDir, 'dist'), { recursive: true });
  writeJson(resolve(params.destDir, 'package.json'), sanitizeBundledPackageJson(rawPackageJson));

  const files = params.includeFiles ?? ['README.md'];
  for (const f of files) {
    copyIfExists(resolve(params.srcDir, f), resolve(params.destDir, f));
  }
}

export function bundleWorkspacePackages(params: Readonly<{
  bundles: ReadonlyArray<{ packageName: string; srcDir: string; destDir: string; includeFiles?: string[] }>;
}>): void {
  for (const b of params.bundles) {
    bundleWorkspacePackage({
      packageName: b.packageName,
      srcDir: b.srcDir,
      destDir: b.destDir,
      includeFiles: b.includeFiles,
    });
  }
}

function readBundledDependencyNames(rawPackageJson: any): string[] {
  const bundledDependencies = Array.isArray(rawPackageJson?.bundledDependencies)
    ? rawPackageJson.bundledDependencies
    : Array.isArray(rawPackageJson?.bundleDependencies)
      ? rawPackageJson.bundleDependencies
      : [];

  return bundledDependencies
    .map((value: unknown) => (typeof value === 'string' ? value.trim() : ''))
    .filter((value: string) => value.length > 0);
}

export function resolveWorkspaceBundlesFromPackageJson(params: Readonly<{
  repoRoot: string;
  hostPackageDir: string;
}>): ReadonlyArray<{
  packageName: string;
  srcDir: string;
  destDir: string;
}> {
  const hostPackageJsonPath = resolve(params.hostPackageDir, 'package.json');
  if (!existsSync(hostPackageJsonPath)) {
    throw new Error(`Missing host package.json: ${hostPackageJsonPath}`);
  }

  const hostPackageJson = readJson(hostPackageJsonPath);
  const bundledWorkspaceNames = readBundledDependencyNames(hostPackageJson)
    .filter((packageName) => packageName.startsWith('@happier-dev/'));

  return bundledWorkspaceNames.map((packageName) => {
    const workspaceName = packageName.split('/').at(-1);
    if (!workspaceName) {
      throw new Error(`Unable to resolve workspace name from bundled dependency: ${packageName}`);
    }

    return {
      packageName,
      srcDir: resolve(params.repoRoot, 'packages', workspaceName),
      destDir: resolve(params.hostPackageDir, 'node_modules', ...packageName.split('/')),
    };
  });
}

function collectExternalRuntimeDepNamesFromPackageJson(packageJson: any): ReadonlyArray<{ name: string; optional: boolean }> {
  const deps = packageJson?.dependencies ?? {};
  const optionalDeps = packageJson?.optionalDependencies ?? {};

  const required = Object.keys(deps)
    .filter((name) => typeof name === 'string' && !name.startsWith('@happier-dev/'))
    .map((name) => ({ name, optional: false }));
  const optional = Object.keys(optionalDeps)
    .filter((name) => typeof name === 'string' && !name.startsWith('@happier-dev/'))
    .map((name) => ({ name, optional: true }));

  return [...required, ...optional];
}

function resolveInstalledPackage(params: Readonly<{ require: NodeRequire; packageName: string }>): Readonly<{
  packageDir: string;
  packageJsonPath: string;
  packageJson: any;
}> {
  const searchPaths = params.require.resolve.paths(params.packageName) ?? [];
  let aliasInstalledPackage:
    | Readonly<{
        packageDir: string;
        packageJsonPath: string;
        packageJson: any;
      }>
    | undefined;
  for (const searchPath of searchPaths) {
    const packageJsonPath = resolve(searchPath, ...params.packageName.split('/'), 'package.json');
    if (!existsSync(packageJsonPath)) continue;
    const packageJson = readJson(packageJsonPath);
    if (packageJson?.name === params.packageName) {
      return {
        packageDir: dirname(packageJsonPath),
        packageJsonPath,
        packageJson,
      };
    }

    // npm alias installs keep the alias folder name on disk while package.json preserves
    // the canonical upstream package name. Vendoring needs the on-disk folder, not an exact
    // name match, so keep the first directly-installed alias candidate as a fallback.
    if (!aliasInstalledPackage) {
      aliasInstalledPackage = {
        packageDir: dirname(packageJsonPath),
        packageJsonPath,
        packageJson,
      };
    }
  }

  if (aliasInstalledPackage) {
    return aliasInstalledPackage;
  }

  let resolvedEntry = '';
  try {
    resolvedEntry = params.require.resolve(`${params.packageName}/package.json`);
  } catch {
    resolvedEntry = params.require.resolve(params.packageName);
  }

  let dir = dirname(resolvedEntry);

  for (let i = 0; i < 50; i++) {
    const pkgJsonPath = resolve(dir, 'package.json');
    if (existsSync(pkgJsonPath)) {
      const pkgJson = readJson(pkgJsonPath);
      if (pkgJson?.name === params.packageName) {
        return { packageDir: dir, packageJsonPath: pkgJsonPath, packageJson: pkgJson };
      }
    }

    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error(`Failed to locate installed package.json for ${params.packageName} (resolved: ${resolvedEntry})`);
}

function vendorRuntimeDependencyTree(params: Readonly<{
  packageJsonPath: string;
  resolveFromPackageJsonPath?: string;
  destNodeModulesDir: string;
  visited?: Set<string>;
}>): void {
  const pkgJson = readJson(params.packageJsonPath);
  const roots = collectExternalRuntimeDepNamesFromPackageJson(pkgJson);
  const require = createRequire(pathToFileURL(params.resolveFromPackageJsonPath ?? params.packageJsonPath).href);

  const visited = params.visited ?? new Set<string>();
  mkdirSync(params.destNodeModulesDir, { recursive: true });

  for (const dep of roots) {
    let resolved: Readonly<{ packageDir: string; packageJsonPath: string }>;
    try {
      resolved = resolveInstalledPackage({ require, packageName: dep.name });
    } catch (error) {
      if (dep.optional) continue;
      throw error;
    }

    const depDestDir = resolve(params.destNodeModulesDir, ...dep.name.split('/'));
    if (visited.has(depDestDir)) continue;
    visited.add(depDestDir);

    resetDir(depDestDir);
    cpSync(resolved.packageDir, depDestDir, { recursive: true, dereference: true });

    vendorRuntimeDependencyTree({
      packageJsonPath: resolved.packageJsonPath,
      destNodeModulesDir: resolve(depDestDir, 'node_modules'),
      visited,
    });
  }
}

export function vendorBundledPackageRuntimeDependencies(params: Readonly<{
  srcPackageJsonPath: string;
  resolveFromPackageJsonPath?: string;
  destPackageDir: string;
}>): void {
  if (!existsSync(params.srcPackageJsonPath)) {
    throw new Error(`Missing package.json: ${params.srcPackageJsonPath}`);
  }

  vendorRuntimeDependencyTree({
    packageJsonPath: params.srcPackageJsonPath,
    resolveFromPackageJsonPath: params.resolveFromPackageJsonPath,
    destNodeModulesDir: resolve(params.destPackageDir, 'node_modules'),
  });
}

export function bundleInstalledPackageWithRuntimeDependencies(params: Readonly<{
  packageName: string;
  resolveFromPackageJsonPath: string;
  destNodeModulesDir: string;
}>): void {
  const require = createRequire(pathToFileURL(params.resolveFromPackageJsonPath).href);
  const resolved = resolveInstalledPackage({ require, packageName: params.packageName });
  const destPackageDir = resolve(params.destNodeModulesDir, ...params.packageName.split('/'));

  resetDir(destPackageDir);
  cpSync(resolved.packageDir, destPackageDir, { recursive: true, dereference: true });

  vendorRuntimeDependencyTree({
    packageJsonPath: resolved.packageJsonPath,
    resolveFromPackageJsonPath: resolved.packageJsonPath,
    destNodeModulesDir: resolve(destPackageDir, 'node_modules'),
  });
}
