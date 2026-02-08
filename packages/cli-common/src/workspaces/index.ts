import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

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
