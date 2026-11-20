import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { exitWithCommandResult, runCommand } from '../../stack/scripts/utils/proc/proc.mjs';
import { resolveWorkspaceBuildMode } from '../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs';
import { resolveWorkspaceTypeScriptCompilerArgs } from '../../../packages/cli-common/workspaceChildBuildEnv.mjs';
import { callerHoldsWorkspaceBundleLock, resolveWorkspaceBundleLockPath } from '../../../scripts/workspaces/workspaceBundleLock.mjs';
import { resolveRemoteCommandPolicy } from '../../stack/scripts/utils/dev_targets/remote_commands.mjs';
import { runWorkspaceBuildAdmission } from '../../stack/scripts/utils/proc/workspace_build_admission.mjs';

import { requiresTypeScriptAdmission, resolveTypeScriptCliInvocation } from '../../../scripts/workspaces/resolveTypeScriptCliInvocation.mjs';
import { resolveTypecheckCacheDirectory } from '../../../scripts/workspaces/workspaceSourceTypecheck.mjs';
import { readHappyCliRuntimeInputFreshness } from '../../stack/scripts/utils/proc/cli_runtime_inputs.mjs';
import { readCliNodeWorkspaceRuntimeIdentity } from '@happier-dev/cli-common/componentArtifacts/copyCliNodeRuntimePayload';
import { finalizeDist, readCliDistBuildManifestFingerprint } from './finalizeDist.mjs';
import { findRepoRoot, withOptionalCliDistBuildLock } from './optionalWorkspaceBundleLock.mjs';
import { main as rmDist } from './rmDist.mjs';
import { rmDirSafeSync } from './rmDirSafe.mjs';
import { runPkgrollBuild } from './runPkgrollBuild.mjs';

const INCREMENTAL_SOURCE_DIR = '.tmp.hstack-cli-build-source.incremental';
const BUILD_SOURCE_PATHS = ['package.json', 'tsconfig.json', 'tsconfig.build.json', 'src', 'scripts/native_process_exit.cjs', 'scripts/native_process_exit.d.cts'];
const CLI_DIST_WORKER_FLAG = '--happier-cli-dist-build-worker';

function authenticatedCliPublicationLease(lockPath, env) {
  let leases;
  try { leases = JSON.parse(env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_LEASES || '[]'); }
  catch { return null; }
  if (!Array.isArray(leases)) return null;
  return [env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD, ...leases].find(lease =>
    typeof lease === 'string' && callerHoldsWorkspaceBundleLock(lockPath, lease)) ?? null;
}

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
    const snapshotConfigPath = join(snapshotRoot, 'tsconfig.json');
    if (existsSync(snapshotConfigPath)) {
      // Parse the captured bytes with the retained compiler API. Compilation
      // still belongs to the native TypeScript invocation below.
      const parsed = ts.readConfigFile(snapshotConfigPath, ts.sys.readFile);
      if (parsed.error) throw new Error(ts.flattenDiagnosticMessageText(parsed.error.messageText, '\n'));
      const options = parsed.config.compilerOptions;
      if (options?.paths) {
        const pathsBase = resolve(packageRoot, options.baseUrl ?? '.');
        options.paths = Object.fromEntries(Object.entries(options.paths).map(([name, targets]) => [name,
          targets.map(target => {
            const originalTarget = resolve(pathsBase, target);
            const localTarget = relative(packageRoot, originalTarget);
            // Internal aliases use admitted snapshot bytes; external declaration
            // aliases keep the prepared dependency identity they originally named.
            return localTarget === '..' || localTarget.startsWith(`..${sep}`) || isAbsolute(localTarget)
              ? originalTarget : resolve(snapshotRoot, localTarget);
          }),
        ]));
        writeFileSync(snapshotConfigPath, `${JSON.stringify(parsed.config, null, 2)}\n`);
      }
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

function copyPreparedCliDeclarations(packageRoot, declarationSourceDir) {
  // This explicit consumer is entered only after the same job's current-source
  // compiler succeeded. Project references own the complete declaration graph;
  // ordinary builds and publication still run their independent strict checker.
  const visited = new Set();
  let copied = 0;
  const sourceRoot = resolve(packageRoot, 'src');
  const copyProject = (configPath) => {
    if (visited.has(configPath)) return;
    visited.add(configPath);
    const project = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic(diagnostic) {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
      },
    });
    if (project.errors.length) throw new Error(project.errors.map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')).join('\n'));
    for (const reference of project.projectReferences ?? []) {
      copyProject(ts.resolveProjectReferencePath(reference));
    }
    for (const source of project.fileNames) {
      const localPath = relative(sourceRoot, source);
      if (localPath === '..' || localPath.startsWith(`..${sep}`) || isAbsolute(localPath)
        || !/\.[cm]?tsx?$/u.test(source) || /\.d\.[cm]?ts$/u.test(source)) continue;
      const declarationPath = ts.getOutputFileNames(project, source, !ts.sys.useCaseSensitiveFileNames)
        .find((path) => /\.d\.[cm]?ts$/u.test(path));
      if (!declarationPath || !existsSync(declarationPath)) {
        throw new Error(`missing prepared CLI declaration ${declarationPath ?? source} from ${configPath}; run the current source compiler before this consumer`);
      }
      const target = join(declarationSourceDir, localPath.replace(/\.([cm]?)tsx?$/u, '.d.$1ts'));
      mkdirSync(dirname(target), { recursive: true });
      cpSync(declarationPath, target);
      copied += 1;
    }
  };
  // The public source compiler derives current membership into this project.
  // Consume its exact references and file set, rather than the authored seed.
  copyProject(join(resolveTypecheckCacheDirectory(packageRoot), 'tsconfig.source.json'));
  if (!copied) throw new Error('missing prepared CLI declaration graph; run the current source compiler before this consumer');
}

