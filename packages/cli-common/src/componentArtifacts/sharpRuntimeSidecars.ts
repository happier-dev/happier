import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { resolveInstalledPackage } from '../workspaces/index.js';
import type { StageEntry } from './serverSidecars.js';
import type { BinaryTarget } from './targets.js';

type PackageJson = {
  name?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  os?: string[];
  cpu?: string[];
};

function packageNameToNodeModulesPath(packageName: string): string {
  return join('node_modules', ...packageName.split('/'));
}

async function readPackageJson(packageJsonPath: string): Promise<PackageJson> {
  const raw = await readFile(packageJsonPath, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`[component-artifacts] invalid package.json: ${packageJsonPath}`);
  }
  return parsed as PackageJson;
}

function matchesPackageConstraint(values: string[] | undefined, targetValue: string): boolean {
  if (!values || values.length === 0) return true;
  const denied = values.some((value) => value === `!${targetValue}`);
  if (denied) return false;
  const allowedValues = values.filter((value) => !value.startsWith('!'));
  return allowedValues.length === 0 || allowedValues.includes(targetValue);
}

function packageSupportsTarget(packageJson: PackageJson, target: BinaryTarget): boolean {
  const npmOs = target.os === 'windows' ? 'win32' : target.os;
  return matchesPackageConstraint(packageJson.os, npmOs)
    && matchesPackageConstraint(packageJson.cpu, target.arch);
}

function requiredSharpRuntimePackages(target: BinaryTarget): string[] {
  const platform = target.os === 'windows' ? 'win32' : target.os;
  const suffix = `${platform}-${target.arch}`;
  return target.os === 'windows'
    ? [`@img/sharp-${suffix}`]
    : [`@img/sharp-${suffix}`, `@img/sharp-libvips-${suffix}`];
}

async function collectInstalledPackageSidecars({
  resolveFromPackageJsonPath,
  packageName,
  target,
  optional,
  visited,
}: {
  resolveFromPackageJsonPath: string;
  packageName: string;
  target: BinaryTarget;
  optional: boolean;
  visited: Set<string>;
}): Promise<StageEntry[]> {
  if (visited.has(packageName)) return [];
  let installed: ReturnType<typeof resolveInstalledPackage>;
  try {
    installed = resolveInstalledPackage({ require: createRequire(resolveFromPackageJsonPath), packageName });
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'MODULE_NOT_FOUND') throw error;
    if (optional) return [];
    throw new Error(`[component-artifacts] missing runtime package ${packageName} (resolved from ${resolveFromPackageJsonPath})`, { cause: error });
  }
  const { packageDir, packageJsonPath } = installed;
  const packageJson = await readPackageJson(packageJsonPath);
  if (!packageSupportsTarget(packageJson, target)) {
    if (optional) return [];
    throw new Error(`[component-artifacts] runtime package ${packageName} is incompatible with ${target.os}-${target.arch}`);
  }

  visited.add(packageName);
  const entries: StageEntry[] = [{
    sourcePath: packageDir,
    targetPath: packageNameToNodeModulesPath(packageName),
  }];

  for (const depName of Object.keys(packageJson.dependencies ?? {})) {
    entries.push(...await collectInstalledPackageSidecars({
      resolveFromPackageJsonPath: packageJsonPath,
      packageName: depName,
      target,
      optional: false,
      visited,
    }));
  }

  for (const depName of Object.keys(packageJson.optionalDependencies ?? {})) {
    entries.push(...await collectInstalledPackageSidecars({
      resolveFromPackageJsonPath: packageJsonPath,
      packageName: depName,
      target,
      optional: true,
      visited,
    }));
  }

  return entries;
}

export async function resolveSharpRuntimeSidecarEntries({
  resolveFromPackageJsonPath,
  target,
}: {
  resolveFromPackageJsonPath: string;
  target: BinaryTarget;
}): Promise<StageEntry[]> {
  const visited = new Set<string>();
  const sharp = resolveInstalledPackage({ require: createRequire(resolveFromPackageJsonPath), packageName: 'sharp' });
  const entries = await collectInstalledPackageSidecars({
    resolveFromPackageJsonPath,
    packageName: 'sharp',
    target,
    optional: false,
    visited,
  });
  for (const packageName of requiredSharpRuntimePackages(target)) {
    entries.push(...await collectInstalledPackageSidecars({
      resolveFromPackageJsonPath: sharp.packageJsonPath,
      packageName,
      target,
      optional: false,
      visited,
    }));
  }
  return entries;
}
