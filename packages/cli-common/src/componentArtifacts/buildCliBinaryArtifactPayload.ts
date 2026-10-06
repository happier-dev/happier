import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { copyFile, cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative, sep } from 'node:path';

import cliDistBuildManifest from '../../cliDistBuildManifest.cjs';
import { getCliBinaryArtifactSupportTargetUnavailableReason } from '../../componentArtifactTarget.mjs';
import { BUNDLED_PLUGIN_PUBLICATION_FAILURES_RELATIVE_PATH as BUNDLED_PLUGIN_FAILURES_RELATIVE_PATH, parseBundledPluginPublicationFailures } from '../../bundledPluginPublicationPolicy.mjs';
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
import { CLI_BINARY_TARGETS, resolveCliToolsPlatformDir, resolveCurrentBinaryTarget, resolveExecutableName, type BinaryTarget } from './targets.js';
import { commandExists, compileBunBinary, ensureFileExists, execOrThrow, resolveBunCommand, resolveYarnCommand, type RunCommand } from './commands.js';
import {
  bundleInstalledPackageWithRuntimeDependencies,
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
import type {
  EnsureWorkspacePackagesBuiltByName,
} from './ensureBundledWorkspacePackagesBuilt.js';
import { buildCliBundledWorkspaceArtifactClosure } from './ensureBundledWorkspacePackagesBuilt.js';
import { shouldReuseCliDistSnapshot } from './shouldReuseCliDistSnapshot.js';
import { stageCliProxyApiManagedRuntime } from './stageCliProxyApiManagedRuntime.js';
import { stageProcessCustodyRuntime } from './stageProcessCustodyRuntime.js';
import { CLI_RUNTIME_SIDECAR_ENTRIES } from './cliRuntimeSidecars.js';
import { writeCliBinaryArtifactRuntimeAssetBuildManifest } from './refreshCliBinaryArtifactRuntimeAssetBuildManifest.js';
import { stageIrohNativeReleaseEvidence } from './stageIrohNativeReleaseEvidence.js';
import { stageCliTargetRuntimeDependencies } from './stageCliTargetRuntimeDependencies.js';

export { getCliBinaryArtifactSupportTargetUnavailableReason } from '../../componentArtifactTarget.mjs';

export const CLI_RUNTIME_EXTERNAL_PACKAGES = [
  '@huggingface/transformers',
  'ffmpeg-static',
  'sherpa-onnx-node',
  'node-pty',
  '@homebridge/node-pty-prebuilt-multiarch',
] as const;

const CLI_OPTIONAL_RUNTIME_PACKAGES: readonly string[] = [
  '@huggingface/transformers',
  'sherpa-onnx-node',
  'sherpa-onnx-darwin-arm64',
  'sherpa-onnx-darwin-x64',
  'sherpa-onnx-linux-arm64',
  'sherpa-onnx-linux-x64',
  'sherpa-onnx-win-arm64',
  'sherpa-onnx-win-x64',
];

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
  unpackTools?: (options: Readonly<{ platformDir: string; toolsDir: string; tools: readonly string[] }>) => Promise<unknown> | unknown;
};

type CliPackageJson = Readonly<{
  dependencies?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
}>;

export type CliBinaryArtifactSupportIdentity = Readonly<{
  fingerprint: string;
  workspaceRuntimeIdentity: string | null;
}>;

export type CliBinaryArtifactCodePayload = Readonly<{
  executableName: string;
  entrypoint: string;
  workspaceRuntimeIdentity: string;
  runtimeAssetRelativePath: string;
  stalePackages?: NonNullable<ReturnType<typeof cliDistBuildManifest.buildCliDistManifest>['stalePackages']>;
}>;

type CliBinaryArtifactWorkspacePublication = Readonly<{
  workspaceRuntimeIdentity: string;
  workspaceRuntimePackages: readonly string[];
}>;

function isExactStringList(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((entry, index) => entry === expected[index]);
}

