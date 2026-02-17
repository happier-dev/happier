import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function resetDir(path: string): void {
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
}

function copyIfExists(src: string, dest: string): boolean {
  if (!existsSync(src)) return false;
  cpSync(src, dest, { recursive: true });
  return true;
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
  const resolvedEntry = params.require.resolve(params.packageName);
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
  destNodeModulesDir: string;
  visited?: Set<string>;
}>): void {
  const pkgJson = readJson(params.packageJsonPath);
  const roots = collectExternalRuntimeDepNamesFromPackageJson(pkgJson);
  const require = createRequire(pathToFileURL(params.packageJsonPath).href);

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
  destPackageDir: string;
}>): void {
  if (!existsSync(params.srcPackageJsonPath)) {
    throw new Error(`Missing package.json: ${params.srcPackageJsonPath}`);
  }

  vendorRuntimeDependencyTree({
    packageJsonPath: params.srcPackageJsonPath,
    destNodeModulesDir: resolve(params.destPackageDir, 'node_modules'),
  });
}
