import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { join } from 'node:path';

import {
  bundleWorkspacePackage,
  bundleWorkspacePackageWithRuntimeDependencies,
  resolveWorkspaceBundlesFromPackageJson,
  vendorBundledPackageRuntimeDependencies,
} from '../workspaces/index.js';

type CliNodeRuntimeWorkspaceBundle = Readonly<{
  packageName: string;
  srcDir: string;
  destDir: string;
  dereferenceRootDir: string;
}>;

export type CliNodeWorkspaceRuntimeIdentity = Readonly<{
  fingerprint: string;
  packageCount: number;
  packageNames: readonly string[];
}>;

/**
 * Sort physical payload entry names by UTF-16 code units. Runtime identities
 * are cross-machine content hashes, so this must not inherit host collation.
 */
export function compareCliNodeRuntimePayloadEntryNames(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function resolveCliNodeRuntimeWorkspaceBundles(
  repoRoot: string,
  hostPackageDir = join(repoRoot, 'apps', 'cli'),
): ReadonlyArray<CliNodeRuntimeWorkspaceBundle> {
  return resolveWorkspaceBundlesFromPackageJson({
    repoRoot,
    hostPackageDir,
  });
}

function resolveInstalledCliNodeRuntimeWorkspaceBundles(
  repoRoot: string,
  hostPackageDir = join(repoRoot, 'apps', 'cli'),
): ReadonlyArray<CliNodeRuntimeWorkspaceBundle> {
  return resolveCliNodeRuntimeWorkspaceBundles(repoRoot, hostPackageDir).map((bundle) => ({
    ...bundle,
    srcDir: join(hostPackageDir, 'node_modules', ...bundle.packageName.split('/')),
  }));
}

function hashPhysicalTree(
  hash: ReturnType<typeof createHash>,
  rootDir: string,
  relativeDir = '',
): void {
  const directoryPath = relativeDir ? join(rootDir, relativeDir) : rootDir;
  const entries = readdirSync(directoryPath, { withFileTypes: true })
    .filter((entry) => entry.name !== 'node_modules')
    .sort((left, right) => compareCliNodeRuntimePayloadEntryNames(left.name, right.name));
  for (const entry of entries) {
    const relativePath = relativeDir ? join(relativeDir, entry.name) : entry.name;
    const normalizedPath = relativePath.replaceAll('\\', '/');
    const entryPath = join(rootDir, relativePath);
    const stats = lstatSync(entryPath);
    if (stats.isSymbolicLink()) {
      throw new Error(`CLI workspace runtime package contains a symlink: ${entryPath}`);
    }
    if (stats.isDirectory()) {
      hash.update(`dir\0${normalizedPath}\0`);
      hashPhysicalTree(hash, rootDir, relativePath);
      continue;
    }
    if (!stats.isFile()) {
      throw new Error(`CLI workspace runtime package contains a non-file entry: ${entryPath}`);
    }
    const bytes = readFileSync(entryPath);
    hash.update(`file\0${normalizedPath}\0${bytes.byteLength}\0`);
    hash.update(bytes);
    hash.update('\0');
  }
}

export function readCliNodeWorkspaceRuntimeIdentity({
  repoRoot,
  hostPackageDir,
}: Readonly<{
  repoRoot: string;
  hostPackageDir?: string;
}>): CliNodeWorkspaceRuntimeIdentity {
  const workspaceBundles = resolveInstalledCliNodeRuntimeWorkspaceBundles(
    repoRoot,
    hostPackageDir,
  );
  return readCliNodeWorkspaceRuntimeIdentityFromBundles(workspaceBundles);
}

function readCliNodeWorkspaceRuntimeIdentityFromBundles(
  workspaceBundles: ReadonlyArray<CliNodeRuntimeWorkspaceBundle>,
): CliNodeWorkspaceRuntimeIdentity {
  const hash = createHash('sha256');
  hash.update('happier:cli-node-workspace-runtime:v1\0');
  for (const { packageName, srcDir } of workspaceBundles) {
    if (!existsSync(srcDir)) {
      throw new Error(`Missing installed CLI workspace runtime package: ${packageName} (${srcDir})`);
    }
    hash.update(`package\0${packageName}\0`);
    hashPhysicalTree(hash, srcDir);
  }
  return {
    fingerprint: hash.digest('hex'),
    packageCount: workspaceBundles.length,
    packageNames: workspaceBundles.map(({ packageName }) => packageName),
  };
}

function resolveRuntimeRootCliNodeWorkspaceBundles(
  runtimeRoot: string,
  payloadDir: string,
  packageNames: readonly string[],
): ReadonlyArray<CliNodeRuntimeWorkspaceBundle> {
  if (
    packageNames.length === 0
    || new Set(packageNames).size !== packageNames.length
    || packageNames.some((packageName) => !/^@happier-dev\/[a-z0-9][a-z0-9._-]*$/u.test(packageName))
  ) {
    throw new Error('Invalid CLI workspace runtime package membership');
  }
  return packageNames.map((packageName) => ({
    packageName,
    srcDir: join(runtimeRoot, 'node_modules', ...packageName.split('/')),
    destDir: join(payloadDir, 'node_modules', ...packageName.split('/')),
    dereferenceRootDir: runtimeRoot,
  }));
}

function readCliNodeWorkspaceRuntimeIdentityFromRuntimeRoot({
  runtimeRoot,
  packageNames,
}: Readonly<{
  runtimeRoot: string;
  packageNames: readonly string[];
}>): CliNodeWorkspaceRuntimeIdentity {
  return readCliNodeWorkspaceRuntimeIdentityFromBundles(
    resolveRuntimeRootCliNodeWorkspaceBundles(runtimeRoot, runtimeRoot, packageNames),
  );
}

async function copyCliNodeRuntimeDist(distDir: string, payloadDir: string): Promise<void> {
  await cp(distDir, join(payloadDir, 'package-dist'), { recursive: true });
}

function stageCliNodeRuntimeWorkspaceBundles(
  payloadDir: string,
  workspaceBundles: ReadonlyArray<CliNodeRuntimeWorkspaceBundle>,
  options: Readonly<{ includeRuntimeDependencies: boolean }>,
): void {
  for (const { packageName, srcDir, dereferenceRootDir } of workspaceBundles) {
    const destDir = join(payloadDir, 'node_modules', ...packageName.split('/'));
    if (options.includeRuntimeDependencies) {
      bundleWorkspacePackageWithRuntimeDependencies({
        packageName,
        srcDir,
        destDir,
        dereferenceRootDir,
      });
    } else {
      bundleWorkspacePackage({ packageName, srcDir, destDir });
    }
  }
}

function stageInstalledCliNodeRuntimeWorkspaceBundles(
  repoRoot: string,
  payloadDir: string,
  options: Readonly<{
    includeRuntimeDependencies: boolean;
    expectedIdentity?: string;
  }>,
): CliNodeWorkspaceRuntimeIdentity {
  const before = readCliNodeWorkspaceRuntimeIdentity({ repoRoot });
  if (options.expectedIdentity && before.fingerprint !== options.expectedIdentity) {
    throw new Error(
      `CLI workspace runtime publication changed before staging `
      + `(expected ${options.expectedIdentity}, found ${before.fingerprint})`,
    );
  }
  stageCliNodeRuntimeWorkspaceBundles(
    payloadDir,
    resolveInstalledCliNodeRuntimeWorkspaceBundles(repoRoot),
    { includeRuntimeDependencies: options.includeRuntimeDependencies },
  );
  const after = readCliNodeWorkspaceRuntimeIdentity({ repoRoot });
  if (after.fingerprint !== before.fingerprint) {
    throw new Error(
      `CLI workspace runtime publication changed while staging `
      + `(before ${before.fingerprint}, after ${after.fingerprint})`,
    );
  }
  return before;
}

function vendorCliNodeRuntimeHostPackageDependencies(repoRoot: string, payloadDir: string): void {
  vendorBundledPackageRuntimeDependencies({
    srcPackageJsonPath: join(repoRoot, 'apps', 'cli', 'package.json'),
    destPackageDir: payloadDir,
    dereferenceRootDir: repoRoot,
  });
}

export function copyCliNodeRuntimeDependencies({
  repoRoot,
  payloadDir,
  expectedWorkspaceRuntimeIdentity,
}: Readonly<{
  repoRoot: string;
  payloadDir: string;
  expectedWorkspaceRuntimeIdentity?: string;
}>): CliNodeWorkspaceRuntimeIdentity {
  vendorCliNodeRuntimeHostPackageDependencies(repoRoot, payloadDir);
  return stageInstalledCliNodeRuntimeWorkspaceBundles(repoRoot, payloadDir, {
    includeRuntimeDependencies: true,
    expectedIdentity: expectedWorkspaceRuntimeIdentity,
  });
}

export function copyCliNodeWorkspaceRuntimePackages({
  repoRoot,
  payloadDir,
  expectedWorkspaceRuntimeIdentity,
}: Readonly<{
  repoRoot: string;
  payloadDir: string;
  expectedWorkspaceRuntimeIdentity?: string;
}>): CliNodeWorkspaceRuntimeIdentity {
  return stageInstalledCliNodeRuntimeWorkspaceBundles(repoRoot, payloadDir, {
    includeRuntimeDependencies: false,
    expectedIdentity: expectedWorkspaceRuntimeIdentity,
  });
}

export function copyCliNodeWorkspaceRuntimePackagesFromRuntimeRoot({
  runtimeRoot,
  payloadDir,
  packageNames,
  expectedWorkspaceRuntimeIdentity,
}: Readonly<{
  runtimeRoot: string;
  payloadDir: string;
  packageNames: readonly string[];
  expectedWorkspaceRuntimeIdentity: string;
}>): CliNodeWorkspaceRuntimeIdentity {
  const sourceBundles = resolveRuntimeRootCliNodeWorkspaceBundles(
    runtimeRoot,
    payloadDir,
    packageNames,
  );
  const before = readCliNodeWorkspaceRuntimeIdentityFromBundles(sourceBundles);
  if (before.fingerprint !== expectedWorkspaceRuntimeIdentity) {
    throw new Error(
      `CLI artifact workspace runtime does not match its dist publication `
      + `(expected ${expectedWorkspaceRuntimeIdentity}, found ${before.fingerprint})`,
    );
  }
  stageCliNodeRuntimeWorkspaceBundles(payloadDir, sourceBundles, {
    includeRuntimeDependencies: false,
  });
  const staged = readCliNodeWorkspaceRuntimeIdentityFromBundles(
    sourceBundles.map((bundle) => ({
      ...bundle,
      srcDir: bundle.destDir,
    })),
  );
  if (staged.fingerprint !== before.fingerprint) {
    throw new Error(
      `CLI artifact workspace runtime was not staged exactly `
      + `(expected ${before.fingerprint}, found ${staged.fingerprint})`,
    );
  }
  return before;
}

export async function copyCliNodeRuntimePayload({
  repoRoot,
  payloadDir,
  distDir,
  expectedWorkspaceRuntimeIdentity,
}: Readonly<{
  repoRoot: string;
  payloadDir: string;
  distDir: string;
  expectedWorkspaceRuntimeIdentity?: string;
}>): Promise<CliNodeWorkspaceRuntimeIdentity> {
  await copyCliNodeRuntimeDist(distDir, payloadDir);
  const sourceWorkspaceRuntime = copyCliNodeRuntimeDependencies({
    repoRoot,
    payloadDir,
    expectedWorkspaceRuntimeIdentity,
  });
  return readCliNodeWorkspaceRuntimeIdentityFromRuntimeRoot({
    runtimeRoot: payloadDir,
    packageNames: sourceWorkspaceRuntime.packageNames,
  });
}
