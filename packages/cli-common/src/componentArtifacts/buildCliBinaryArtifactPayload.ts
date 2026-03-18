import { existsSync } from 'node:fs';
import { cp, mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { CLI_BINARY_TARGETS, resolveCurrentBinaryTarget, resolveExecutableName, type BinaryTarget } from './targets.js';
import { commandExists, compileBunBinary, ensureFileExists, execOrThrow, resolveBunCommand, resolveYarnCommand, type RunCommand } from './commands.js';
import {
  bundleInstalledPackageWithRuntimeDependencies,
  bundleWorkspacePackages,
  resolveWorkspaceBundlesFromPackageJson,
  vendorBundledPackageRuntimeDependencies,
} from '../workspaces/index.js';
import { withCliDistBuildLock } from './withCliDistBuildLock.js';

const CLI_RUNTIME_SIDECAR_ENTRIES = [
  ['childProcessOptions.cjs'],
  ['claude_version_utils.cjs'],
  ['claude_local_launcher.cjs'],
  ['claude_remote_launcher.cjs'],
  ['session_hook_forwarder.cjs'],
  ['permission_hook_forwarder.cjs'],
  ['ripgrep_launcher.cjs'],
  ['runtime'],
  ['shims'],
] as const;

const CLI_RUNTIME_EXTERNAL_PACKAGES = [
  '@huggingface/transformers',
  'node-pty',
  '@homebridge/node-pty-prebuilt-multiarch',
] as const;

async function copyCliRuntimeSidecars(repoRoot: string, payloadDir: string): Promise<void> {
  for (const segments of CLI_RUNTIME_SIDECAR_ENTRIES) {
    const sourcePath = join(repoRoot, 'apps', 'cli', 'scripts', ...segments);
    const targetPath = join(payloadDir, 'scripts', ...segments);
    await mkdir(join(targetPath, '..'), { recursive: true });
    await cp(sourcePath, targetPath, { recursive: true });
  }

  const resolveFromPackageJsonPath = join(repoRoot, 'package.json');
  for (const packageName of CLI_RUNTIME_EXTERNAL_PACKAGES) {
    bundleInstalledPackageWithRuntimeDependencies({
      packageName,
      resolveFromPackageJsonPath,
      destNodeModulesDir: join(payloadDir, 'node_modules'),
    });
  }
}

async function copyCliNodeRuntimePayload(repoRoot: string, payloadDir: string, distDir: string): Promise<void> {
  const cliDir = join(repoRoot, 'apps', 'cli');
  const workspaceBundles = resolveWorkspaceBundlesFromPackageJson({
    repoRoot,
    hostPackageDir: cliDir,
  });
  await cp(distDir, join(payloadDir, 'package-dist'), { recursive: true });
  vendorBundledPackageRuntimeDependencies({
    srcPackageJsonPath: join(cliDir, 'package.json'),
    destPackageDir: payloadDir,
  });
  bundleWorkspacePackages({
    bundles: workspaceBundles.map(({ packageName, srcDir }) => ({
      packageName,
      srcDir,
      destDir: join(payloadDir, 'node_modules', ...packageName.split('/')),
    })),
  });
  for (const { packageName, srcDir } of workspaceBundles) {
    vendorBundledPackageRuntimeDependencies({
      srcPackageJsonPath: join(srcDir, 'package.json'),
      destPackageDir: join(payloadDir, 'node_modules', ...packageName.split('/')),
    });
  }
}

export async function buildCliBinaryArtifactPayload({
  repoRoot,
  payloadDir,
  target = resolveCurrentBinaryTarget({ availableTargets: CLI_BINARY_TARGETS }),
  externals = [],
  runCommand = execOrThrow,
  commandProbe = commandExists,
  compileBinary = compileBunBinary,
}: {
  repoRoot: string;
  payloadDir: string;
  target?: BinaryTarget;
  externals?: string[];
  runCommand?: RunCommand;
  commandProbe?: (cmd: string) => boolean;
  compileBinary?: typeof compileBunBinary;
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
  await withCliDistBuildLock(async ({ waited }) => {
    if (!existsSync(distDir) && existsSync(distBackupDir)) {
      await rename(distBackupDir, distDir);
    }

    if (waited && existsSync(entrypoint)) {
      return;
    }

    const hadDistBeforeBuild = existsSync(distDir);
    if (hadDistBeforeBuild) {
      await rm(distBackupDir, { recursive: true, force: true });
      await rename(distDir, distBackupDir);
    }

    try {
      await runCommand(yarn.cmd, [...yarn.args, '--cwd', 'apps/cli', 'build'], { cwd: repoRoot });
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
  }, { lockPath });

  await rm(payloadDir, { recursive: true, force: true });
  await mkdir(payloadDir, { recursive: true });

  const executableName = resolveExecutableName({ baseName: 'happier', target });
  const mergedExternals = [...new Set([...CLI_RUNTIME_EXTERNAL_PACKAGES, ...externals.map((value) => String(value ?? '').trim()).filter(Boolean)])];
  await compileBinary({
    entrypoint,
    bunTarget: target.bunTarget,
    outfile: join(payloadDir, executableName),
    cwd: repoRoot,
    externals: mergedExternals,
    bunCommand,
    runCommand,
  });
  await rm(join(payloadDir, 'node_modules'), { recursive: true, force: true });
  await copyCliNodeRuntimePayload(repoRoot, payloadDir, distDir);
  await copyCliRuntimeSidecars(repoRoot, payloadDir);

  return {
    executableName,
    entrypoint: executableName,
  };
}