function workspacePublicationMatches(
  publication: CliBinaryArtifactWorkspacePublication,
  workspaceRuntime: Readonly<{
    fingerprint: string;
    packageNames: readonly string[];
  }>,
): boolean {
  return publication.workspaceRuntimeIdentity === workspaceRuntime.fingerprint
    && isExactStringList(publication.workspaceRuntimePackages, workspaceRuntime.packageNames);
}

function assertCliNativeRuntimeTargetMatchesHost(target: BinaryTarget, commandProbe = commandExists): void {
  const reason = getCliBinaryArtifactSupportTargetUnavailableReason({ target, commandProbe });
  if (reason) throw new Error(reason);
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
  workspaceSourceFingerprint,
  cliProxyApiManagedRuntimeExecutablePath,
  processCustodyRuntimeExecutablePath,
}: Readonly<{
  repoRoot: string;
  target?: BinaryTarget;
  goVersion: string;
  workspaceSourceFingerprint?: string;
  cliProxyApiManagedRuntimeExecutablePath?: string;
  processCustodyRuntimeExecutablePath?: string;
}>): CliBinaryArtifactSupportIdentity {
  const normalizedGoVersion = String(goVersion ?? '').trim();
  if (!normalizedGoVersion) {
    throw new Error('[component-artifacts] daemon support identity requires a Go toolchain version');
  }

  const hash = createHash('sha256');
  // v2 binds release support metadata to the finalized (projected) workspace bytes.
  // Do not reuse older immutable support artifacts whose recorded identity
  // described the pre-projection tree.
  const sourceFingerprint = String(workspaceSourceFingerprint ?? '').trim().toLowerCase();
  if (workspaceSourceFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(sourceFingerprint)) {
    throw new Error('[component-artifacts] invalid daemon workspace source fingerprint');
  }
  hash.update(sourceFingerprint
    ? 'happier:daemon-runtime-support-source:v1\0'
    : 'happier:daemon-runtime-support:v2\0');
  hash.update(`target\0${target.os}\0${target.arch}\0${target.exeExt}\0`);
  hash.update(`node\0${process.version}\0`);
  hash.update(`go\0${normalizedGoVersion}\0`);
  const bundledPluginFailuresPath = join(repoRoot, 'apps', 'cli', BUNDLED_PLUGIN_FAILURES_RELATIVE_PATH);
  hash.update('bundled-plugin-failures\0');
  hash.update(existsSync(bundledPluginFailuresPath) ? readFileSync(bundledPluginFailuresPath) : 'absent');
  hash.update('\0');

  const cliDir = join(repoRoot, 'apps', 'cli');
  const workspaceRuntime = sourceFingerprint
    ? null
    : readCliNodeWorkspaceRuntimeIdentity({ repoRoot, hostPackageDir: cliDir });
  hash.update(sourceFingerprint
    ? `workspace-source\0${sourceFingerprint}\0`
    : `workspace-runtime\0${workspaceRuntime?.fingerprint}\0`);
  const workspacePackages = sourceFingerprint
    ? resolveWorkspaceBundlesFromPackageJson({ repoRoot, hostPackageDir: cliDir })
      .map(({ packageName, srcDir }) => ({ packageName, packageJsonPath: join(srcDir, 'package.json') }))
    : (workspaceRuntime?.packageNames ?? []).map((packageName) => ({
      packageName,
      packageJsonPath: resolveInstalledRuntimePackage({
        packageName,
        resolveFromPackageJsonPath: join(cliDir, 'package.json'),
        dereferenceRootDir: repoRoot,
      }).packageJsonPath,
    }));
  for (const { packageName, packageJsonPath } of workspacePackages) {
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

  // The native process-custody runtime is part of the same publication
  // closure. Its Go module source is always an identity input; the staged
  // bytes are hashed when a release caller supplies an exact prebuilt. Without
  // one, this source closure is the canonical workspace-build input.
  hashRequiredSupportInputPath({
    hash,
    repoRoot,
    sourcePath: join(repoRoot, 'apps', 'cli', 'native', 'processcustody'),
    label: 'process-custody:module-source',
  });
  if (processCustodyRuntimeExecutablePath) {
    hashRequiredSupportInputPath({
      hash,
      repoRoot,
      sourcePath: processCustodyRuntimeExecutablePath,
      label: 'process-custody:prebuilt-runtime',
    });
  } else {
    hash.update('process-custody:runtime-input\0workspace-source\0');
  }

  // The support payload can change when its owner’s staging/finalization
  // semantics change. Keep those implementation inputs owner-local rather
  // than giving a component consumer a second closure decision.
  for (const relativePath of [
    'packages/cli-common/src/componentArtifacts/buildCliBinaryArtifactPayload.ts',
    'packages/cli-common/src/componentArtifacts/stageCliTargetRuntimeDependencies.ts',
    'packages/cli-common/src/componentArtifacts/copyCliNodeRuntimePayload.ts',
    'packages/cli-common/src/componentArtifacts/finalizeRuntimeArtifactPayload.ts',
    'packages/cli-common/src/componentArtifacts/targets.ts',
    'packages/cli-common/nodePtySpawnHelperPermissions.cjs',
    'packages/cli-common/src/componentArtifacts/stageCliProxyApiManagedRuntime.ts',
    'packages/cli-common/src/componentArtifacts/stageProcessCustodyRuntime.ts',
    'packages/cli-common/src/componentArtifacts/cliRuntimeSidecars.ts',
    'packages/cli-common/src/workspaces/index.ts',
    'packages/cli-common/workspaceRuntimeDependencies.mjs',
    'packages/cli-common/componentArtifactTarget.mjs',
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
    workspaceRuntimeIdentity: workspaceRuntime?.fingerprint ?? null,
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
    if (CLI_OPTIONAL_RUNTIME_PACKAGES.includes(packageName)) continue;
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
    tools: target.os === 'windows' ? ['ripgrep'] : ['ripgrep', 'zellij'],
  });
  await rm(targetArchivesDir, { recursive: true, force: true });
}

/**
 * Settle the installed CLI workspace publication before a managed daemon build
 * captures identities that include that publication. Its exact physical
 * identity is passed to code assembly, which validates it while holding the
 * existing consumer lock instead of preparing the broad closure again.
 */
export async function prepareCliBinaryArtifactWorkspacePublication({
  repoRoot,
  publicationMode = 'artifact',
  ensureWorkspacePackagesBuiltByName,
}: Readonly<{
  repoRoot: string;
  publicationMode?: 'live' | 'artifact';
  ensureWorkspacePackagesBuiltByName?: EnsureWorkspacePackagesBuiltByName;
}>): Promise<CliBinaryArtifactWorkspacePublication> {
  await buildCliBundledWorkspaceArtifactClosure({
    repoRoot,
    publicationMode,
    ensureWorkspacePackagesBuiltByName,
  });
  return await readCliBinaryArtifactWorkspacePublication({ repoRoot });
}

/** Read the settled publication without running another publication writer. */
export async function readCliBinaryArtifactWorkspacePublication({ repoRoot }: Readonly<{
  repoRoot: string;
}>): Promise<CliBinaryArtifactWorkspacePublication> {
  const cliDir = join(repoRoot, 'apps', 'cli');
  return await withWorkspaceBundleLock(() => {
    const workspaceRuntime = readCliNodeWorkspaceRuntimeIdentity({
      repoRoot,
      hostPackageDir: cliDir,
    });
    return {
      workspaceRuntimeIdentity: workspaceRuntime.fingerprint,
      workspaceRuntimePackages: workspaceRuntime.packageNames,
    };
  }, {
    lockPath: resolveCliSharedDepsBuildLockPath(repoRoot),
  });
}

async function prepareCliDistSnapshot({
  repoRoot,
  runCommand,
  ensureWorkspacePackagesBuiltByName,
  requiredCliDistInputFingerprint,
  preparedWorkspacePublication,
  commandProbe,
  env,
}: Readonly<{
  repoRoot: string;
  runCommand: RunCommand;
  ensureWorkspacePackagesBuiltByName?: EnsureWorkspacePackagesBuiltByName;
  requiredCliDistInputFingerprint?: string;
  preparedWorkspacePublication?: CliBinaryArtifactWorkspacePublication;
  commandProbe: (cmd: string) => boolean;
  env: NodeJS.ProcessEnv;
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
  const workspacePublication = preparedWorkspacePublication
    ?? await prepareCliBinaryArtifactWorkspacePublication({
      repoRoot,
      ensureWorkspacePackagesBuiltByName,
    });
  const prepared = await withWorkspaceBundleLock(() => {
    return withCliDistBuildLock<{
      snapshotDistDir: string;
      workspaceRuntimeIdentity: string;
      workspaceRuntimePackages: readonly string[];
    }>(async ({ heldLockValue }) => {
      const runCommandWithHeldDistLock: RunCommand = (cmd, args, options = {}) => runCommand(cmd, args, {
        ...options,
        env: createWorkspaceChildBuildEnv({
          env: {
            ...env,
            ...(options.env ?? {}),
          },
          heldLockValue,
        }),
      });
      const workspaceRuntimeBeforeBuild = readCliNodeWorkspaceRuntimeIdentity({
        repoRoot,
        hostPackageDir: cliDir,
      });
      if (!workspacePublicationMatches(workspacePublication, workspaceRuntimeBeforeBuild)) {
        throw new Error(
          '[component-artifacts] CLI workspace runtime publication changed before staging '
          + `(expected ${workspacePublication.workspaceRuntimeIdentity}, found ${workspaceRuntimeBeforeBuild.fingerprint})`,
        );
      }
      const currentDistManifest = cliDistBuildManifest.readCliDistBuildManifest(entrypoint);

      // The CLI build manifest binds the compiled bytes to the source identity.
      // A caller without that identity must build rather than guess from mtimes.
      const reuseExistingDistSnapshot = await shouldReuseCliDistSnapshot({
        distEntrypointPath: entrypoint,
        requiredInputFingerprint: requiredCliDistInputFingerprint,
        env,
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
      // build:prepared can canonically publish generated workspace bytes while
      // this lock is held. Return that coherent final identity for the dist
      // manifest; external closure writers remain excluded by this same lock.
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
  preparedWorkspacePublication,
  env = process.env,
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
  preparedWorkspacePublication?: CliBinaryArtifactWorkspacePublication;
  env?: NodeJS.ProcessEnv;
}): Promise<CliBinaryArtifactCodePayload> {
  const bunCommand = resolveBunCommand({ commandProbe });
  if (!bunCommand) {
    throw new Error('[component-artifacts] bun is required to build CLI binary artifacts');
  }
  const prepared = await prepareCliDistSnapshot({
    repoRoot,
    runCommand,
    ensureWorkspacePackagesBuiltByName,
    requiredCliDistInputFingerprint,
    preparedWorkspacePublication,
    commandProbe,
    env,
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
      // Standalone CLI binaries must not inherit project-local dotenv files
      // from the directory where users invoke them.
      autoloadDotenv: false,
      runCommand,
    });
    await rm(join(payloadDir, 'package-dist'), { recursive: true, force: true });
    await cp(prepared.snapshotDistDir, join(payloadDir, 'package-dist'), { recursive: true });
    // The compiled CLI reads its package publication metadata from the
    // executable's runtime root. It belongs to this code artifact, not the
    // separately linked support-directory closure.
    await copyFile(join(repoRoot, 'apps', 'cli', 'package.json'), join(payloadDir, 'package.json'));
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
      ...(snapshotManifest.manifest?.stalePackages?.length ? { stalePackages: snapshotManifest.manifest.stalePackages } : {}),
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
  processCustodyRuntimeExecutablePath,
  expectedWorkspaceRuntimeIdentity,
  supportArtifactFingerprint,
  goVersion,
  workspaceSourceFingerprint,
  preserveCompilePayloadAssets = false,
  includeIrohNativeReleaseEvidence = false,
}: {
  repoRoot: string;
  payloadDir: string;
  target?: BinaryTarget;
  runCommand?: RunCommand;
  commandProbe?: (cmd: string) => boolean;
  cliProxyApiManagedRuntimeExecutablePath?: string;
  processCustodyRuntimeExecutablePath?: string;
  expectedWorkspaceRuntimeIdentity?: string;
  supportArtifactFingerprint?: string;
  goVersion?: string;
  workspaceSourceFingerprint?: string;
  preserveCompilePayloadAssets?: boolean;
  includeIrohNativeReleaseEvidence?: boolean;
}): Promise<Readonly<{
  entrypoint: string;
  workspaceRuntimeIdentity: string;
  runtimeAssetRelativePath: string;
}>> {
  assertCliNativeRuntimeTargetMatchesHost(target, commandProbe);
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
      workspaceSourceFingerprint,
      cliProxyApiManagedRuntimeExecutablePath,
      processCustodyRuntimeExecutablePath,
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
    ? ['node_modules', '.project']
    : ['node_modules', 'tools', 'scripts', '.project'];
  await Promise.all(runtimeSupportDirectories.map(async (name) => {
    await rm(join(payloadDir, name), { recursive: true, force: true });
  }));

  const sourceWorkspaceRuntime = copyCliNodeRuntimeDependencies({
    repoRoot,
    payloadDir,
    expectedWorkspaceRuntimeIdentity,
    excludeRootDependencies: CLI_OPTIONAL_RUNTIME_PACKAGES,
  });
  await copyCliRuntimeSidecars(repoRoot, payloadDir);
  await stageCliTargetRuntimeDependencies({ repoRoot, payloadDir, target, runCommand, commandProbe });
  const bundledPluginFailuresSource = join(repoRoot, 'apps', 'cli', BUNDLED_PLUGIN_FAILURES_RELATIVE_PATH);
  const bundledPluginFailuresTarget = join(payloadDir, BUNDLED_PLUGIN_FAILURES_RELATIVE_PATH);
  const publicationFailures = existsSync(bundledPluginFailuresSource)
    ? parseBundledPluginPublicationFailures(readFileSync(bundledPluginFailuresSource, 'utf8'))
    : [];
  await mkdir(join(payloadDir, '.project', 'tmp', 'bundled-plugin-publication'), { recursive: true });
  if (existsSync(bundledPluginFailuresSource)) {
    await copyFile(bundledPluginFailuresSource, bundledPluginFailuresTarget);
  } else {
    await writeFile(bundledPluginFailuresTarget, '[]\n', 'utf8');
  }
  await copyCliRuntimeTools(repoRoot, payloadDir, target);
  const cliProxyApiManagedRuntime = await stageCliProxyApiManagedRuntime({
    repoRoot,
    payloadDir,
    target,
    yarn,
    runCommand,
    prebuiltExecutablePath: cliProxyApiManagedRuntimeExecutablePath,
    publicationFailures,
  });
  await stageProcessCustodyRuntime({
    repoRoot,
    payloadDir,
    target,
    runCommand,
    prebuiltExecutablePath: processCustodyRuntimeExecutablePath,
  });
  await stageIrohNativeReleaseEvidence({
    repoRoot,
    payloadDir,
    required: includeIrohNativeReleaseEvidence,
    runCommand,
  });
  if (expectedSupportFingerprint) {
    await writeFile(
      join(payloadDir, DAEMON_SUPPORT_ENTRYPOINT),
      `${JSON.stringify({ version: 1, artifactFingerprint: expectedSupportFingerprint })}\n`,
      'utf8',
    );
  }
  await finalizeRuntimeArtifactPayload(payloadDir, target);
  const stagedWorkspaceRuntime = readCliNodeWorkspaceRuntimeIdentityFromRuntimeRoot({
    runtimeRoot: payloadDir,
    packageNames: sourceWorkspaceRuntime.packageNames,
  });

  if (expectedSupportFingerprint) {
    const after = readCliBinaryArtifactSupportIdentity({
      repoRoot,
      target,
      goVersion: normalizedGoVersion,
      workspaceSourceFingerprint,
      cliProxyApiManagedRuntimeExecutablePath,
      processCustodyRuntimeExecutablePath,
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
      cliProxyApiManagedRuntime?.executablePath ?? join(payloadDir, `${CLIPROXYAPI_MANAGED_RUNTIME_RELATIVE_PATH}${target.exeExt}`),
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
  processCustodyRuntimeExecutablePath,
  expectedWorkspaceRuntimeIdentity,
  supportArtifactFingerprint,
  goVersion,
  workspaceSourceFingerprint,
  preserveCompilePayloadAssets = false,
  includeIrohNativeReleaseEvidence = false,
}: {
  repoRoot: string;
  payloadDir: string;
  target?: BinaryTarget;
  runCommand?: RunCommand;
  commandProbe?: (cmd: string) => boolean;
  cliProxyApiManagedRuntimeExecutablePath?: string;
  processCustodyRuntimeExecutablePath?: string;
  expectedWorkspaceRuntimeIdentity?: string;
  supportArtifactFingerprint?: string;
  goVersion?: string;
  workspaceSourceFingerprint?: string;
  preserveCompilePayloadAssets?: boolean;
  includeIrohNativeReleaseEvidence?: boolean;
}): Promise<Readonly<{
  entrypoint: string;
  workspaceRuntimeIdentity: string;
  runtimeAssetRelativePath: string;
}>> {
  return await withWorkspaceBundleLock(async () => await stageCliBinaryArtifactSupportPayload({
    repoRoot,
    payloadDir,
    target,
    runCommand,
    commandProbe,
    cliProxyApiManagedRuntimeExecutablePath,
    processCustodyRuntimeExecutablePath,
    expectedWorkspaceRuntimeIdentity,
    supportArtifactFingerprint,
    goVersion,
    workspaceSourceFingerprint,
    preserveCompilePayloadAssets,
    includeIrohNativeReleaseEvidence,
  }), {
    // The support identity is computed from the installed CLI workspace
    // publication. Keep that existing publication stable until every byte has
    // been copied and the identity has been rechecked.
    lockPath: resolveCliSharedDepsBuildLockPath(repoRoot),
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
  processCustodyRuntimeExecutablePath,
  requiredCliDistInputFingerprint,
  includeIrohNativeReleaseEvidence = false,
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
  processCustodyRuntimeExecutablePath?: string;
  requiredCliDistInputFingerprint?: string;
  includeIrohNativeReleaseEvidence?: boolean;
}): Promise<{ executableName: string; entrypoint: string }> {
  assertCliNativeRuntimeTargetMatchesHost(target, commandProbe);
  const publicationFailuresPath = join(repoRoot, 'apps', 'cli', BUNDLED_PLUGIN_FAILURES_RELATIVE_PATH);
  if (existsSync(publicationFailuresPath)
    && parseBundledPluginPublicationFailures(readFileSync(publicationFailuresPath, 'utf8')).length > 0) {
    throw new Error('[component-artifacts] release payload requires a complete bundled-plugin publication');
  }
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
  const support = await buildCliBinaryArtifactSupportPayload({
    repoRoot,
    payloadDir,
    target,
    runCommand,
    commandProbe,
    cliProxyApiManagedRuntimeExecutablePath,
    processCustodyRuntimeExecutablePath,
    expectedWorkspaceRuntimeIdentity: code.workspaceRuntimeIdentity,
    // The release payload preserves legitimate assets emitted alongside the
    // Bun executable (for example its managed JS runtime). New immutable
    // daemon support artifacts stage into an empty payload instead.
    preserveCompilePayloadAssets: true,
    includeIrohNativeReleaseEvidence,
  });
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
