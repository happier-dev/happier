import { existsSync, readFileSync } from 'node:fs';
import { cp, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import * as tar from 'tar';

import { createWorkspaceChildBuildEnv } from '../../workspaceChildBuildEnv.mjs';
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

const CLI_RUNTIME_EXTERNAL_PACKAGES = [
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

  const resolveFromPackageJsonPath = join(repoRoot, 'apps', 'cli', 'package.json');
  const cliPackageJson = JSON.parse(readFileSync(resolveFromPackageJsonPath, 'utf8')) as {
    dependencies?: Record<string, unknown>;
    optionalDependencies?: Record<string, unknown>;
  };
  for (const packageName of CLI_RUNTIME_EXTERNAL_PACKAGES) {
    const declaredSpec = cliPackageJson.dependencies?.[packageName]
      ?? cliPackageJson.optionalDependencies?.[packageName];
    if (typeof declaredSpec !== 'string' || !declaredSpec.trim()) {
      throw new Error(
        `[component-artifacts] missing CLI runtime dependency declaration for ${packageName}`,
      );
    }
    bundleInstalledPackageWithRuntimeDependencies({
      packageName,
      declaredSpec: declaredSpec.trim(),
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
    async ({ heldLockValue }) => {
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
      await ensureBundledWorkspacePackagesBuilt({
        repoRoot,
        bundles: workspaceBundles.map(({ packageName, srcDir }) => ({ packageName, srcDir })),
        ensureWorkspacePackagesBuiltByName,
      });
      syncCliBundledWorkspacePackagesForCompile(repoRoot, cliDir, workspaceBundles);

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
      });
      return await resolveCliDistSnapshotDir({
        cliDir,
        distDir,
        distBackupDir,
        distEntrypointPath: entrypoint,
        reuseExistingDistSnapshot,
        buildDist: async () => {
          await runCommandWithHeldDistLock(yarn.cmd, [...yarn.args, '--cwd', 'apps/cli', 'build'], { cwd: repoRoot });
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
    const mergedExternals = [...new Set([
      ...CLI_RUNTIME_EXTERNAL_PACKAGES,
      ...CLI_BUN_COMPILE_EXTERNAL_PACKAGES,
      ...externals.map((value) => String(value ?? '').trim()).filter(Boolean),
    ])];
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
    });
    await copyCliRuntimeSidecars(repoRoot, payloadDir);
    await copyCliRuntimeTools(repoRoot, payloadDir, target);
    await stageCliProxyApiManagedRuntime({
      repoRoot,
      payloadDir,
      target,
      yarn,
      runCommand,
      prebuiltExecutablePath: cliProxyApiManagedRuntimeExecutablePath,
    });
    await stageDeferredVoiceInferenceRuntimeArchive(payloadDir, target);
    await finalizeRuntimeArtifactPayload(payloadDir);

    return {
      executableName,
      entrypoint: executableName,
    };
  } finally {
    await rm(snapshotDistDir, { recursive: true, force: true }).catch(() => {});
  }
}
