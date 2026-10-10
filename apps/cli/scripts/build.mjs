import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exitWithCommandResult, runCommand } from '../../stack/scripts/utils/proc/proc.mjs';
import { resolveWorkspaceBuildMode } from '../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs';

import { resolveTypeScriptCliInvocation } from '../../../scripts/workspaces/resolveTypeScriptCliInvocation.mjs';
import { readHappyCliRuntimeInputFreshness } from '../../stack/scripts/utils/proc/cli_runtime_inputs.mjs';
import { readCliNodeWorkspaceRuntimeIdentity } from '@happier-dev/cli-common/componentArtifacts/copyCliNodeRuntimePayload';
import { finalizeDist, readCliDistBuildManifestFingerprint } from './finalizeDist.mjs';
import { withOptionalCliDistBuildLock } from './optionalWorkspaceBundleLock.mjs';
import { main as rmDist } from './rmDist.mjs';
import { rmDirSafeSync } from './rmDirSafe.mjs';
import { runPkgrollBuild } from './runPkgrollBuild.mjs';

const INCREMENTAL_SOURCE_DIR = '.tmp.hstack-cli-build-source.incremental';
const BUILD_SOURCE_PATHS = ['package.json', 'tsconfig.json', 'tsconfig.build.json', 'src'];

function resolveBuildOutputDir(env = process.env) {
  const raw = String(env?.HAPPIER_CLI_BUILD_OUTPUT_DIR ?? '').trim();
  if (raw) return raw;
  return `dist.staging.${process.pid}`;
}

function reclaimAbandonedCliBuildDirs(packageRoot, activeOutputDir) {
  const activeOutputPath = resolve(packageRoot, activeOutputDir);
  for (const entry of readdirSync(packageRoot, { withFileTypes: true })) {
    if (
      !entry.name.startsWith('dist.staging.')
      && !entry.name.startsWith('.tmp.hstack-cli-build-source.')
    ) {
      continue;
    }
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    // This compiler cache belongs to the serialized CLI build, not an
    // abandoned generation. Unlocked/caller-owned stages must leave it alone.
    if (entry.name === INCREMENTAL_SOURCE_DIR) continue;
    const entryPath = resolve(packageRoot, entry.name);
    if (entryPath === activeOutputPath) continue;
    rmDirSafeSync(entryPath);
  }
}

async function runNodeScript(scriptPath, args, options = {}) {
  const command = options.command ?? process.execPath;
  const processOptions = {
    ownedProcessGroup: true,
    cwd: options.cwd,
    env: options.env,
    stdio: 'inherit',
  };
  const result = await runCommand(command, [scriptPath, ...args], processOptions);
  if (result.error) throw result.error;
  if (result.signal) {
    const error = new Error(`${scriptPath} terminated by signal ${result.signal}`);
    error.signal = result.signal;
    throw error;
  }
  if (result.status !== 0) {
    const error = new Error(`${scriptPath} exited with status ${String(result.status)}`);
    error.exitCode = result.status;
    throw error;
  }
}

function createImmutableBuildSource({ packageRoot, outputDir, reuseCompilerCache = false }) {
  if (!existsSync(join(packageRoot, 'src'))) {
    return {
      packageRoot,
      packageJsonPath: join(packageRoot, 'package.json'),
      cleanup() {},
    };
  }
  // Keep the immutable generation under the physical package root so Node and
  // TypeScript retain the package-local node_modules resolution ancestry.
  // The CLI publication lock serializes this source path. Reusing its path
  // lets TypeScript reuse checked file identities across dev-watch builds;
  // unlocked builds retain private generations instead.
  const snapshotRoot = reuseCompilerCache
    ? join(packageRoot, INCREMENTAL_SOURCE_DIR)
    : mkdtempSync(join(packageRoot, '.tmp.hstack-cli-build-source.'));
  mkdirSync(snapshotRoot, { recursive: true });
  const cleanup = () => {
    if (!reuseCompilerCache) {
      rmDirSafeSync(snapshotRoot);
      return;
    }
    // Retain only compiler metadata between builds. Authored inputs and bundle
    // stages are disposable copies, and deleted inputs cannot survive a copy.
    for (const relativePath of [...BUILD_SOURCE_PATHS, outputDir]) {
      rmDirSafeSync(join(snapshotRoot, relativePath));
    }
  };
  try {
    if (reuseCompilerCache) cleanup();
    for (const relativePath of BUILD_SOURCE_PATHS) {
      const sourcePath = join(packageRoot, relativePath);
      if (!existsSync(sourcePath)) continue;
      cpSync(sourcePath, join(snapshotRoot, relativePath), { recursive: true });
    }
  } catch (error) {
    try {
      cleanup();
    } catch {
      // Preserve the source-snapshot creation error when best-effort cleanup also fails.
    }
    throw error;
  }
  return {
    packageRoot: snapshotRoot,
    packageJsonPath: join(snapshotRoot, 'package.json'),
    cleanup,
  };
}

export async function buildCliDist(options = {}) {
  const lexicalPackageRoot = resolve(String(options.packageRoot ?? process.cwd()));
  const packageJsonPath = realpathSync.native(join(lexicalPackageRoot, 'package.json'));
  const packageRoot = dirname(packageJsonPath);
  return await withOptionalCliDistBuildLock(
    () => buildCliDistUnlocked({
      ...options,
      packageRoot,
      packageJsonPath,
    }),
    {
      startDir: packageRoot,
      repoRoot: options.repoRoot,
      lockPath: options.lockPath,
      lockTimeoutMs: options.lockTimeoutMs,
      lockPollIntervalMs: options.lockPollIntervalMs,
      lockStaleAfterMs: options.lockStaleAfterMs,
      skipLock: options.skipLock,
      env: options.env,
    },
  );
}

