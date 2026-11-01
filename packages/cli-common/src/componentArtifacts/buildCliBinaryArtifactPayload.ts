import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { CLI_BINARY_TARGETS, resolveCliToolsPlatformDir, resolveCurrentBinaryTarget, resolveExecutableName, type BinaryTarget } from './targets.js';
import { WINDOWS_SERVICE_LAUNCHER_FILE_NAME } from '../service/windowsLauncher.js';
import { commandExists, compileBunBinary, ensureFileExists, execOrThrow, resolveBunCommand, resolveYarnCommand, type RunCommand } from './commands.js';
import {
  bundleInstalledPackageWithRuntimeDependencies,
  bundleWorkspacePackageWithRuntimeDependencies,
  resolveWorkspaceBundlesFromPackageJson,
  vendorBundledPackageRuntimeDependencies,
} from '../workspaces/index.js';
import type {
  BundledWorkspacePackage,
  EnsureWorkspacePackagesBuiltByName,
} from './ensureBundledWorkspacePackagesBuilt.js';
import { withCliDistBuildLock } from './withCliDistBuildLock.js';
import { ensureBundledWorkspacePackagesBuilt } from './ensureBundledWorkspacePackagesBuilt.js';
import { finalizeRuntimeArtifactPayload } from './finalizeRuntimeArtifactPayload.js';
import { resolveSharpRuntimeSidecarEntries } from './sharpRuntimeSidecars.js';
import {
  recordCliBinaryArtifactRuntimeAssetBuildManifest,
  refreshCliBinaryArtifactClosureBuildManifest,
} from './refreshCliBinaryArtifactRuntimeAssetBuildManifest.js';
import { shouldReuseCliDistSnapshot } from './shouldReuseCliDistSnapshot.js';

const CLI_RUNTIME_SIDECAR_ENTRIES = [
  ['childProcessOptions.cjs'],
  ['claude_launcher_runtime.cjs'],
  ['native_process_exit.cjs'],
  ['claude_local_launcher.cjs'],
  ['claude_remote_launcher.cjs'],
  ['session_hook_forwarder.cjs'],
  ['permission_hook_forwarder.cjs'],
  ['ripgrep_launcher.cjs'],
  ['statusline_forwarder.cjs'],
  ['terminal_launch_spec_runner.cjs'],
  ['process_tree.cjs'],
  ['node_pty_relay.cjs'],
  ['runtime'],
  ['shims'],
] as const;

const CLI_RUNTIME_BUNDLED_PACKAGES = [
  'node-pty',
  '@homebridge/node-pty-prebuilt-multiarch',
] as const;

// The local-embeddings consumer acquires this exact-version component on first use.
// Keep it external to Bun while omitting only the CLI's direct disk dependency.
const CLI_OPTIONAL_RUNTIME_PACKAGES = ['@huggingface/transformers'] as const;

type CliToolUnpackModule = {
  unpackTools?: (options: Readonly<{ platformDir: string; toolsDir: string; tools: readonly string[] }>) => Promise<unknown> | unknown;
};

async function copyCliRuntimeSidecars(repoRoot: string, payloadDir: string): Promise<void> {
  for (const segments of CLI_RUNTIME_SIDECAR_ENTRIES) {
    const sourcePath = join(repoRoot, 'apps', 'cli', 'scripts', ...segments);
    const targetPath = join(payloadDir, 'scripts', ...segments);
    await mkdir(join(targetPath, '..'), { recursive: true });
    await cp(sourcePath, targetPath, { recursive: true });
  }

  const resolveFromPackageJsonPath = join(repoRoot, 'package.json');
  for (const packageName of CLI_RUNTIME_BUNDLED_PACKAGES) {
    bundleInstalledPackageWithRuntimeDependencies({
      packageName,
      resolveFromPackageJsonPath,
      destNodeModulesDir: join(payloadDir, 'node_modules'),
    });
  }
}

