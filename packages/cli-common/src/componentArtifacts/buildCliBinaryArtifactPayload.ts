import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative, sep } from 'node:path';
import * as tar from 'tar';

import cliDistBuildManifest from '../../cliDistBuildManifest.cjs';
import {
  assertResolvedRuntimeDependencyMatchesDeclaration,
  collectExternalRuntimeDependencies,
  resolveInstalledRuntimePackage,
} from '../../workspaceRuntimeDependencies.mjs';
import { createWorkspaceChildBuildEnv } from '../../workspaceChildBuildEnv.mjs';
import {
  resolveCliSharedDepsBuildLockPath,
  withWorkspaceBundleLock,
} from '../../workspaceBundleLock.mjs';
import { CLI_BINARY_TARGETS, resolveCurrentBinaryTarget, resolveExecutableName, type BinaryTarget } from './targets.js';
import { commandExists, compileBunBinary, ensureFileExists, execOrThrow, resolveBunCommand, resolveYarnCommand, type RunCommand } from './commands.js';
import {
  bundleInstalledPackageWithRuntimeDependencies,
  bundleWorkspacePackageWithRuntimeDependencies,
  resolveWorkspaceBundlesFromPackageJson,
} from '../workspaces/index.js';
import { withCliDistBuildLock } from './withCliDistBuildLock.js';
import { resolveCliDistSnapshotDir } from './resolveCliDistSnapshotDir.js';
import {
  copyCliNodeRuntimeDependencies,
  readCliNodeWorkspaceRuntimeIdentity,
  readCliNodeWorkspaceRuntimeIdentityFromRuntimeRoot,
} from './copyCliNodeRuntimePayload.js';
import { finalizeRuntimeArtifactPayload } from './finalizeRuntimeArtifactPayload.js';
import { CLI_DEFERRED_VOICE_RUNTIME_PACKAGES } from './deferredVoiceRuntimePackages.js';
import type {
  BundledWorkspacePackage,
  EnsureWorkspacePackagesBuiltByName,
} from './ensureBundledWorkspacePackagesBuilt.js';
import { ensureBundledWorkspacePackagesBuilt } from './ensureBundledWorkspacePackagesBuilt.js';
import { shouldReuseCliDistSnapshot } from './shouldReuseCliDistSnapshot.js';
import { stageCliProxyApiManagedRuntime } from './stageCliProxyApiManagedRuntime.js';
import { CLI_RUNTIME_SIDECAR_ENTRIES } from './cliRuntimeSidecars.js';
import { writeCliBinaryArtifactRuntimeAssetBuildManifest } from './refreshCliBinaryArtifactRuntimeAssetBuildManifest.js';

export const CLI_RUNTIME_EXTERNAL_PACKAGES = [
  '@huggingface/transformers',
  'ffmpeg-static',
  'sherpa-onnx-node',
  'node-pty',
  '@homebridge/node-pty-prebuilt-multiarch',
] as const;

// Every shipped Fastify owner constructs its server with `logger: false`, so its
// optional Pino branch is deliberately absent from the standalone Bun image.
// The physical payload still contains the transitive packages for the Node
// runtime tree; compiled artifact smokes exercise every shipped HTTP owner.
const CLI_BUN_COMPILE_EXTERNAL_PACKAGES = [
  'pino',
  'thread-stream',
] as const;

const DAEMON_SUPPORT_ENTRYPOINT = '.happier-daemon-support.json';
const CLIPROXYAPI_MANAGED_RUNTIME_RELATIVE_PATH = join(
  'tools',
  'unpacked',
  'happier-cliproxyapi-managed',
);

type CliToolUnpackModule = {
  unpackTools?: (options: Readonly<{ platformDir: string; toolsDir: string }>) => Promise<unknown> | unknown;
};

type CliPackageJson = Readonly<{
  dependencies?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
}>;

export type CliBinaryArtifactSupportIdentity = Readonly<{
  fingerprint: string;
  workspaceRuntimeIdentity: string;
}>;

export type CliBinaryArtifactCodePayload = Readonly<{
  executableName: string;
  entrypoint: string;
  workspaceRuntimeIdentity: string;
  runtimeAssetRelativePath: string;
}>;

function isExactStringList(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((entry, index) => entry === expected[index]);
}

function normalizeNodePlatform(platform: string): string {
  return platform === 'win32' ? 'windows' : platform;
}

function resolveCliToolsPlatformDir(target: BinaryTarget): string {
  const targetKey = `${target.arch}-${target.os}`;
  switch (targetKey) {
    case 'arm64-darwin':
    case 'x64-darwin':
    case 'arm64-linux':
    case 'x64-linux':
      return targetKey;
    case 'x64-windows':
      return 'x64-win32';
    default:
      throw new Error(`[component-artifacts] unsupported CLI tools binary target: ${targetKey}`);
  }
}