async function buildCliDistUnlocked(options = {}) {
  const packageRoot = resolve(String(options.packageRoot ?? process.cwd()));
  const env = { ...process.env, ...(options.env ?? {}) };
  const buildMode = resolveWorkspaceBuildMode({ env });
  const callerOwnsOutputDir = String(env.HAPPIER_CLI_BUILD_OUTPUT_DIR ?? '').trim().length > 0;
  const outputDir = resolveBuildOutputDir(env);
  env.HAPPIER_CLI_BUILD_OUTPUT_DIR = outputDir;
  const expectedCurrentFingerprint = readCliDistBuildManifestFingerprint(join(packageRoot, 'dist'));
  reclaimAbandonedCliBuildDirs(packageRoot, outputDir);
  const readRuntimeInputFreshness =
    options.readRuntimeInputFreshnessImpl ?? readHappyCliRuntimeInputFreshness;
  const initialInputFreshness = await readRuntimeInputFreshness(packageRoot);
  if (!initialInputFreshness?.fingerprint) {
    throw new Error('[cli-build-inputs] unable to read canonical runtime inputs before build');
  }
  const readWorkspaceRuntimeIdentity =
    options.readWorkspaceRuntimeIdentityImpl ?? readCliNodeWorkspaceRuntimeIdentity;
  const repoRoot = resolve(String(options.repoRoot ?? resolve(packageRoot, '..', '..')));
  const initialWorkspaceRuntimeIdentity = readWorkspaceRuntimeIdentity({
    repoRoot,
    hostPackageDir: packageRoot,
  });
  // Yarn runs build:shared before this script. That preparation can canonically
  // publish generated CLI source, so the immutable snapshot below contains the
  // inputs observed here. Record the
  // fingerprint of the bytes that are actually snapshotted and compiled. A
  // later live-source edit is still detected by the Stack when it compares this
  // manifest with the post-build runtime inputs.
  const compiledInputFingerprint = initialInputFreshness.fingerprint;
  const immutableSource = callerOwnsOutputDir
    ? {
        packageRoot,
        packageJsonPath: options.packageJsonPath,
        cleanup() {},
      }
    : (options.createImmutableBuildSourceImpl ?? createImmutableBuildSource)({
        packageRoot,
        outputDir,
        reuseCompilerCache: options.skipLock !== true,
      });

  try {
    await (options.rmDistImpl ?? rmDist)(['node', 'rmDist.mjs', outputDir], {
      env,
      repoRoot: options.repoRoot,
      lockPath: options.lockPath,
      lockModulePath: options.lockModulePath,
      lockTimeoutMs: options.lockTimeoutMs,
      lockPollIntervalMs: options.lockPollIntervalMs,
      lockStaleAfterMs: options.lockStaleAfterMs,
      skipLock: true,
    });
    const measure = async (phase, operation) => {
      const start = performance.now();
      try { return await operation(); }
      finally { process.stderr.write(`[cli-build] phase=${phase} elapsedMs=${Math.round(performance.now() - start)}\n`); }
    };
    const bundle = () => measure('pkgroll', () => (options.runPkgrollBuildImpl ?? runPkgrollBuild)({
      packageJsonPath: immutableSource.packageJsonPath,
      outputDir,
      env,
    }));
    // Executable preparation does not consume a semantic check. Strict npm
    // publication retains checking, including lifecycle-forced strict mode.
    if (buildMode === 'strict') {
      const typeScriptInvocation = (options.resolveTypeScriptCliInvocationImpl ?? resolveTypeScriptCliInvocation)({
        processExecPath: process.execPath,
      });
      await measure('typecheck', () => (options.runTypecheckImpl ?? runNodeScript)(typeScriptInvocation.argsPrefix[0], [...typeScriptInvocation.argsPrefix.slice(1), '-p', 'tsconfig.build.json', '--noEmit', '--singleThreaded'], {
        command: typeScriptInvocation.command,
        cwd: immutableSource.packageRoot,
        env,
      }));
    }
    await bundle();
    const finalWorkspaceRuntimeIdentity = readWorkspaceRuntimeIdentity({
      repoRoot,
      hostPackageDir: packageRoot,
    });
    if (
      finalWorkspaceRuntimeIdentity.fingerprint
      !== initialWorkspaceRuntimeIdentity.fingerprint
    ) {
      throw new Error(
        '[cli-build-inputs] workspace runtime publication changed during the CLI build; '
        + 'refusing to publish a mixed runtime closure',
      );
    }
    (options.finalizeDistImpl ?? finalizeDist)({
      packageRoot,
      stagingDir: resolve(immutableSource.packageRoot, outputDir),
      expectedCurrentFingerprint,
      inputFingerprint: compiledInputFingerprint,
      workspaceRuntimeIdentity: initialWorkspaceRuntimeIdentity.fingerprint,
      ...(initialWorkspaceRuntimeIdentity.packageNames?.length > 0
        ? { workspaceRuntimePackages: initialWorkspaceRuntimeIdentity.packageNames }
        : {}),
    });
  } finally {
    try {
      immutableSource.cleanup();
    } catch {
      // Best effort: never replace the build result with a source cleanup failure.
    }
    if (!callerOwnsOutputDir) {
      try {
        rmDirSafeSync(resolve(packageRoot, outputDir));
      } catch {
        // Best effort: never replace the build result with a staging cleanup failure.
      }
    }
  }
}

const invokedAsMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return resolve(argv1) === resolve(fileURLToPath(import.meta.url));
})();

if (invokedAsMain) {
  try {
    await buildCliDist();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    exitWithCommandResult({ status: 1, signal: error?.signal });
  }
}
