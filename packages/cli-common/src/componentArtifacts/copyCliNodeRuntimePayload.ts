import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  type Dirent,
  type Stats,
} from 'node:fs';
import { cp, lstat, readFile, readdir } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';

import {
  copyDirDereferenceContainedSync,
  resolveInstalledRuntimePackage,
} from '../../workspaceRuntimeDependencies.mjs';
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
export function compareCliNodeRuntimePayloadEntryNames(
  left: string,
  right: string,
): number {
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
  const resolveFromPackageJsonPath = join(hostPackageDir, 'package.json');
  return resolveCliNodeRuntimeWorkspaceBundles(repoRoot, hostPackageDir).map(
    (bundle) => {
      const installedPackage = resolveInstalledRuntimePackage({
        packageName: bundle.packageName,
        resolveFromPackageJsonPath,
        dereferenceRootDir: repoRoot,
      });
      return {
        ...bundle,
        srcDir: installedPackage.packageDir,
      };
    },
  );
}

function orderedPhysicalTreeEntries(entries: Dirent[]): Dirent[] {
  return entries
    .filter((entry) => entry.name !== 'node_modules')
    .sort((left, right) =>
      compareCliNodeRuntimePayloadEntryNames(left.name, right.name),
    );
}

function appendPhysicalTreeEntry(
  hash: ReturnType<typeof createHash>,
  entryPath: string,
  relativePath: string,
  stats: Stats,
): 'directory' | 'file' {
  if (stats.isSymbolicLink()) {
    throw new Error(
      `CLI workspace runtime package contains a symlink: ${entryPath}`,
    );
  }
  if (stats.isDirectory()) {
    hash.update(`dir\0${relativePath.replaceAll('\\', '/')}\0`);
    return 'directory';
  }
  if (!stats.isFile()) {
    throw new Error(
      `CLI workspace runtime package contains a non-file entry: ${entryPath}`,
    );
  }
  return 'file';
}

function appendPhysicalFileContents(
  hash: ReturnType<typeof createHash>,
  relativePath: string,
  bytes: Buffer,
): void {
  hash.update(
    `file\0${relativePath.replaceAll('\\', '/')}\0${bytes.byteLength}\0`,
  );
  hash.update(bytes);
  hash.update('\0');
}

function hashPhysicalTree(
  hash: ReturnType<typeof createHash>,
  rootDir: string,
  relativeDir = '',
): void {
  const directoryPath = relativeDir ? join(rootDir, relativeDir) : rootDir;
  const entries = orderedPhysicalTreeEntries(
    readdirSync(directoryPath, { withFileTypes: true }),
  );
  for (const entry of entries) {
    const relativePath = relativeDir
      ? join(relativeDir, entry.name)
      : entry.name;
    const entryPath = join(rootDir, relativePath);
    if (
      appendPhysicalTreeEntry(
        hash,
        entryPath,
        relativePath,
        lstatSync(entryPath),
      ) === 'directory'
    ) {
      hashPhysicalTree(hash, rootDir, relativePath);
      continue;
    }
    appendPhysicalFileContents(hash, relativePath, readFileSync(entryPath));
  }
}

async function hashPhysicalTreeAsync(
  hash: ReturnType<typeof createHash>,
  rootDir: string,
  relativeDir = '',
): Promise<void> {
  const directoryPath = relativeDir ? join(rootDir, relativeDir) : rootDir;
  const entries = orderedPhysicalTreeEntries(
    await readdir(directoryPath, { withFileTypes: true }),
  );
  for (const entry of entries) {
    const relativePath = relativeDir
      ? join(relativeDir, entry.name)
      : entry.name;
    const entryPath = join(rootDir, relativePath);
    if (
      appendPhysicalTreeEntry(
        hash,
        entryPath,
        relativePath,
        await lstat(entryPath),
      ) === 'directory'
    ) {
      await hashPhysicalTreeAsync(hash, rootDir, relativePath);
      continue;
    }
    appendPhysicalFileContents(hash, relativePath, await readFile(entryPath));
  }
}

function* workspaceRuntimeIdentityPackages(
  hash: ReturnType<typeof createHash>,
  workspaceBundles: ReadonlyArray<CliNodeRuntimeWorkspaceBundle>,
): Generator<string> {
  hash.update('happier:cli-node-workspace-runtime:v1\0');
  for (const { packageName, srcDir } of workspaceBundles) {
    if (!existsSync(srcDir)) {
      throw new Error(
        `Missing installed CLI workspace runtime package: ${packageName} (${srcDir})`,
      );
    }
    hash.update(`package\0${packageName}\0`);
    yield srcDir;
  }
}