export async function buildCliDist(options = {}) {
  const lexicalPackageRoot = resolve(String(options.packageRoot ?? process.cwd()));
  const packageJsonPath = realpathSync.native(join(lexicalPackageRoot, 'package.json'));
  const packageRoot = dirname(packageJsonPath);
  const repoRoot = resolve(String(options.repoRoot ?? findRepoRoot(packageRoot)));
  const lockPath = resolve(String(options.lockPath ?? resolveWorkspaceBundleLockPath(repoRoot)));
  let env = { ...process.env, ...(options.env ?? {}) };
  const effectiveCompilerArgs = resolveWorkspaceTypeScriptCompilerArgs({
    compilerArgs: ['-p', 'tsconfig.build.json', '--noEmit', 'false', '--emitDeclarationOnly', '--singleThreaded'], env,
  });
  const admissionClass = resolveRemoteCommandPolicy(
    [process.execPath, fileURLToPath(import.meta.url), ...effectiveCompilerArgs],
    { cwd: relative(repoRoot, packageRoot).replaceAll('\\', '/') || '.' },
  ).heavyClass;
  const privateWorker = process.argv[2] === CLI_DIST_WORKER_FLAG
    && resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url);
  if (privateWorker) {
    const heldLockValue = authenticatedCliPublicationLease(lockPath, env);
    if (!heldLockValue) throw new Error('CLI dist worker requires its authenticated inherited CLI publication lease');
    env = { ...env, HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: heldLockValue };
  } else if (options.skipLock !== true && !String(env.HAPPIER_CLI_BUILD_OUTPUT_DIR ?? '').trim()
    && !Object.entries(options).some(([key, value]) => key.endsWith('Impl') && value !== undefined)) {
    const workerOptions = { packageRoot, repoRoot, lockPath, preparedDeclarations: options.preparedDeclarations,
      lockTimeoutMs: options.lockTimeoutMs, lockPollIntervalMs: options.lockPollIntervalMs,
      lockStaleAfterMs: options.lockStaleAfterMs };
    const result = await runWorkspaceBuildAdmission({
      command: process.execPath,
      args: [fileURLToPath(import.meta.url), CLI_DIST_WORKER_FLAG, JSON.stringify(workerOptions)],
      locks: [{ path: lockPath, errorLabel: 'CLI dist build lock',
        timeoutMs: options.lockTimeoutMs, pollIntervalMs: options.lockPollIntervalMs,
        staleAfterMs: options.lockStaleAfterMs }],
      cwd: packageRoot, repoDir: repoRoot, env, signal: options.signal,
      admissionClass, admissionRequired: requiresTypeScriptAdmission({ env }), stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0 || result.signal) {
      const error = new Error(result.signal
        ? `CLI dist build terminated by signal ${result.signal}`
        : `CLI dist build exited with status ${String(result.status)}`);
      error.exitCode = result.status;
      error.signal = result.signal;
      throw error;
    }
    return;
  }
  return await withOptionalCliDistBuildLock(
    () => buildCliDistUnlocked({
      ...options,
      packageRoot,
      packageJsonPath,
      repoRoot,
      env,
      effectiveCompilerArgs,
      admissionClass,
    }),
    {
      startDir: packageRoot,
      repoRoot,
      lockPath,
      lockTimeoutMs: options.lockTimeoutMs,
      lockPollIntervalMs: options.lockPollIntervalMs,
      lockStaleAfterMs: options.lockStaleAfterMs,
      skipLock: options.skipLock,
      env,
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

  let declarationSourceDir;
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
      declarationSourceDir,
    }));
    // Executable preparation does not consume a semantic check. Strict npm
    // publication retains checking, including lifecycle-forced strict mode.
    if (buildMode === 'strict') {
      declarationSourceDir = mkdtempSync(join(immutableSource.packageRoot, '.tmp.hstack-cli-declarations.'));
      // Only the named Gate build consumer accepts this same-job input.
      // Other callers retain the shared lifecycle policy's strict source check.
      if (options.preparedDeclarations === true && env.npm_lifecycle_event === 'build:prepared') {
        await measure('prepared-declarations', () => copyPreparedCliDeclarations(packageRoot, declarationSourceDir));
      } else {
        const typeScriptInvocation = (options.resolveTypeScriptCliInvocationImpl ?? resolveTypeScriptCliInvocation)({
          processExecPath: process.execPath,
          invocationKind: 'build',
          env,
          args: options.effectiveCompilerArgs,
          workspaceDir: packageRoot,
          admissionClass: options.admissionClass,
        });
        // Emit checked declarations with the canonical native compiler once.
        // Pkgroll bundles those public types without another source program.
        await measure('typecheck', () => (options.runTypecheckImpl ?? runNodeScript)(typeScriptInvocation.argsPrefix[0], [...typeScriptInvocation.argsPrefix.slice(1), ...options.effectiveCompilerArgs, '--outDir', declarationSourceDir], {
          command: typeScriptInvocation.command,
          cwd: immutableSource.packageRoot,
          env,
        }));
      }
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
    if (declarationSourceDir) {
      try {
        rmDirSafeSync(declarationSourceDir);
      } catch {
        // Best effort: preserve the build result if declaration cleanup fails.
      }
    }
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
    const options = process.argv[2] === CLI_DIST_WORKER_FLAG ? JSON.parse(process.argv[3] ?? '{}')
      : { preparedDeclarations: process.argv.includes('--prepared-declarations') };
    await buildCliDist(options);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    exitWithCommandResult({ status: error?.exitCode ?? 1, signal: error?.signal });
  }
}
