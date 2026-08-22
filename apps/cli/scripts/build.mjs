import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveTypeScriptCliInvocation } from '../../../scripts/workspaces/resolveTypeScriptCliInvocation.mjs';
import { readHappyCliRuntimeInputFreshness } from '../../stack/scripts/utils/proc/cli_runtime_inputs.mjs';
import { readCliNodeWorkspaceRuntimeIdentity } from '@happier-dev/cli-common/componentArtifacts/copyCliNodeRuntimePayload';
import { finalizeDist, readCliDistBuildManifestFingerprint } from './finalizeDist.mjs';
import { withOptionalCliDistBuildLock } from './optionalWorkspaceBundleLock.mjs';
import { main as rmDist } from './rmDist.mjs';
import { runPkgrollBuild } from './runPkgrollBuild.mjs';

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
    const entryPath = resolve(packageRoot, entry.name);
    if (entryPath === activeOutputPath) continue;
    rmSync(entryPath, { recursive: true, force: true });
  }
}

function runNodeScript(scriptPath, args, options = {}) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.signal) {
    throw new Error(`${scriptPath} terminated by signal ${result.signal}`);
  }
  if (result.status !== 0) {
    throw new Error(`${scriptPath} exited with status ${String(result.status)}`);
  }
}

function createImmutableBuildSource({ packageRoot }) {
  if (!existsSync(join(packageRoot, 'src'))) {
    return {
      packageRoot,
      packageJsonPath: join(packageRoot, 'package.json'),
      cleanup() {},
    };
  }
  // Keep the immutable generation under the physical package root so Node and
  // TypeScript retain the package-local node_modules resolution ancestry.
  const snapshotRoot = mkdtempSync(join(packageRoot, '.tmp.hstack-cli-build-source.'));
  try {
    for (const relativePath of [
      'package.json',
      'tsconfig.json',
      'tsconfig.build.json',
      'src',
    ]) {
      const sourcePath = join(packageRoot, relativePath);
      if (!existsSync(sourcePath)) continue;
      cpSync(sourcePath, join(snapshotRoot, relativePath), { recursive: true });
    }
  } catch (error) {
    rmSync(snapshotRoot, { recursive: true, force: true });
    throw error;
  }
  return {
    packageRoot: snapshotRoot,
    packageJsonPath: join(snapshotRoot, 'package.json'),
    cleanup() {
      rmSync(snapshotRoot, { recursive: true, force: true });
    },
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
  const stackAdmittedInputFingerprint = String(
    env.HAPPIER_CLI_BUILD_INPUT_FINGERPRINT ?? '',
  ).trim().toLowerCase();
  if (
    stackAdmittedInputFingerprint
    && !/^[a-f0-9]{64}$/.test(stackAdmittedInputFingerprint)
  ) {
    throw new Error('[cli-build-inputs] invalid Stack-admitted runtime input fingerprint');
  }
  // Yarn runs build:shared before this script. That preparation can canonically
  // publish generated CLI source, so the immutable snapshot below contains the
  // inputs observed here rather than the Stack's earlier admission. Record the
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
    const typeScriptInvocation = (options.resolveTypeScriptCliInvocationImpl ?? resolveTypeScriptCliInvocation)({
      processExecPath: process.execPath,
    });
    (options.runTypecheckImpl ?? runNodeScript)(typeScriptInvocation.argsPrefix[0], ['-p', 'tsconfig.build.json', '--noEmit'], {
      cwd: immutableSource.packageRoot,
      env,
    });
    (options.runPkgrollBuildImpl ?? runPkgrollBuild)({
      packageJsonPath: immutableSource.packageJsonPath,
      outputDir,
      env,
    });
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
    immutableSource.cleanup();
    if (!callerOwnsOutputDir) {
      rmSync(resolve(packageRoot, outputDir), { recursive: true, force: true });
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
    process.exit(1);
  }
}