function assertCliNativeRuntimeTargetMatchesHost(target: BinaryTarget): void {
  const hostOs = normalizeNodePlatform(process.platform);
  const hostArch = process.arch;
  if (hostOs === target.os && hostArch === target.arch) {
    return;
  }
  throw new Error(
    `[component-artifacts] host-native runtime packages require a matching host target (host ${hostOs}-${hostArch}, target ${target.os}-${target.arch})`,
  );
}

function compareSupportIdentityPathNames(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function assertPhysicalPathWithinRepoRoot(repoRoot: string, path: string): string {
  const physicalRepoRoot = realpathSync(repoRoot);
  const physicalPath = realpathSync(path);
  const relativePath = relative(physicalRepoRoot, physicalPath);
  if (
    relativePath === '..'
    || relativePath.startsWith(`..${sep}`)
    || isAbsolute(relativePath)
  ) {
    throw new Error(
      `[component-artifacts] daemon support input escapes the repository root: ${physicalPath} (root: ${physicalRepoRoot})`,
    );
  }
  return physicalPath;
}

function hashSupportInputTree({
  hash,
  repoRoot,
  sourcePath,
  label,
}: Readonly<{
  hash: ReturnType<typeof createHash>;
  repoRoot: string;
  sourcePath: string;
  label: string;
}>): void {
  const activeDirectories = new Set<string>();

  const visit = (path: string, relativePath: string): void => {
    const entry = lstatSync(path);
    if (entry.isSymbolicLink()) {
      const resolvedTarget = assertPhysicalPathWithinRepoRoot(repoRoot, path);
      hash.update(`link\0${label}\0${relativePath.replaceAll('\\', '/')}\0`);
      visit(resolvedTarget, relativePath);
      return;
    }
    if (entry.isDirectory()) {
      const physicalPath = assertPhysicalPathWithinRepoRoot(repoRoot, path);
      if (activeDirectories.has(physicalPath)) {
        throw new Error(`[component-artifacts] daemon support input contains a directory symlink cycle: ${path}`);
      }
      activeDirectories.add(physicalPath);
      hash.update(`dir\0${label}\0${relativePath.replaceAll('\\', '/')}\0`);
      for (const child of readdirSync(path, { withFileTypes: true })
        .sort((left, right) => compareSupportIdentityPathNames(left.name, right.name))) {
        visit(join(path, child.name), relativePath ? join(relativePath, child.name) : child.name);
      }
      activeDirectories.delete(physicalPath);
      return;
    }
    if (!entry.isFile()) {
      throw new Error(`[component-artifacts] daemon support input has an unsupported file type: ${path}`);
    }
    const bytes = readFileSync(path);
    hash.update(`file\0${label}\0${relativePath.replaceAll('\\', '/')}\0${entry.mode & 0o7777}\0${bytes.byteLength}\0`);
    hash.update(bytes);
    hash.update('\0');
  };

  assertPhysicalPathWithinRepoRoot(repoRoot, sourcePath);
  visit(sourcePath, '');
}

function hashRequiredSupportInputPath({
  hash,
  repoRoot,
  sourcePath,
  label,
}: Readonly<{
  hash: ReturnType<typeof createHash>;
  repoRoot: string;
  sourcePath: string;
  label: string;
}>): void {
  if (!existsSync(sourcePath)) {
    throw new Error(`[component-artifacts] missing daemon support input: ${sourcePath}`);
  }
  hashSupportInputTree({ hash, repoRoot, sourcePath, label });
}

function readCliPackageJson(repoRoot: string): CliPackageJson {
  const packageJsonPath = join(repoRoot, 'apps', 'cli', 'package.json');
  return JSON.parse(readFileSync(packageJsonPath, 'utf8')) as CliPackageJson;
}

function readRequiredCliRuntimePackageSpecs(repoRoot: string): ReadonlyArray<Readonly<{
  packageName: string;
  declaredSpec: string;
}>> {
  const cliPackageJson = readCliPackageJson(repoRoot);
  return CLI_RUNTIME_EXTERNAL_PACKAGES.map((packageName) => {
    const declaredSpec = cliPackageJson.dependencies?.[packageName]
      ?? cliPackageJson.optionalDependencies?.[packageName];
    if (typeof declaredSpec !== 'string' || !declaredSpec.trim()) {
      throw new Error(
        `[component-artifacts] missing CLI runtime dependency declaration for ${packageName}`,
      );
    }
    return { packageName, declaredSpec: declaredSpec.trim() };
  });
}

function hashRuntimeDependencyTree({
  hash,
  repoRoot,
  packageJsonPath,
  resolveFromPackageJsonPath = packageJsonPath,
  destinationNodeModulesPath,
  visitedDestinations = new Set<string>(),
  activeSourcePackageDirs = new Set<string>(),
}: Readonly<{
  hash: ReturnType<typeof createHash>;
  repoRoot: string;
  packageJsonPath: string;
  resolveFromPackageJsonPath?: string;
  destinationNodeModulesPath: string;
  visitedDestinations?: Set<string>;
  activeSourcePackageDirs?: Set<string>;
}>): void {
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as CliPackageJson;
  for (const dependency of collectExternalRuntimeDependencies(packageJson)) {
    let resolvedPackage: ReturnType<typeof resolveInstalledRuntimePackage>;
    try {
      resolvedPackage = resolveInstalledRuntimePackage({
        packageName: dependency.name,
        resolveFromPackageJsonPath,
        dereferenceRootDir: repoRoot,
      });
    } catch (error) {
      if (dependency.optional && (error as NodeJS.ErrnoException | undefined)?.code === 'MODULE_NOT_FOUND') {
        continue;
      }
      throw error;
    }
    assertResolvedRuntimeDependencyMatchesDeclaration({
      dependency,
      resolvedPackageJsonPath: resolvedPackage.packageJsonPath,
      resolvedPackageJson: resolvedPackage.packageJson,
    });
    const physicalSourcePackageDir = assertPhysicalPathWithinRepoRoot(repoRoot, resolvedPackage.packageDir);
    if (activeSourcePackageDirs.has(physicalSourcePackageDir)) continue;

    const destinationPath = join(destinationNodeModulesPath, ...dependency.name.split('/'));
    if (visitedDestinations.has(destinationPath)) continue;
    visitedDestinations.add(destinationPath);
    hash.update(`runtime-package\0${destinationPath.replaceAll('\\', '/')}\0${dependency.declaredSpec}\0`);
    hashSupportInputTree({
      hash,
      repoRoot,
      sourcePath: resolvedPackage.packageDir,
      label: `runtime-package:${destinationPath.replaceAll('\\', '/')}`,
    });

    const nextActiveSourcePackageDirs = new Set(activeSourcePackageDirs);
    nextActiveSourcePackageDirs.add(physicalSourcePackageDir);
    hashRuntimeDependencyTree({
      hash,
      repoRoot,
      packageJsonPath: resolvedPackage.packageJsonPath,
      resolveFromPackageJsonPath: realpathSync(resolvedPackage.packageJsonPath),
      destinationNodeModulesPath: join(destinationPath, 'node_modules'),
      visitedDestinations,
      activeSourcePackageDirs: nextActiveSourcePackageDirs,
    });
  }
}

/**
 * The daemon support artifact is intentionally owned by the CLI artifact
 * builder. Its identity is the exact source closure that the existing support
 * bundlers stage, plus the platform and Go toolchain that produce the managed
 * CLIProxyAPI executable. It is not a reusable cross-component layer format.
 */
export function readCliBinaryArtifactSupportIdentity({
  repoRoot,
  target = resolveCurrentBinaryTarget({ availableTargets: CLI_BINARY_TARGETS }),
  goVersion,
  cliProxyApiManagedRuntimeExecutablePath,
}: Readonly<{
  repoRoot: string;
  target?: BinaryTarget;
  goVersion: string;
  cliProxyApiManagedRuntimeExecutablePath?: string;
}>): CliBinaryArtifactSupportIdentity {
  assertCliNativeRuntimeTargetMatchesHost(target);
  const normalizedGoVersion = String(goVersion ?? '').trim();
  if (!normalizedGoVersion) {
    throw new Error('[component-artifacts] daemon support identity requires a Go toolchain version');
  }

  const hash = createHash('sha256');
  hash.update('happier:daemon-runtime-support:v1\0');
  hash.update(`target\0${target.os}\0${target.arch}\0${target.exeExt}\0`);
  hash.update(`node\0${process.version}\0`);
  hash.update(`go\0${normalizedGoVersion}\0`);

  const cliDir = join(repoRoot, 'apps', 'cli');
  const workspaceRuntime = readCliNodeWorkspaceRuntimeIdentity({ repoRoot, hostPackageDir: cliDir });
  hash.update(`workspace-runtime\0${workspaceRuntime.fingerprint}\0`);
  for (const packageName of workspaceRuntime.packageNames) {
    const packageDir = join(cliDir, 'node_modules', ...packageName.split('/'));
    const packageJsonPath = join(packageDir, 'package.json');
    hash.update(`workspace-package\0${packageName}\0`);
    hashRuntimeDependencyTree({
      hash,
      repoRoot,
      packageJsonPath,
      destinationNodeModulesPath: join('node_modules', ...packageName.split('/'), 'node_modules'),
    });
  }

  const cliPackageJsonPath = join(cliDir, 'package.json');
  hashRuntimeDependencyTree({
    hash,
    repoRoot,
    packageJsonPath: cliPackageJsonPath,
    destinationNodeModulesPath: 'node_modules',
  });
  for (const { packageName, declaredSpec } of readRequiredCliRuntimePackageSpecs(repoRoot)) {
    hash.update(`required-runtime-package\0${packageName}\0${declaredSpec}\0`);
  }

  for (const segments of CLI_RUNTIME_SIDECAR_ENTRIES) {
    const relativePath = join('apps', 'cli', 'scripts', ...segments);
    hashRequiredSupportInputPath({
      hash,
      repoRoot,
      sourcePath: join(repoRoot, relativePath),
      label: `sidecar:${relativePath.replaceAll('\\', '/')}`,
    });
  }
  hashRequiredSupportInputPath({
    hash,
    repoRoot,
    sourcePath: join(repoRoot, 'apps', 'cli', 'tools', 'archives'),
    label: 'tools:archives',
  });
  hashRequiredSupportInputPath({
    hash,
    repoRoot,
    sourcePath: join(repoRoot, 'apps', 'cli', 'scripts', 'unpack-tools.cjs'),
    label: 'tools:unpack-script',
  });
  hashRequiredSupportInputPath({
    hash,
    repoRoot,
    sourcePath: join(repoRoot, 'packages', 'plugins', 'cliproxyapi', 'package.json'),
    label: 'cliproxyapi:package-json',
  });
  hashRequiredSupportInputPath({
    hash,
    repoRoot,
    sourcePath: join(repoRoot, 'packages', 'plugins', 'cliproxyapi', 'managed-runtime'),
    label: 'cliproxyapi:managed-runtime',
  });
  if (cliProxyApiManagedRuntimeExecutablePath) {
    hashRequiredSupportInputPath({
      hash,
      repoRoot,
      sourcePath: cliProxyApiManagedRuntimeExecutablePath,
      label: 'cliproxyapi:prebuilt-runtime',
    });
  }

  // The support payload can change when its owner’s staging/finalization
  // semantics change. Keep those implementation inputs owner-local rather
  // than giving a component consumer a second closure decision.
  for (const relativePath of [
    'packages/cli-common/src/componentArtifacts/buildCliBinaryArtifactPayload.ts',
    'packages/cli-common/src/componentArtifacts/copyCliNodeRuntimePayload.ts',
    'packages/cli-common/src/componentArtifacts/finalizeRuntimeArtifactPayload.ts',
    'packages/cli-common/src/componentArtifacts/stageCliProxyApiManagedRuntime.ts',
    'packages/cli-common/src/componentArtifacts/deferredVoiceRuntimePackages.ts',
    'packages/cli-common/src/componentArtifacts/cliRuntimeSidecars.ts',
    'packages/cli-common/src/workspaces/index.ts',
    'packages/cli-common/workspaceRuntimeDependencies.mjs',
  ]) {
    hashRequiredSupportInputPath({
      hash,
      repoRoot,
      sourcePath: join(repoRoot, relativePath),
      label: `owner:${relativePath}`,
    });
  }

  return {
    fingerprint: hash.digest('hex'),
    workspaceRuntimeIdentity: workspaceRuntime.fingerprint,
  };
}

async function copyCliRuntimeSidecars(repoRoot: string, payloadDir: string): Promise<void> {
  for (const segments of CLI_RUNTIME_SIDECAR_ENTRIES) {
    const sourcePath = join(repoRoot, 'apps', 'cli', 'scripts', ...segments);
    const targetPath = join(payloadDir, 'scripts', ...segments);
    await mkdir(join(targetPath, '..'), { recursive: true });
    await cp(sourcePath, targetPath, { recursive: true });
  }

  const resolveFromPackageJsonPath = join(repoRoot, 'apps', 'cli', 'package.json');
  for (const { packageName, declaredSpec } of readRequiredCliRuntimePackageSpecs(repoRoot)) {
    bundleInstalledPackageWithRuntimeDependencies({
      packageName,
      declaredSpec,
      resolveFromPackageJsonPath,
      destNodeModulesDir: join(payloadDir, 'node_modules'),
      dereferenceRootDir: repoRoot,
    });
  }
}

async function copyCliRuntimeTools(repoRoot: string, payloadDir: string, target: BinaryTarget): Promise<void> {
  const sourceToolsDir = join(repoRoot, 'apps', 'cli', 'tools');
  const targetToolsDir = join(payloadDir, 'tools');
  const targetArchivesDir = join(targetToolsDir, 'archives');
  await mkdir(targetToolsDir, { recursive: true });
  await rm(targetArchivesDir, { recursive: true, force: true });
  await cp(join(sourceToolsDir, 'archives'), targetArchivesDir, { recursive: true });

  const unpackToolsScript = join(repoRoot, 'apps', 'cli', 'scripts', 'unpack-tools.cjs');
  const requireFromUnpackTools = createRequire(unpackToolsScript);
  const unpackToolsModule = requireFromUnpackTools(unpackToolsScript) as CliToolUnpackModule;
  if (typeof unpackToolsModule.unpackTools !== 'function') {
    throw new Error('[component-artifacts] apps/cli/scripts/unpack-tools.cjs must export unpackTools()');
  }

  await unpackToolsModule.unpackTools({
    platformDir: resolveCliToolsPlatformDir(target),
    toolsDir: targetToolsDir,
  });
  await rm(targetArchivesDir, { recursive: true, force: true });
}

function resolveDeferredVoiceInferenceRuntimeArchiveName(target: BinaryTarget): string {
  return `voice-inference-runtime-${target.os}-${target.arch}.tar.gz`;
}

async function stageDeferredVoiceInferenceRuntimeArchive(payloadDir: string, target: BinaryTarget): Promise<void> {
  const runtimePackageEntries = CLI_DEFERRED_VOICE_RUNTIME_PACKAGES
    .map((packageName) => join('node_modules', ...packageName.split('/')))
    .filter((relativePath) => existsSync(join(payloadDir, relativePath)));

  if (runtimePackageEntries.length === 0) {
    return;
  }

  const archivePath = join(
    payloadDir,
    'tools',
    'archives',
    resolveDeferredVoiceInferenceRuntimeArchiveName(target),
  );
  await mkdir(join(archivePath, '..'), { recursive: true });
  await tar.c({
    gzip: true,
    file: archivePath,
    cwd: payloadDir,
    portable: true,
  }, runtimePackageEntries);

  await Promise.all(runtimePackageEntries.map(async (relativePath) => {
    await rm(join(payloadDir, relativePath), { recursive: true, force: true });
  }));
}

function syncCliBundledWorkspacePackagesForCompile(
  repoRoot: string,
  cliDir: string,
  workspaceBundles: readonly BundledWorkspacePackage[],
): void {
  for (const { packageName, srcDir } of workspaceBundles) {
    bundleWorkspacePackageWithRuntimeDependencies({
      packageName,
      srcDir,
      destDir: join(cliDir, 'node_modules', ...packageName.split('/')),
      dereferenceRootDir: repoRoot,
    });
  }
}

async function prepareCliDistSnapshot({
  repoRoot,
  runCommand,
  ensureWorkspacePackagesBuiltByName,
  requiredCliDistInputFingerprint,
  commandProbe,
}: Readonly<{
  repoRoot: string;
  runCommand: RunCommand;
  ensureWorkspacePackagesBuiltByName?: EnsureWorkspacePackagesBuiltByName;
  requiredCliDistInputFingerprint?: string;
  commandProbe: (cmd: string) => boolean;
}>): Promise<Readonly<{
  snapshotDistDir: string;
  workspaceRuntimeIdentity: string;
  workspaceRuntimePackages: readonly string[];
  yarn: Readonly<{ cmd: string; args: string[] }>;
}>> {
  const cliDir = join(repoRoot, 'apps', 'cli');
  const distDir = join(cliDir, 'dist');
  const distBackupDir = join(cliDir, '.dist.hstack-backup');
  const entrypoint = join(distDir, 'index.mjs');
  const lockPath = join(repoRoot, '.project', 'tmp', 'cli-dist-build.lock');
  const yarn = resolveYarnCommand({ commandProbe });
  const workspaceBundles = resolveWorkspaceBundlesFromPackageJson({
    repoRoot,
    hostPackageDir: cliDir,
  });
  await ensureBundledWorkspacePackagesBuilt({
    repoRoot,
    bundles: workspaceBundles.map(({ packageName, srcDir }) => ({ packageName, srcDir })),
    ensureWorkspacePackagesBuiltByName,
  });
  const prepared = await withWorkspaceBundleLock(() => {
    syncCliBundledWorkspacePackagesForCompile(repoRoot, cliDir, workspaceBundles);
    return withCliDistBuildLock<{
      snapshotDistDir: string;
      workspaceRuntimeIdentity: string;
      workspaceRuntimePackages: readonly string[];
    }>(async ({ heldLockValue }) => {
      const runCommandWithHeldDistLock: RunCommand = (cmd, args, options = {}) => runCommand(cmd, args, {
        ...options,
        env: createWorkspaceChildBuildEnv({
          env: {
            ...process.env,
            ...(options.env ?? {}),
          },
          heldLockValue,
        }),
      });
      const workspaceRuntimeBeforeBuild = readCliNodeWorkspaceRuntimeIdentity({
        repoRoot,
        hostPackageDir: cliDir,
      });
      const currentDistManifest = cliDistBuildManifest.readCliDistBuildManifest(entrypoint);

      // If the CLI dist entrypoint is already present and is at least as new as the tracked inputs,
      // prefer snapshotting it instead of rebuilding. Rebuilding `apps/cli` is expensive and can
      // disrupt long-running processes in dev checkouts.
      const reuseExistingDistSnapshot = await shouldReuseCliDistSnapshot({
        distEntrypointPath: entrypoint,
        inputPaths: [
          join(cliDir, 'src'),
          join(cliDir, 'package.json'),
          ...workspaceBundles.map(({ srcDir }) => join(srcDir, 'dist')),
        ],
        requiredInputFingerprint: requiredCliDistInputFingerprint,
      })
        && currentDistManifest.manifest?.workspaceRuntimeIdentity
          === workspaceRuntimeBeforeBuild.fingerprint
          && isExactStringList(
            currentDistManifest.manifest?.workspaceRuntimePackages,
            workspaceRuntimeBeforeBuild.packageNames,
          );
      const snapshotDistDir = await resolveCliDistSnapshotDir({
        cliDir,
        distDir,
        distBackupDir,
        distEntrypointPath: entrypoint,
        reuseExistingDistSnapshot,
        buildDist: async () => {
          await runCommandWithHeldDistLock(yarn.cmd, [...yarn.args, '--cwd', 'apps/cli', 'build:prepared'], { cwd: repoRoot });
          await ensureFileExists(entrypoint);
        },
      });
      const workspaceRuntime = readCliNodeWorkspaceRuntimeIdentity({
        repoRoot,
        hostPackageDir: cliDir,
      });
      return {
        snapshotDistDir,
        workspaceRuntimeIdentity: workspaceRuntime.fingerprint,
        workspaceRuntimePackages: workspaceRuntime.packageNames,
      };
    }, { lockPath });
  }, {
    // pkgroll consumes the installed workspace closure below apps/cli/node_modules.
    // Keep the existing publication lock through that read so a source-dev refresh
    // cannot replace the closure halfway through a multi-minute bundle.
    lockPath: resolveCliSharedDepsBuildLockPath(repoRoot),
  });
  return { ...prepared, yarn };
}

export async function buildCliBinaryArtifactCodePayload({
  repoRoot,
  payloadDir,
  target = resolveCurrentBinaryTarget({ availableTargets: CLI_BINARY_TARGETS }),
  externals = [],
  runCommand = execOrThrow,
  commandProbe = commandExists,
  compileBinary = compileBunBinary,
  ensureWorkspacePackagesBuiltByName,
  requiredCliDistInputFingerprint,
}: {
  repoRoot: string;
  payloadDir: string;
  target?: BinaryTarget;
  externals?: string[];
  runCommand?: RunCommand;
  commandProbe?: (cmd: string) => boolean;
  compileBinary?: typeof compileBunBinary;
  ensureWorkspacePackagesBuiltByName?: EnsureWorkspacePackagesBuiltByName;
  requiredCliDistInputFingerprint?: string;
}): Promise<CliBinaryArtifactCodePayload> {
  const bunCommand = resolveBunCommand({ commandProbe });
  if (!bunCommand) {
    throw new Error('[component-artifacts] bun is required to build CLI binary artifacts');
  }
  assertCliNativeRuntimeTargetMatchesHost(target);

  const prepared = await prepareCliDistSnapshot({
    repoRoot,
    runCommand,
    ensureWorkspacePackagesBuiltByName,
    requiredCliDistInputFingerprint,
    commandProbe,
  });
  const snapshotEntrypoint = join(prepared.snapshotDistDir, 'index.mjs');
  const snapshotManifest = cliDistBuildManifest.readCliDistBuildManifest(snapshotEntrypoint);
  const recordedWorkspaceRuntimeIdentity = String(
    snapshotManifest.manifest?.workspaceRuntimeIdentity ?? '',
  ).trim().toLowerCase();
  if (
    !snapshotManifest.ok
    || recordedWorkspaceRuntimeIdentity !== prepared.workspaceRuntimeIdentity
    || !isExactStringList(
      snapshotManifest.manifest?.workspaceRuntimePackages,
      prepared.workspaceRuntimePackages,
    )
  ) {
    await rm(prepared.snapshotDistDir, { recursive: true, force: true }).catch(() => {});
    throw new Error(
      '[component-artifacts] CLI dist snapshot does not match its workspace runtime publication',
    );
  }

  try {
    await mkdir(payloadDir, { recursive: true });
    const executableName = resolveExecutableName({ baseName: 'happier', target });
    const mergedExternals = [...new Set([
      ...CLI_RUNTIME_EXTERNAL_PACKAGES,
      ...CLI_BUN_COMPILE_EXTERNAL_PACKAGES,
      ...externals.map((value) => String(value ?? '').trim()).filter(Boolean),
    ])];
    await rm(join(payloadDir, executableName), { recursive: true, force: true });
    await compileBinary({
      entrypoint: snapshotEntrypoint,
      bunTarget: target.bunTarget,
      outfile: join(payloadDir, executableName),
      cwd: repoRoot,
      externals: mergedExternals,
      bunCommand,
      runCommand,
    });
    await rm(join(payloadDir, 'package-dist'), { recursive: true, force: true });
    await cp(prepared.snapshotDistDir, join(payloadDir, 'package-dist'), { recursive: true });
    // The source dist manifest detects build-host publication churn. The code
    // artifact binds its exact workspace publication even when the physical
    // workspace dependency tree lives in a separate daemon support artifact.
    cliDistBuildManifest.writeCliDistWorkspaceRuntimeIdentity({
      entrypoint: join(payloadDir, 'package-dist', 'index.mjs'),
      workspaceRuntimeIdentity: recordedWorkspaceRuntimeIdentity,
    });

    return {
      executableName,
      entrypoint: executableName,
      workspaceRuntimeIdentity: recordedWorkspaceRuntimeIdentity,
      runtimeAssetRelativePath: `${CLIPROXYAPI_MANAGED_RUNTIME_RELATIVE_PATH}${target.exeExt}`.replaceAll('\\', '/'),
    };
  } finally {
    await rm(prepared.snapshotDistDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function stageCliBinaryArtifactSupportPayload({
  repoRoot,
  payloadDir,
  target = resolveCurrentBinaryTarget({ availableTargets: CLI_BINARY_TARGETS }),
  runCommand = execOrThrow,
  commandProbe = commandExists,
  cliProxyApiManagedRuntimeExecutablePath,
  expectedWorkspaceRuntimeIdentity,
  supportArtifactFingerprint,
  goVersion,
  preserveCompilePayloadAssets = false,
}: {
  repoRoot: string;
  payloadDir: string;
  target?: BinaryTarget;
  runCommand?: RunCommand;
  commandProbe?: (cmd: string) => boolean;
  cliProxyApiManagedRuntimeExecutablePath?: string;
  expectedWorkspaceRuntimeIdentity?: string;
  supportArtifactFingerprint?: string;
  goVersion?: string;
  preserveCompilePayloadAssets?: boolean;
}): Promise<Readonly<{
  entrypoint: string;
  workspaceRuntimeIdentity: string;
  runtimeAssetRelativePath: string;
}>> {
  assertCliNativeRuntimeTargetMatchesHost(target);
  const expectedSupportFingerprint = String(supportArtifactFingerprint ?? '').trim();
  const normalizedGoVersion = String(goVersion ?? '').trim();
  if (expectedSupportFingerprint && !normalizedGoVersion) {
    throw new Error('[component-artifacts] daemon support publication requires its Go toolchain identity');
  }
  if (expectedSupportFingerprint) {
    const before = readCliBinaryArtifactSupportIdentity({
      repoRoot,
      target,
      goVersion: normalizedGoVersion,
      cliProxyApiManagedRuntimeExecutablePath,
    });
    if (before.fingerprint !== expectedSupportFingerprint) {
      throw new Error(
        `[component-artifacts] daemon support publication changed before staging (expected ${expectedSupportFingerprint}, found ${before.fingerprint})`,
      );
    }
  }

  const yarn = resolveYarnCommand({ commandProbe });
  await mkdir(payloadDir, { recursive: true });
  const runtimeSupportDirectories = preserveCompilePayloadAssets
    ? ['node_modules']
    : ['node_modules', 'tools', 'scripts'];
  await Promise.all(runtimeSupportDirectories.map(async (name) => {
    await rm(join(payloadDir, name), { recursive: true, force: true });
  }));

  const sourceWorkspaceRuntime = copyCliNodeRuntimeDependencies({
    repoRoot,
    payloadDir,
    expectedWorkspaceRuntimeIdentity,
  });
  const stagedWorkspaceRuntime = readCliNodeWorkspaceRuntimeIdentityFromRuntimeRoot({
    runtimeRoot: payloadDir,
    packageNames: sourceWorkspaceRuntime.packageNames,
  });
  await copyCliRuntimeSidecars(repoRoot, payloadDir);
  await copyCliRuntimeTools(repoRoot, payloadDir, target);
  const cliProxyApiManagedRuntime = await stageCliProxyApiManagedRuntime({
    repoRoot,
    payloadDir,
    target,
    yarn,
    runCommand,
    prebuiltExecutablePath: cliProxyApiManagedRuntimeExecutablePath,
  });
  await stageDeferredVoiceInferenceRuntimeArchive(payloadDir, target);
  if (expectedSupportFingerprint) {
    await writeFile(
      join(payloadDir, DAEMON_SUPPORT_ENTRYPOINT),
      `${JSON.stringify({ version: 1, artifactFingerprint: expectedSupportFingerprint })}\n`,
      'utf8',
    );
  }
  await finalizeRuntimeArtifactPayload(payloadDir);

  if (expectedSupportFingerprint) {
    const after = readCliBinaryArtifactSupportIdentity({
      repoRoot,
      target,
      goVersion: normalizedGoVersion,
      cliProxyApiManagedRuntimeExecutablePath,
    });
    if (after.fingerprint !== expectedSupportFingerprint) {
      throw new Error(
        `[component-artifacts] daemon support publication changed while staging (expected ${expectedSupportFingerprint}, found ${after.fingerprint})`,
      );
    }
  }

  return {
    entrypoint: DAEMON_SUPPORT_ENTRYPOINT,
    workspaceRuntimeIdentity: stagedWorkspaceRuntime.fingerprint,
    runtimeAssetRelativePath: relative(
      payloadDir,
      cliProxyApiManagedRuntime.executablePath,
    ).replaceAll('\\', '/'),
  };
}

export async function buildCliBinaryArtifactSupportPayload({
  repoRoot,
  payloadDir,
  target = resolveCurrentBinaryTarget({ availableTargets: CLI_BINARY_TARGETS }),
  runCommand = execOrThrow,
  commandProbe = commandExists,
  cliProxyApiManagedRuntimeExecutablePath,
  expectedWorkspaceRuntimeIdentity,
  supportArtifactFingerprint,
  goVersion,
  preserveCompilePayloadAssets = false,
}: {
  repoRoot: string;
  payloadDir: string;
  target?: BinaryTarget;
  runCommand?: RunCommand;
  commandProbe?: (cmd: string) => boolean;
  cliProxyApiManagedRuntimeExecutablePath?: string;
  expectedWorkspaceRuntimeIdentity?: string;
  supportArtifactFingerprint?: string;
  goVersion?: string;
  preserveCompilePayloadAssets?: boolean;
}): Promise<Readonly<{
  entrypoint: string;
  workspaceRuntimeIdentity: string;
  runtimeAssetRelativePath: string;
}>> {
  return await stageCliBinaryArtifactSupportPayload({
    repoRoot,
    payloadDir,
    target,
    runCommand,
    commandProbe,
    cliProxyApiManagedRuntimeExecutablePath,
    expectedWorkspaceRuntimeIdentity,
    supportArtifactFingerprint,
    goVersion,
    preserveCompilePayloadAssets,
  });
}

/**
 * Legacy/self-contained payload builder retained for release packaging and old
 * artifacts. Managed daemon artifacts call the two owner-local functions
 * above, then reference the immutable support payload instead.
 */
export async function buildCliBinaryArtifactPayload({
  repoRoot,
  payloadDir,
  target = resolveCurrentBinaryTarget({ availableTargets: CLI_BINARY_TARGETS }),
  externals = [],
  runCommand = execOrThrow,
  commandProbe = commandExists,
  compileBinary = compileBunBinary,
  ensureWorkspacePackagesBuiltByName,
  cliProxyApiManagedRuntimeExecutablePath,
  requiredCliDistInputFingerprint,
}: {
  repoRoot: string;
  payloadDir: string;
  target?: BinaryTarget;
  externals?: string[];
  runCommand?: RunCommand;
  commandProbe?: (cmd: string) => boolean;
  compileBinary?: typeof compileBunBinary;
  ensureWorkspacePackagesBuiltByName?: EnsureWorkspacePackagesBuiltByName;
  cliProxyApiManagedRuntimeExecutablePath?: string;
  requiredCliDistInputFingerprint?: string;
}): Promise<{ executableName: string; entrypoint: string }> {
  await rm(payloadDir, { recursive: true, force: true });
  await mkdir(payloadDir, { recursive: true });
  const code = await buildCliBinaryArtifactCodePayload({
    repoRoot,
    payloadDir,
    target,
    externals,
    runCommand,
    commandProbe,
    compileBinary,
    ensureWorkspacePackagesBuiltByName,
    requiredCliDistInputFingerprint,
  });
  const support = await withCliDistBuildLock(
    async () => await buildCliBinaryArtifactSupportPayload({
      repoRoot,
      payloadDir,
      target,
      runCommand,
      commandProbe,
      cliProxyApiManagedRuntimeExecutablePath,
      expectedWorkspaceRuntimeIdentity: code.workspaceRuntimeIdentity,
      // The release payload preserves legitimate assets emitted alongside the
      // Bun executable (for example its managed JS runtime). New immutable
      // daemon support artifacts stage into an empty payload instead.
      preserveCompilePayloadAssets: true,
    }),
    { lockPath: join(repoRoot, '.project', 'tmp', 'cli-dist-build.lock') },
  );
  writeCliBinaryArtifactRuntimeAssetBuildManifest({
    payloadDir,
    relativePath: support.runtimeAssetRelativePath,
    workspaceRuntimeIdentity: support.workspaceRuntimeIdentity,
  });
  return {
    executableName: code.executableName,
    entrypoint: code.entrypoint,
  };
}