async function copyCliRuntimeTools(repoRoot: string, payloadDir: string, target: BinaryTarget): Promise<void> {
  const sourceToolsDir = join(repoRoot, 'apps', 'cli', 'tools');
  const targetToolsDir = join(payloadDir, 'tools');
  const targetArchivesDir = join(targetToolsDir, 'archives');
  await rm(targetToolsDir, { recursive: true, force: true });
  await mkdir(targetToolsDir, { recursive: true });
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

async function copyCliNodeRuntimePayload(
  repoRoot: string,
  payloadDir: string,
  distDir: string,
  workspaceBundles: readonly BundledWorkspacePackage[],
  target: BinaryTarget,
): Promise<void> {
  const cliDir = join(repoRoot, 'apps', 'cli');

  await cp(distDir, join(payloadDir, 'package-dist'), { recursive: true });
  vendorBundledPackageRuntimeDependencies({
    srcPackageJsonPath: join(cliDir, 'package.json'),
    destPackageDir: payloadDir,
    excludeRootDependencies: [...CLI_OPTIONAL_RUNTIME_PACKAGES, 'sharp'],
  });
  for (const entry of await resolveSharpRuntimeSidecarEntries({ resolveFromPackageJsonPath: join(cliDir, 'package.json'), target })) {
    const destination = join(payloadDir, entry.targetPath);
    await mkdir(join(destination, '..'), { recursive: true });
    await cp(entry.sourcePath, destination, { recursive: true });
  }
  // The node-hosted package-dist resolves package assets (such as the Windows service launcher)
  // from these bundled copies, so they carry the same declared files as the npm bundle.
  for (const { packageName, srcDir, includeFiles } of workspaceBundles) {
    bundleWorkspacePackageWithRuntimeDependencies({
      packageName,
      srcDir,
      destDir: join(payloadDir, 'node_modules', ...packageName.split('/')),
      includeFiles,
    });
  }
}

function syncCliBundledWorkspacePackagesForCompile(cliDir: string, workspaceBundles: readonly BundledWorkspacePackage[]): void {
  for (const { packageName, srcDir } of workspaceBundles) {
    bundleWorkspacePackageWithRuntimeDependencies({
      packageName,
      srcDir,
      destDir: join(cliDir, 'node_modules', ...packageName.split('/')),
    });
  }
}

async function reclaimAbandonedCliDistSnapshots(cliDir: string): Promise<void> {
  const entries = await readdir(cliDir, { withFileTypes: true });
  await Promise.all(entries
    .filter((entry) => entry.name.startsWith('.dist.hstack-snapshot-') && (entry.isDirectory() || entry.isSymbolicLink()))
    .map((entry) => rm(join(cliDir, entry.name), { recursive: true, force: true })));
}

async function snapshotCliDistDir(params: Readonly<{ cliDir: string; distDir: string }>): Promise<string> {
  await reclaimAbandonedCliDistSnapshots(params.cliDir);
  const snapshotDir = await mkdtemp(join(params.cliDir, '.dist.hstack-snapshot-'));
  let liveDistRenamed = false;
  try {
    await rename(params.distDir, snapshotDir);
    liveDistRenamed = true;
    await cp(snapshotDir, params.distDir, { recursive: true });
    return snapshotDir;
  } catch (error) {
    const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : null;
    if (!liveDistRenamed && existsSync(params.distDir) && (code === 'ENOTEMPTY' || code === 'EBUSY' || code === 'EPERM' || code === 'EACCES')) {
      try {
        await cp(params.distDir, snapshotDir, { recursive: true });
        return snapshotDir;
      } catch (copyError) {
        await rm(snapshotDir, { recursive: true, force: true }).catch(() => {});
        throw copyError;
      }
    }
    if (liveDistRenamed && !existsSync(params.distDir) && existsSync(snapshotDir)) {
      await rename(snapshotDir, params.distDir).catch(() => {});
    }
    await rm(snapshotDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function buildCliBinaryArtifactPayload({
  repoRoot,
  payloadDir,
  target = resolveCurrentBinaryTarget({ availableTargets: CLI_BINARY_TARGETS }),
  externals = [],
  releaseVersion = '',
  runCommand = execOrThrow,
  commandProbe = commandExists,
  compileBinary = compileBunBinary,
  ensureWorkspacePackagesBuiltByName,
}: {
  repoRoot: string;
  payloadDir: string;
  target?: BinaryTarget;
  externals?: string[];
  releaseVersion?: string;
  runCommand?: RunCommand;
  commandProbe?: (cmd: string) => boolean;
  compileBinary?: typeof compileBunBinary;
  ensureWorkspacePackagesBuiltByName?: EnsureWorkspacePackagesBuiltByName;
}): Promise<{ executableName: string; entrypoint: string }> {
  const bunCommand = resolveBunCommand({ commandProbe });
  if (!bunCommand) {
    throw new Error('[component-artifacts] bun is required to build CLI binary artifacts');
  }

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
  const executableName = resolveExecutableName({ baseName: 'happier', target });
  const mergedExternals = [...new Set([...CLI_RUNTIME_BUNDLED_PACKAGES, ...CLI_OPTIONAL_RUNTIME_PACKAGES, ...externals.map((value) => String(value ?? '').trim()).filter(Boolean)])];

  await withCliDistBuildLock(async ({ heldLockValue }) => {
    const runCommandWithHeldDistLock: RunCommand = (cmd, args, options = {}) => runCommand(cmd, args, {
      ...options,
      env: {
        ...process.env,
        ...(options.env ?? {}),
        HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: heldLockValue,
      },
    });
    let snapshotDistDir: string | null = null;
    try {
      await ensureBundledWorkspacePackagesBuilt({
        repoRoot,
        bundles: workspaceBundles.map(({ packageName, srcDir }) => ({ packageName, srcDir })),
        ensureWorkspacePackagesBuiltByName,
      });
      syncCliBundledWorkspacePackagesForCompile(cliDir, workspaceBundles);

      if (!existsSync(distDir) && existsSync(distBackupDir)) {
        await rename(distBackupDir, distDir);
      }

      // If the CLI dist entrypoint is already present, prefer snapshotting it instead of rebuilding.
      // Rebuilding `apps/cli` is expensive and can disrupt long-running processes in dev checkouts.
      if (await shouldReuseCliDistSnapshot({
        distEntrypointPath: entrypoint,
        expectedBuildVersion: releaseVersion,
        inputPaths: [
          join(cliDir, 'src'),
          join(cliDir, 'package.json'),
          ...workspaceBundles.map(({ srcDir }) => join(srcDir, 'dist')),
        ],
      })) {
        snapshotDistDir = await snapshotCliDistDir({ cliDir, distDir });
      } else {
        const hadDistBeforeBuild = existsSync(distDir);
        if (hadDistBeforeBuild) {
          await rm(distBackupDir, { recursive: true, force: true });
          await rename(distDir, distBackupDir);
        }

        try {
          await runCommandWithHeldDistLock(yarn.cmd, [...yarn.args, '--cwd', 'apps/cli', 'build'], {
            cwd: repoRoot,
            ...(releaseVersion ? { env: { HAPPIER_CLI_BUILD_VERSION: releaseVersion } } : {}),
          });
          await ensureFileExists(entrypoint);
          if (hadDistBeforeBuild) {
            await rm(distBackupDir, { recursive: true, force: true });
          }
        } catch (error) {
          if (hadDistBeforeBuild && existsSync(distBackupDir)) {
            await rm(distDir, { recursive: true, force: true });
            await rename(distBackupDir, distDir);
          }
          throw error;
        }
        snapshotDistDir = await snapshotCliDistDir({ cliDir, distDir });
      }

      await rm(payloadDir, { recursive: true, force: true });
      await mkdir(payloadDir, { recursive: true });
      await compileBinary({
        entrypoint: join(snapshotDistDir, 'index.mjs'),
        bunTarget: target.bunTarget,
        outfile: join(payloadDir, executableName),
        cwd: repoRoot,
        externals: mergedExternals,
        bunCommand,
        // The standalone CLI must not inherit project-local dotenv or bunfig files from
        // the directory where the user invokes it. Configuration is loaded by
        // the host runtime, and Bun's compiled-executable autoloader can abort
        // startup before the CLI installs its error reporting.
        autoloadDotenv: false,
        buildRunnerEntrypoint: join(repoRoot, 'packages', 'cli-common', 'scripts', 'buildBunBinary.mjs'),
        runCommand,
      });
      await rm(join(payloadDir, 'node_modules'), { recursive: true, force: true });
      await copyCliNodeRuntimePayload(repoRoot, payloadDir, snapshotDistDir, workspaceBundles, target);
      if (target.os === 'windows' && target.arch === 'x64') {
        const launcherSource = join(
          repoRoot,
          'packages',
          'cli-common',
          'native',
          'windows',
          'bin',
          'windows-x64',
          WINDOWS_SERVICE_LAUNCHER_FILE_NAME,
        );
        await ensureFileExists(launcherSource);
        await cp(launcherSource, join(payloadDir, WINDOWS_SERVICE_LAUNCHER_FILE_NAME));
      }
    } finally {
      if (snapshotDistDir) {
        await rm(snapshotDistDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }, { lockPath });

  await copyCliRuntimeSidecars(repoRoot, payloadDir);
  await copyCliRuntimeTools(repoRoot, payloadDir, target);
  await finalizeRuntimeArtifactPayload(payloadDir, target);
  refreshCliBinaryArtifactClosureBuildManifest({ payloadDir });
  recordCliBinaryArtifactRuntimeAssetBuildManifest({
    payloadDir,
    relativePath: executableName,
  });
  if (target.os === 'windows' && target.arch === 'x64') {
    recordCliBinaryArtifactRuntimeAssetBuildManifest({
      payloadDir,
      relativePath: WINDOWS_SERVICE_LAUNCHER_FILE_NAME,
    });
  }

  return {
    executableName,
    entrypoint: executableName,
  };
}
