import { existsSync } from 'node:fs';
import { cp, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import * as tar from 'tar';

import { CLI_BINARY_TARGETS, resolveCurrentBinaryTarget, resolveExecutableName, type BinaryTarget } from './targets.js';
import { commandExists, compileBunBinary, ensureFileExists, execOrThrow, resolveBunCommand, resolveYarnCommand, type RunCommand } from './commands.js';
import {
  bundleInstalledPackageWithRuntimeDependencies,
  bundleWorkspacePackageWithRuntimeDependencies,
  resolveWorkspaceBundlesFromPackageJson,
} from '../workspaces/index.js';
import { withCliDistBuildLock } from './withCliDistBuildLock.js';
import { resolveCliDistSnapshotDir } from './resolveCliDistSnapshotDir.js';
import { copyCliNodeRuntimePayload } from './copyCliNodeRuntimePayload.js';
import type { BundledWorkspacePackage } from './ensureBundledWorkspacePackagesBuilt.js';
import { ensureBundledWorkspacePackagesBuilt } from './ensureBundledWorkspacePackagesBuilt.js';
import { shouldReuseCliDistSnapshot } from './shouldReuseCliDistSnapshot.js';

const CLI_RUNTIME_SIDECAR_ENTRIES = [
  ['childProcessOptions.cjs'],
  ['claude_version_utils.cjs'],
  ['claude_local_launcher.cjs'],
  ['claude_remote_launcher.cjs'],
  ['session_hook_forwarder.cjs'],
  ['permission_hook_forwarder.cjs'],
  ['ripgrep_launcher.cjs'],
  ['statusline_forwarder.cjs'],
  ['terminal_launch_spec_runner.cjs'],
  ['node_pty_relay.cjs'],
  ['runtime'],
  ['shims'],
] as const;

const CLI_RUNTIME_EXTERNAL_PACKAGES = [
  '@huggingface/transformers',
  'ffmpeg-static',
  'sherpa-onnx-node',
  'node-pty',
  '@homebridge/node-pty-prebuilt-multiarch',
] as const;

const CLI_DEFERRED_VOICE_RUNTIME_PACKAGES = [
  '@huggingface/transformers',
  'ffmpeg-static',
  'sherpa-onnx-node',
] as const;

type CliToolUnpackModule = {
  unpackTools?: (options: Readonly<{ platformDir: string; toolsDir: string }>) => Promise<unknown> | unknown;
};

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

function syncCliBundledWorkspacePackagesForCompile(cliDir: string, workspaceBundles: readonly BundledWorkspacePackage[]): void {
  for (const { packageName, srcDir } of workspaceBundles) {
    bundleWorkspacePackageWithRuntimeDependencies({
      packageName,
      srcDir,
      destDir: join(cliDir, 'node_modules', ...packageName.split('/')),
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
  assertCliNativeRuntimeTargetMatchesHost(target);

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
  const snapshotDistDir = await withCliDistBuildLock<string>(
    async () => {
      await ensureBundledWorkspacePackagesBuilt({
        repoRoot,
        bundles: workspaceBundles.map(({ packageName, srcDir }) => ({ packageName, srcDir })),
        yarn,
        runCommand,
      });
      syncCliBundledWorkspacePackagesForCompile(cliDir, workspaceBundles);

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
      });
      return await resolveCliDistSnapshotDir({
        cliDir,
        distDir,
        distBackupDir,
        distEntrypointPath: entrypoint,
        reuseExistingDistSnapshot,
        buildDist: async () => {
          await runCommand(yarn.cmd, [...yarn.args, '--cwd', 'apps/cli', 'build'], { cwd: repoRoot });
          await ensureFileExists(entrypoint);
        },
      });
    },
    { lockPath },
  );

  const snapshotEntrypoint = join(snapshotDistDir, 'index.mjs');

  try {
    await rm(payloadDir, { recursive: true, force: true });
    await mkdir(payloadDir, { recursive: true });

    const executableName = resolveExecutableName({ baseName: 'happier', target });
    const mergedExternals = [...new Set([...CLI_RUNTIME_EXTERNAL_PACKAGES, ...externals.map((value) => String(value ?? '').trim()).filter(Boolean)])];
    await compileBinary({
      entrypoint: snapshotEntrypoint,
      bunTarget: target.bunTarget,
      outfile: join(payloadDir, executableName),
      cwd: repoRoot,
      externals: mergedExternals,
      bunCommand,
      runCommand,
    });
    await rm(join(payloadDir, 'node_modules'), { recursive: true, force: true });
    await copyCliNodeRuntimePayload({
      repoRoot,
      payloadDir,
      distDir: snapshotDistDir,
      yarn,
      runCommand,
    });
    await copyCliRuntimeSidecars(repoRoot, payloadDir);
    await copyCliRuntimeTools(repoRoot, payloadDir, target);
    await stageDeferredVoiceInferenceRuntimeArchive(payloadDir, target);

    return {
      executableName,
      entrypoint: executableName,
    };
  } finally {
    await rm(snapshotDistDir, { recursive: true, force: true }).catch(() => {});
  }
}