function finishWorkspaceRuntimeIdentity(
  hash: ReturnType<typeof createHash>,
  workspaceBundles: ReadonlyArray<CliNodeRuntimeWorkspaceBundle>,
): CliNodeWorkspaceRuntimeIdentity {
  return {
    fingerprint: hash.digest('hex'),
    packageCount: workspaceBundles.length,
    packageNames: workspaceBundles.map(({ packageName }) => packageName),
  };
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

/** Observe the same physical identity without blocking a live host's service loop. */
export async function readCliNodeWorkspaceRuntimeIdentityAsync({
  repoRoot,
  hostPackageDir,
}: Readonly<{
  repoRoot: string;
  hostPackageDir?: string;
}>): Promise<CliNodeWorkspaceRuntimeIdentity> {
  const workspaceBundles = resolveInstalledCliNodeRuntimeWorkspaceBundles(
    repoRoot,
    hostPackageDir,
  );
  const hash = createHash('sha256');
  for (const srcDir of workspaceRuntimeIdentityPackages(
    hash,
    workspaceBundles,
  )) {
    await hashPhysicalTreeAsync(hash, srcDir);
  }
  return finishWorkspaceRuntimeIdentity(hash, workspaceBundles);
}

function readCliNodeWorkspaceRuntimeIdentityFromBundles(
  workspaceBundles: ReadonlyArray<CliNodeRuntimeWorkspaceBundle>,
): CliNodeWorkspaceRuntimeIdentity {
  const hash = createHash('sha256');
  for (const srcDir of workspaceRuntimeIdentityPackages(
    hash,
    workspaceBundles,
  )) {
    hashPhysicalTree(hash, srcDir);
  }
  return finishWorkspaceRuntimeIdentity(hash, workspaceBundles);
}

function resolveRuntimeRootCliNodeWorkspaceBundles(
  runtimeRoot: string,
  payloadDir: string,
  packageNames: readonly string[],
): ReadonlyArray<CliNodeRuntimeWorkspaceBundle> {
  if (
    new Set(packageNames).size !== packageNames.length ||
    packageNames.some(
      (packageName) =>
        !/^@happier-dev\/[a-z0-9][a-z0-9._-]*$/u.test(packageName),
    )
  ) {
    throw new Error('Invalid CLI workspace runtime package membership');
  }
  return packageNames.map((packageName) => ({
    packageName,
    srcDir: join(runtimeRoot, 'node_modules', ...packageName.split('/')),
    destDir: join(payloadDir, 'node_modules', ...packageName.split('/')),
    dereferenceRootDir: join(runtimeRoot, 'node_modules'),
  }));
}

export function readCliNodeWorkspaceRuntimeIdentityFromRuntimeRoot({
  runtimeRoot,
  packageNames,
}: Readonly<{
  runtimeRoot: string;
  packageNames: readonly string[];
}>): CliNodeWorkspaceRuntimeIdentity {
  return readCliNodeWorkspaceRuntimeIdentityFromBundles(
    resolveRuntimeRootCliNodeWorkspaceBundles(
      runtimeRoot,
      runtimeRoot,
      packageNames,
    ),
  );
}

async function copyCliNodeRuntimeDist(
  distDir: string,
  payloadDir: string,
): Promise<void> {
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

function stageAdmittedCliNodeRuntimeWorkspaceBundles(
  workspaceBundles: ReadonlyArray<CliNodeRuntimeWorkspaceBundle>,
  options: Readonly<{ includeRuntimeDependencies: boolean }>,
): void {
  for (const { srcDir, destDir, dereferenceRootDir } of workspaceBundles) {
    if (options.includeRuntimeDependencies) {
      copyDirDereferenceContainedSync({
        sourceDir: srcDir,
        destDir,
        dereferenceRootDir,
      });
      continue;
    }
    cpSync(srcDir, destDir, {
      recursive: true,
      force: true,
      filter: (sourcePath) =>
        sourcePath === srcDir || basename(sourcePath) !== 'node_modules',
    });
  }
}

function copyAdmittedCliNodeRuntimeWorkspaceBundlesExactly(
  workspaceBundles: ReadonlyArray<CliNodeRuntimeWorkspaceBundle>,
  expectedWorkspaceRuntimeIdentity: string,
  options: Readonly<{ includeRuntimeDependencies: boolean }> = {
    includeRuntimeDependencies: false,
  },
): CliNodeWorkspaceRuntimeIdentity {
  const before =
    readCliNodeWorkspaceRuntimeIdentityFromBundles(workspaceBundles);
  if (before.fingerprint !== expectedWorkspaceRuntimeIdentity) {
    throw new Error(
      `CLI workspace runtime does not match its dist publication ` +
        `(expected ${expectedWorkspaceRuntimeIdentity}, found ${before.fingerprint})`,
    );
  }
  stageAdmittedCliNodeRuntimeWorkspaceBundles(workspaceBundles, options);
  const staged = readCliNodeWorkspaceRuntimeIdentityFromBundles(
    workspaceBundles.map((bundle) => ({
      ...bundle,
      srcDir: bundle.destDir,
    })),
  );
  if (staged.fingerprint !== before.fingerprint) {
    throw new Error(
      `CLI admitted workspace runtime was not staged exactly ` +
        `(expected ${before.fingerprint}, found ${staged.fingerprint})`,
    );
  }
  return before;
}

function stageAdmittedCliNodeRuntimeHostPackageDependencies(
  runtimeRoot: string,
  payloadDir: string,
  admittedPackageNames: readonly string[],
): void {
  const sourceNodeModulesDir = join(runtimeRoot, 'node_modules');
  if (!existsSync(sourceNodeModulesDir)) {
    throw new Error(
      `Missing admitted CLI runtime dependency closure: ${sourceNodeModulesDir}`,
    );
  }
  copyDirDereferenceContainedSync({
    sourceDir: sourceNodeModulesDir,
    destDir: join(payloadDir, 'node_modules'),
    dereferenceRootDir: sourceNodeModulesDir,
    shouldCopyPath: (sourcePath) => {
      const segments = relative(sourceNodeModulesDir, sourcePath).split(
        /[\\/]/u,
      );
      const packageName = segments
        .slice(0, segments[0]?.startsWith('@') ? 2 : 1)
        .join('/');
      return !admittedPackageNames.includes(packageName);
    },
  });
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
  if (
    options.expectedIdentity &&
    before.fingerprint !== options.expectedIdentity
  ) {
    throw new Error(
      `CLI workspace runtime publication changed before staging ` +
        `(expected ${options.expectedIdentity}, found ${before.fingerprint})`,
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
      `CLI workspace runtime publication changed while staging ` +
        `(before ${before.fingerprint}, after ${after.fingerprint})`,
    );
  }
  return before;
}

function vendorCliNodeRuntimeHostPackageDependencies(
  repoRoot: string,
  payloadDir: string,
  excludeRootDependencies?: readonly string[],
): void {
  vendorBundledPackageRuntimeDependencies({
    srcPackageJsonPath: join(repoRoot, 'apps', 'cli', 'package.json'),
    destPackageDir: payloadDir,
    dereferenceRootDir: repoRoot,
    excludeRootDependencies,
  });
}

export function copyCliNodeRuntimeDependencies({
  repoRoot,
  payloadDir,
  expectedWorkspaceRuntimeIdentity,
  excludeRootDependencies,
}: Readonly<{
  repoRoot: string;
  payloadDir: string;
  expectedWorkspaceRuntimeIdentity?: string;
  excludeRootDependencies?: readonly string[];
}>): CliNodeWorkspaceRuntimeIdentity {
  vendorCliNodeRuntimeHostPackageDependencies(
    repoRoot,
    payloadDir,
    excludeRootDependencies,
  );
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
  const sourceBundles = resolveInstalledCliNodeRuntimeWorkspaceBundles(
    repoRoot,
  ).map((bundle) => ({
    ...bundle,
    destDir: join(payloadDir, 'node_modules', ...bundle.packageName.split('/')),
  }));
  const admittedIdentity =
    expectedWorkspaceRuntimeIdentity ??
    readCliNodeWorkspaceRuntimeIdentityFromBundles(sourceBundles).fingerprint;
  return copyAdmittedCliNodeRuntimeWorkspaceBundlesExactly(
    sourceBundles,
    admittedIdentity,
  );
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
  // runtimeRoot already contains the admitted, content-identified package
  // publication. Preserve that tree instead of applying source-package
  // publication rules a second time: its sanitized package.json intentionally
  // no longer carries the source `files` list used to select static resources.
  const stagedWorkspaceRuntime =
    copyAdmittedCliNodeRuntimeWorkspaceBundlesExactly(
      sourceBundles,
      expectedWorkspaceRuntimeIdentity,
      { includeRuntimeDependencies: true },
    );
  // The support artifact stages the host package's external closure at its
  // node_modules root. A pinned runner executes the package-dist outside that
  // support artifact, so preserve that admitted closure alongside the copied
  // workspace packages instead of resolving against a mutable checkout.
  stageAdmittedCliNodeRuntimeHostPackageDependencies(
    runtimeRoot,
    payloadDir,
    packageNames,
  );
  return stagedWorkspaceRuntime;
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
