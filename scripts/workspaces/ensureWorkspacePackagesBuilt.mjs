import { existsSync } from 'node:fs';
import { lstat, readFile, readdir, utimes } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { buildIntoTempThenReplace } from '../../apps/stack/scripts/utils/fs/atomic_dir_swap.mjs';
import { coerceHappyMonorepoRootFromPath } from '../../apps/stack/scripts/utils/paths/paths.mjs';
import { withCliDistBuildLock } from '../../apps/stack/scripts/utils/proc/cliDistBuildLock.mjs';
import { run } from '../../apps/stack/scripts/utils/proc/proc.mjs';
import { collectWorkspacePackageJsonPaths } from '../../apps/stack/scripts/utils/proc/workspace_package_manifests.mjs';
import { resolveWorkspaceToolBinDirs } from '../../apps/stack/scripts/utils/proc/workspace_tool_bins.mjs';
import { assertNoMissingLocalImports } from './distLocalImports.mjs';
import { resolveYarnCommandInvocation } from './execYarnCommand.mjs';
import {
  collectPackageBuildOutputTargets,
  isPackageBuildDistOutputTarget,
  resolvePackageBuildOutputTargetMatches,
  resolvePackageBuildOutputTargetPath,
} from './packageBuildOutputTargets.mjs';
import {
  resolveWorkspaceBundleLockPath,
  withWorkspaceBundleLock,
} from './workspaceBundleLock.mjs';
import { resolveWorkspacePackageBuildLockPath } from './workspacePackageBuildLock.mjs';
import { WORKSPACE_PACKAGE_PREREQUISITES_READY_ENV_VAR } from './workspaceChildBuildEnv.mjs';
import { resolveWorkspaceBundlePublicationMode } from './workspaceBundlePublication.mjs';
import { syncBundledWorkspacePackages } from './syncBundledWorkspacePackages.mjs';

const GENERATED_PLUGIN_UI_ARTIFACTS_MANIFEST_RELATIVE_PATH =
  'dist/happier-plugin-ui/ui-artifacts.json';
const DEFAULT_MAX_CONCURRENT_WORKSPACE_BUILDS = 2;

function createAsyncConcurrencyLimiter(maxConcurrent) {
  const limit = Number.isInteger(maxConcurrent) && maxConcurrent > 0
    ? maxConcurrent
    : DEFAULT_MAX_CONCURRENT_WORKSPACE_BUILDS;
  let active = 0;
  const waiters = [];

  const release = () => {
    active -= 1;
    const next = waiters.shift();
    if (next) next();
  };

  return async (operation) => {
    if (active >= limit) {
      await new Promise((resolveWaiter) => waiters.push(resolveWaiter));
    }
    active += 1;
    try {
      return await operation();
    } finally {
      release();
    }
  };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf-8'));
}

async function collectWorkspacePackageDirsByName(monorepoRoot) {
  const paths = await collectWorkspacePackageJsonPaths(monorepoRoot);
  const packageDirsByName = new Map();

  for (const packageJsonPath of paths) {
    let packageJson = null;
    try {
      packageJson = await readJson(packageJsonPath);
    } catch {
      continue;
    }
    const packageName = typeof packageJson?.name === 'string' ? packageJson.name.trim() : '';
    if (packageName) packageDirsByName.set(packageName, dirname(packageJsonPath));
  }

  return packageDirsByName;
}

function collectInternalWorkspaceDependencyNames(
  packageJson,
  currentPackageName,
  { includeDevDependencies = true, workspacePackageNames = null } = {},
) {
  const knownWorkspacePackageNames = workspacePackageNames
    ? new Set(workspacePackageNames)
    : null;
  const names = [];
  const dependencyFields = [packageJson?.dependencies, packageJson?.optionalDependencies];
  if (includeDevDependencies) dependencyFields.push(packageJson?.devDependencies);
  for (const dependencies of dependencyFields) {
    if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) continue;
    for (const name of Object.keys(dependencies)) {
      const isInternalWorkspace = knownWorkspacePackageNames
        ? knownWorkspacePackageNames.has(name)
        : name.startsWith('@happier-dev/');
      if (!isInternalWorkspace || name === currentPackageName) continue;
      names.push(name);
    }
  }
  return names;
}

function hasBundledWorkspaceDependencies(packageJson) {
  const bundledDependencies = Array.isArray(packageJson?.bundledDependencies)
    ? packageJson.bundledDependencies
    : Array.isArray(packageJson?.bundleDependencies)
      ? packageJson.bundleDependencies
      : [];
  return bundledDependencies.some((packageName) => (
    typeof packageName === 'string' && packageName.trim().startsWith('@happier-dev/')
  ));
}

function collectExpectedPackageOutputTargets(packageJson) {
  const candidates = collectPackageBuildOutputTargets(packageJson);
  // A declared plugin UI build is part of the package's atomic dist contract,
  // even though its generated graph is not a JavaScript export target.
  if (
    typeof packageJson?.scripts?.['build:ui'] === 'string'
    && packageJson.scripts['build:ui'].trim()
  ) {
    candidates.push(GENERATED_PLUGIN_UI_ARTIFACTS_MANIFEST_RELATIVE_PATH);
  }

  return [...new Set(candidates)].filter(isPackageBuildDistOutputTarget);
}

function resolveExpectedPackageOutputTargetMatches({ packageDir, distDir, expectedTargets }) {
  return expectedTargets.map((target) => ({
    target,
    paths: resolvePackageBuildOutputTargetMatches({
      packageDir,
      outputDir: distDir,
      target,
    }),
  }));
}

function remapPathToDirectory(path, { sourceDir, destinationDir }) {
  const absolutePath = resolve(path);
  const sourceRoot = resolve(sourceDir);
  if (absolutePath === sourceRoot) return resolve(destinationDir);
  if (absolutePath.startsWith(sourceRoot + sep)) {
    return join(resolve(destinationDir), relative(sourceRoot, absolutePath));
  }
  return absolutePath;
}

function remapDistPathToDir(path, { packageDir, distDir }) {
  return remapPathToDirectory(path, {
    sourceDir: join(packageDir, 'dist'),
    destinationDir: distDir,
  });
}

async function refreshWorkspaceBuildOutputCurrentness(outputPaths) {
  const timestamp = new Date();
  for (const path of new Set(outputPaths)) {
    let entryStat;
    try {
      entryStat = await lstat(path);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (entryStat.isSymbolicLink()) continue;
    await utimes(path, timestamp, timestamp);
  }
}

async function collectStagedWorkspaceBuildOutputPaths(path) {
  const entryStat = await lstat(path);
  if (!entryStat.isDirectory()) return [path];

  const entries = await readdir(path);
  if (entries.length === 0) return [path];
  return (
    await Promise.all(
      entries.map((entry) => collectStagedWorkspaceBuildOutputPaths(join(path, entry))),
    )
  ).flat();
}

function isWorkspaceBuildConfigFile(name) {
  if (name === 'package.json') return true;
  if (/^tsconfig(?:\.[^.]+)*\.json$/.test(name)) {
    return !/\.(?:test|tests|type-tests)\.json$/.test(name);
  }
  return /^(?:rollup|vite|esbuild|babel|swc|rspack|tsup|happier-plugin-ui)\.config\.(?:js|cjs|mjs|ts|json)$/.test(name);
}

async function readNewestWorkspaceBuildInputChangeTimeNs(packageDir) {
  let newest = null;
  const visit = async (path) => {
    const name = path.split(sep).at(-1) ?? '';
    if (
      name === '__tests__'
      || name === 'test'
      || name === 'tests'
      || name === 'fixtures'
      || /\.(?:test|spec)\.[^.]+$/.test(name)
    ) {
      return;
    }

    let entryStat;
    try {
      entryStat = await lstat(path, { bigint: true });
    } catch {
      return;
    }
    if (entryStat.isDirectory()) {
      for (const childName of await readdir(path)) await visit(join(path, childName));
      return;
    }
    const changedAtNs = entryStat.ctimeNs > entryStat.mtimeNs
      ? entryStat.ctimeNs
      : entryStat.mtimeNs;
    newest = newest === null || changedAtNs > newest ? changedAtNs : newest;
  };

  let entries = [];
  try {
    entries = await readdir(packageDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (
      (entry.isDirectory() && (entry.name === 'src' || entry.name === 'sources'))
      || (entry.isFile() && isWorkspaceBuildConfigFile(entry.name))
    ) {
      await visit(join(packageDir, entry.name));
    }
  }
  return newest;
}

async function readWorkspaceBuildOutputChangeTimeNs(outputPaths, { newest = false } = {}) {
  let selected = null;
  let complete = true;
  const visit = async (path) => {
    let entryStat;
    try {
      entryStat = await lstat(path, { bigint: true });
    } catch {
      complete = false;
      return;
    }
    if (entryStat.isDirectory()) {
      let childNames;
      try {
        childNames = await readdir(path);
      } catch {
        complete = false;
        return;
      }
      if (childNames.length > 0) {
        for (const childName of childNames) await visit(join(path, childName));
        return;
      }
    }
    const changedAtNs = entryStat.ctimeNs > entryStat.mtimeNs
      ? entryStat.ctimeNs
      : entryStat.mtimeNs;
    const shouldSelect = selected === null
      || (newest ? changedAtNs > selected : changedAtNs < selected);
    if (shouldSelect) selected = changedAtNs;
  };

  for (const outputPath of outputPaths) await visit(outputPath);
  return complete ? selected : null;
}

async function readOldestWorkspaceBuildOutputChangeTimeNs(outputPaths) {
  return await readWorkspaceBuildOutputChangeTimeNs(outputPaths);
}

async function readNewestWorkspaceBuildOutputChangeTimeNs(outputPaths) {
  return await readWorkspaceBuildOutputChangeTimeNs(outputPaths, { newest: true });
}

// Timestamp ordering is a reuse heuristic, not derivation proof. Artifact
// publishers that must bind outputs to current inputs use this owner's `force`
// admission instead of trusting recreated output timestamps.
async function workspaceOutputsAppearCurrent(packageDir, expectedTargetMatches) {
  const newestInput = await readNewestWorkspaceBuildInputChangeTimeNs(packageDir);
  if (newestInput === null) return true;
  // Live publication retains formerly referenced content-addressed wildcard
  // targets. One current match is sufficient for that variable output family;
  // exact targets still require every declared output to be current.
  const outputTimes = await Promise.all(expectedTargetMatches.map(({ target, paths }) => (
    String(target).includes('*')
      ? readNewestWorkspaceBuildOutputChangeTimeNs(paths)
      : readOldestWorkspaceBuildOutputChangeTimeNs(paths)
  )));
  return outputTimes.every((outputTime) => outputTime !== null && outputTime >= newestInput);
}

function parsePositiveEnvInt(envValue, fallback) {
  const raw = Number.parseInt(String(envValue ?? '').trim(), 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

function createWorkspaceBuildWaitNotifier({ env = process.env, label, kind }) {
  const noticeAfterMs = parsePositiveEnvInt(env.HAPPIER_WORKSPACE_BUILD_NOTICE_AFTER_MS, 5_000);
  const noticeEveryMs = parsePositiveEnvInt(env.HAPPIER_WORKSPACE_BUILD_NOTICE_EVERY_MS, 30_000);
  let lastNoticeMs = null;

  return (event = {}) => {
    const waitedMs = Number(event.waitedMs ?? 0);
    if (!Number.isFinite(waitedMs) || waitedMs < noticeAfterMs) return;
    if (lastNoticeMs != null && waitedMs - lastNoticeMs < noticeEveryMs) return;
    lastNoticeMs = waitedMs;

    let message = '';
    if (kind === 'lock') {
      const owner = event.owner && typeof event.owner === 'object' ? event.owner : null;
      const ageMs = owner
        ? Math.max(0, Date.now() - Number(owner.updatedAtMs ?? owner.createdAtMs ?? Date.now()))
        : null;
      const ownerText = owner
        ? `pid=${String(owner.pid ?? 'unknown')} ageMs=${ageMs}`
        : 'owner=unknown';
      message = `[local] waiting for ${label} lock (${Math.ceil(waitedMs / 1000)}s): ${event.lockPath} (${ownerText})`;
    } else {
      const attempt = Number(event.attempt ?? 0);
      const attempts = Number(event.attempts ?? 0);
      const attemptLabel = Number.isFinite(attempts) && attempts > 0
        ? `${attempt + 1}/${attempts}`
        : `${attempt + 1}/?`;
      message = `[local] waiting for ${label} local imports to settle (${Math.ceil(waitedMs / 1000)}s, attempt ${attemptLabel}): ${event.entryPath}`;
    }

    try {
      process.stderr.write(`${message}\n`);
    } catch {}
  };
}

async function assertNoMissingLocalImportsWithRetry({
  distDir,
  entryPath,
  label,
  env,
  onRetry,
}) {
  const attempts = parsePositiveEnvInt(
    env.HAPPIER_WORKSPACE_DIST_IMPORT_VALIDATION_RETRY_ATTEMPTS,
    24,
  );
  const delayMs = parsePositiveEnvInt(
    env.HAPPIER_WORKSPACE_DIST_IMPORT_VALIDATION_RETRY_DELAY_MS,
    250,
  );
  let lastError = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await assertNoMissingLocalImports({ distDir, entryPath, label });
      return;
    } catch (error) {
      lastError = error;
      onRetry?.({
        attempt,
        attempts,
        delayMs,
        entryPath,
        label,
        waitedMs: attempt * delayMs,
        error,
      });
      if (attempt >= attempts - 1) throw error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
    }
  }

  throw lastError ?? new Error(`[local] ${label} import validation failed for ${entryPath}`);
}

async function inspectWorkspacePackageOutput(packageDir, packageJson, {
  env = process.env,
  retryImports = false,
  admitPriorOutputsImmediately = false,
} = {}) {
  const expectedTargets = collectExpectedPackageOutputTargets(packageJson);
  const distDir = join(packageDir, 'dist');
  const expectedTargetMatches = resolveExpectedPackageOutputTargetMatches({
    packageDir,
    distDir,
    expectedTargets,
  });
  const expectedFiles = [...new Set(expectedTargetMatches.flatMap(({ paths }) => paths))];
  const missing = expectedTargetMatches
    .filter(({ paths }) => paths.length === 0)
    .map(({ target }) => target);
  const distRoot = resolve(distDir);
  const distEntrypoints = expectedTargets
    .filter((target) => !target.includes('*'))
    .filter((target) => /\.(?:mjs|cjs|js)$/.test(target))
    .map((target) => resolvePackageBuildOutputTargetPath({
      packageDir,
      outputDir: distDir,
      target,
    }))
    .filter((path) => {
      const absolutePath = resolve(path);
      return absolutePath === distRoot || absolutePath.startsWith(distRoot + sep);
    });
  const label = packageJson?.name ? `${packageJson.name} dist build` : 'dist build';

  if (expectedTargets.length === 0 || (missing.length === 0 && distEntrypoints.length === 0)) {
    return {
      complete: true,
      expectedTargets,
      expectedFiles,
      missing,
      distDir,
      distEntrypoints,
      label,
    };
  }

  const outputsAreAdmissible = missing.length === 0 && (
    admitPriorOutputsImmediately
    || await workspaceOutputsAppearCurrent(packageDir, expectedTargetMatches)
  );
  if (outputsAreAdmissible) {
    try {
      for (const entryPath of distEntrypoints) {
        if (
          retryImports
          && String(env.HAPPIER_WORKSPACE_DIST_IMPORT_VALIDATION_RETRY_ATTEMPTS ?? '').trim()
        ) {
          await assertNoMissingLocalImportsWithRetry({ distDir, entryPath, label, env });
        } else {
          await assertNoMissingLocalImports({ distDir, entryPath, label });
        }
      }
      return {
        complete: true,
        expectedTargets,
        expectedFiles,
        missing,
        distDir,
        distEntrypoints,
        label,
      };
    } catch {
      // A partial import graph is stale even when every package.json target exists.
    }
  }

  return {
    complete: false,
    expectedTargets,
    expectedFiles,
    missing,
    distDir,
    distEntrypoints,
    label,
  };
}

function prependPathEntry(env, entry) {
  const candidate = String(entry ?? '').trim();
  if (!candidate) return;
  const delimiter = process.platform === 'win32' ? ';' : ':';
  const current = String(env.PATH ?? '')
    .split(delimiter)
    .map((value) => value.trim())
    .filter(Boolean);
  env.PATH = [candidate, ...current.filter((value) => value !== candidate)].join(delimiter);
}

async function prepareWorkspaceBuildEnv(packageDir, envIn) {
  const env = { ...(envIn && typeof envIn === 'object' ? envIn : process.env) };
  env.REDISMS_DISABLE_POSTINSTALL ??= '1';
  prependPathEntry(env, dirname(process.execPath));
  const workspaceToolBinDirs = await resolveWorkspaceToolBinDirs(packageDir);
  for (const workspaceToolBinDir of workspaceToolBinDirs.reverse()) {
    prependPathEntry(env, workspaceToolBinDir);
  }
  const tsconfigPath = join(packageDir, 'tsconfig.json');
  if (existsSync(tsconfigPath)) env.TSX_TSCONFIG_PATH = tsconfigPath;
  else delete env.TSX_TSCONFIG_PATH;
  return env;
}

async function runYarn(args, {
  cwd,
  env,
  quiet,
  input = null,
  timeoutMs = null,
  captureFailureDiagnostic = false,
}) {
  const invocation = resolveYarnCommandInvocation(args, { npmExecPath: env?.npm_execpath });
  const outputMode = quiet ? 'ignore' : 'inherit';
  const stdio = input === null ? outputMode : ['pipe', outputMode, outputMode];
  await run(invocation.command, invocation.args, {
    cwd,
    env,
    stdio,
    ...(input === null ? {} : { input }),
    ...(timeoutMs === null ? {} : { timeoutMs }),
    ...(captureFailureDiagnostic ? { captureFailureDiagnostic: true } : {}),
    ...(invocation.windowsVerbatimArguments
      ? { windowsVerbatimArguments: invocation.windowsVerbatimArguments }
      : {}),
  });
}

async function runWorkspacePackageBuild(packageDir, { env, quiet, timeoutMs }) {
  try {
    await runYarn(['-s', 'build'], {
      cwd: packageDir,
      env,
      quiet,
      timeoutMs,
      captureFailureDiagnostic: quiet,
    });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(
        `[local] yarn is required for component at ${packageDir}. Install it via Corepack: \`corepack enable\``,
        { cause: error },
      );
    }
    throw error;
  }
}

const defaultWorkspaceBuildBoundary = {
  prepareEnv: async (packageDir, env) => prepareWorkspaceBuildEnv(packageDir, env),
  runPackageBuild: runWorkspacePackageBuild,
};

async function ensureWorkspacePackageBuiltUnderLock({
  monorepoRoot,
  packageDir,
  packageJsonPath,
  quiet,
  env,
  force,
  timeoutMs,
  onPackageBuildStart,
  onPackageBuildDone,
  waited,
  heldLockValue,
  workspaceBuildBoundary,
  publicationMode,
}) {
  const packageJson = await readJson(packageJsonPath);
  const state = await inspectWorkspacePackageOutput(packageDir, packageJson, {
    env,
    retryImports: true,
  });
  const {
    expectedTargets,
    missing: missingBefore,
    distDir,
    distEntrypoints,
    label,
  } = state;
  const reportImportRetry = createWorkspaceBuildWaitNotifier({ env, label, kind: 'imports' });
  if (expectedTargets.length === 0) return { built: false, reason: 'no-expected-files' };
  if (!force && state.complete) {
    return {
      built: false,
      reason: waited ? 'concurrent_build_already_completed' : 'already-built',
    };
  }

  if (!packageJson?.scripts?.build) {
    throw new Error(
      `[local] missing build outputs for ${packageJson?.name ?? packageDir}:\n`
      + missingBefore.map((path) => `- ${path}`).join('\n')
      + '\nFix: add a build script, or ensure the package does not export dist/* paths.',
    );
  }

  let stagedOutputPaths = [];
  syncBundledWorkspacePackages({
    repoRoot: monorepoRoot,
    hostPackageDirs: [packageDir],
    replaceExisting: true,
    pruneStale: true,
    syncId: `workspace-build.${process.pid}`,
  });

  await onPackageBuildStart?.({
    packageDir,
    packageName: String(packageJson?.name ?? '').trim(),
  });
  await buildIntoTempThenReplace(distDir, async (tmpDistDir) => {
    const buildEnv = {
      ...env,
      HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: heldLockValue,
      HAPPIER_WORKSPACE_DIST_OUTPUT_DIR: tmpDistDir,
      [WORKSPACE_PACKAGE_PREREQUISITES_READY_ENV_VAR]: '1',
    };
    await workspaceBuildBoundary.runPackageBuild(packageDir, {
      env: buildEnv,
      quiet,
      timeoutMs,
    });

    const stagedExpectedTargetMatches = resolveExpectedPackageOutputTargetMatches({
      packageDir,
      distDir: tmpDistDir,
      expectedTargets,
    });
    const missingStaged = stagedExpectedTargetMatches
      .filter(({ paths }) => paths.length === 0)
      .map(({ target }) => target);
    if (missingStaged.length > 0) {
      throw new Error(
        `[local] build completed but expected staged outputs are still missing for ${packageJson?.name ?? packageDir}:\n`
        + missingStaged.map((path) => `- ${path}`).join('\n')
        + '\nFix: ensure the package build honors HAPPIER_WORKSPACE_DIST_OUTPUT_DIR or generates the files referenced by package.json exports/main/types.',
      );
    }
    stagedOutputPaths = (await Promise.all(stagedExpectedTargetMatches
      .flatMap(({ paths }) => paths)
      .map((path) => collectStagedWorkspaceBuildOutputPaths(path))))
      .flat()
      .map((path) => remapPathToDirectory(path, {
        sourceDir: tmpDistDir,
        destinationDir: distDir,
      }));

    for (const entryPath of distEntrypoints) {
      await assertNoMissingLocalImportsWithRetry({
        distDir: tmpDistDir,
        entryPath: remapDistPathToDir(entryPath, { packageDir, distDir: tmpDistDir }),
        label,
        env,
        onRetry: reportImportRetry,
      });
    }
  }, {
    preserveDestinationPath: publicationMode === 'live',
    pruneStale: publicationMode === 'artifact',
  });
  // Mounted live publication deliberately retains byte-identical files so
  // active module resolvers keep their path/inode. Refresh only successfully
  // staged declared outputs so this owner's existing timestamp admission still
  // converges after a source change without introducing a build record or
  // touching retained obsolete live targets.
  await refreshWorkspaceBuildOutputCurrentness(stagedOutputPaths);
  await onPackageBuildDone?.({
    packageDir,
    packageName: String(packageJson?.name ?? '').trim(),
  });

  return { built: true, reason: 'rebuilt' };
}

async function ensureWorkspacePackageBuilt(packageDir, {
  monorepoRoot,
  quiet,
  env: envIn,
  force,
  timeoutMs,
  onPackageBuildStart,
  onPackageBuildDone,
  workspaceBuildBoundary,
  admitPriorOutputsImmediately,
  publicationMode,
}) {
  const packageJsonPath = join(packageDir, 'package.json');
  if (!existsSync(packageJsonPath)) return { built: false, reason: 'missing-package-json' };

  const packageJson = await readJson(packageJsonPath);
  const initial = await inspectWorkspacePackageOutput(packageDir, packageJson, {
    env: envIn,
    admitPriorOutputsImmediately,
  });
  if (initial.expectedTargets.length === 0) return { built: false, reason: 'no-expected-files' };
  if (!force && initial.complete) return { built: false, reason: 'already-built' };

  const env = await workspaceBuildBoundary.prepareEnv(packageDir, envIn);
  const lockPath = resolveWorkspacePackageBuildLockPath(packageDir, packageJson);
  const workspaceBundleLockPath = hasBundledWorkspaceDependencies(packageJson)
    ? resolveWorkspaceBundleLockPath(monorepoRoot)
    : null;
  const reportLockWait = createWorkspaceBuildWaitNotifier({
    env,
    label: initial.label,
    kind: 'lock',
  });
  const tryResolveWaiter = force
    ? undefined
    : async () => {
      const currentPackageJson = await readJson(packageJsonPath);
      const current = await inspectWorkspacePackageOutput(packageDir, currentPackageJson, {
        env,
        retryImports: true,
      });
      return current.complete
        ? {
          resolved: true,
          value: { built: false, reason: 'concurrent_build_already_completed' },
        }
        : { resolved: false };
    };
  const buildUnderPackageLock = async (workspaceBundleLockValue = null) => (
    await withCliDistBuildLock(
      ({ waited, heldLockValue }) => ensureWorkspacePackageBuiltUnderLock({
        monorepoRoot,
        packageDir,
        packageJsonPath,
        quiet,
        env,
        force,
        timeoutMs,
        onPackageBuildStart,
        onPackageBuildDone,
        waited,
        // Bundled packages run their lifecycle beneath the global publication
        // lease so nested bundle publication can reenter B without waiting on
        // its own package lock. Ordinary packages preserve the P lease.
        heldLockValue: workspaceBundleLockValue ?? heldLockValue,
        workspaceBuildBoundary,
        publicationMode,
      }),
      { lockPath, env, onWait: reportLockWait, tryResolveWaiter },
    )
  );
  if (!workspaceBundleLockPath) return await buildUnderPackageLock();

  return await withWorkspaceBundleLock(
    async ({ heldLockValue }) => await buildUnderPackageLock(heldLockValue),
    {
      lockPath: workspaceBundleLockPath,
      env,
      onWait: reportLockWait,
    },
  );
}

async function ensureWorkspacePackageNamesBuilt(monorepoRoot, packageNames, {
  quiet,
  env,
  forcePackageNames = [],
  timeoutMs,
  onPackageBuildStart,
  onPackageBuildDone,
  visitedNames = [],
  includeDevDependencies,
  packageDirsByName: packageDirsByNameIn = null,
  workspaceBuildBoundary,
  admitPriorOutputsImmediately,
  publicationMode,
  maxConcurrentBuilds,
}) {
  const built = [];
  const visited = new Set(visitedNames);
  const forced = new Set(forcePackageNames);
  const changedClosures = new Set();
  const closureBuildPromises = new Map();
  const packageDirsByName = packageDirsByNameIn
    ?? await collectWorkspacePackageDirsByName(monorepoRoot);
  const workspacePackageNames = new Set(packageDirsByName.keys());
  const schedulePackageBuild = createAsyncConcurrencyLimiter(maxConcurrentBuilds);

  const buildWorkspaceClosure = (packageDir, ancestors = new Set()) => {
    const resolvedPackageDir = resolve(packageDir);
    if (ancestors.has(resolvedPackageDir)) return Promise.resolve(false);

    const existing = closureBuildPromises.get(resolvedPackageDir);
    if (existing) return existing;

    const nextAncestors = new Set(ancestors);
    nextAncestors.add(resolvedPackageDir);
    const buildPromise = (async () => {
      const packageJsonPath = join(resolvedPackageDir, 'package.json');
      if (!existsSync(packageJsonPath)) return false;

      const packageJson = await readJson(packageJsonPath);
      const packageName = typeof packageJson?.name === 'string' ? packageJson.name : '';
      if (packageName && visited.has(packageName)) return changedClosures.has(packageName);
      if (packageName) visited.add(packageName);

      const dependencyResults = await Promise.all(collectInternalWorkspaceDependencyNames(
        packageJson,
        packageName,
        { includeDevDependencies, workspacePackageNames },
      ).map(async (dependencyName) => {
        const dependencyDir = packageDirsByName.get(dependencyName);
        return dependencyDir
          ? await buildWorkspaceClosure(dependencyDir, nextAncestors)
          : false;
      }));
      const dependencyChanged = dependencyResults.some(Boolean);

      const result = await schedulePackageBuild(async () => (
        await ensureWorkspacePackageBuilt(resolvedPackageDir, {
          monorepoRoot,
          quiet,
          env,
          force: forced.has(packageName) || dependencyChanged,
          timeoutMs,
          onPackageBuildStart,
          onPackageBuildDone,
          workspaceBuildBoundary,
          admitPriorOutputsImmediately,
          publicationMode,
        })
      ));
      if (result.built && packageName) built.push(packageName);
      if ((dependencyChanged || result.built) && packageName) changedClosures.add(packageName);
      return dependencyChanged || result.built;
    })();
    closureBuildPromises.set(resolvedPackageDir, buildPromise);
    return buildPromise;
  };

  await Promise.all((packageNames ?? []).map(async (packageName) => {
    const packageDir = packageDirsByName.get(packageName);
    if (packageDir) await buildWorkspaceClosure(packageDir);
  }));

  return built.sort((left, right) => left.localeCompare(right));
}

export async function ensureWorkspacePackagesBuiltByName(monorepoPath, packageNames, {
  quiet = false,
  env = process.env,
  force = false,
  timeoutMs = null,
  onPackageBuildStart = null,
  onPackageBuildDone = null,
  includeDevDependencies = true,
  workspaceBuildBoundary = defaultWorkspaceBuildBoundary,
  admitPriorOutputsImmediately = false,
  publicationMode = 'live',
  maxConcurrentBuilds = DEFAULT_MAX_CONCURRENT_WORKSPACE_BUILDS,
} = {}) {
  const monorepoRoot = coerceHappyMonorepoRootFromPath(monorepoPath);
  if (!monorepoRoot) return { ok: true, built: [], skipped: ['not-monorepo'] };

  const normalizedPackageNames = [...new Set(
    (packageNames ?? [])
      .map((name) => String(name ?? '').trim())
      .filter(Boolean),
  )];
  const resolvedPublicationMode = resolveWorkspaceBundlePublicationMode({ mode: publicationMode });
  const built = await ensureWorkspacePackageNamesBuilt(monorepoRoot, normalizedPackageNames, {
    quiet,
    env,
    forcePackageNames: force ? normalizedPackageNames : [],
    timeoutMs,
    onPackageBuildStart,
    onPackageBuildDone,
    includeDevDependencies,
    workspaceBuildBoundary,
    admitPriorOutputsImmediately,
    publicationMode: resolvedPublicationMode,
    maxConcurrentBuilds,
  });
  return { ok: true, built, skipped: [] };
}

export async function ensureWorkspacePackagesBuiltForComponent(componentDir, {
  quiet = false,
  env = process.env,
  workspaceBuildBoundary = defaultWorkspaceBuildBoundary,
  admitPriorOutputsImmediately = false,
  publicationMode = 'live',
  maxConcurrentBuilds = DEFAULT_MAX_CONCURRENT_WORKSPACE_BUILDS,
} = {}) {
  const monorepoRoot = coerceHappyMonorepoRootFromPath(componentDir);
  if (!monorepoRoot) return { ok: true, built: [], skipped: ['not-monorepo'] };

  const componentPackageJsonPath = join(componentDir, 'package.json');
  if (!existsSync(componentPackageJsonPath)) {
    return { ok: true, built: [], skipped: ['missing-component-package-json'] };
  }

  const componentPackageJson = await readJson(componentPackageJsonPath);
  const componentName = typeof componentPackageJson?.name === 'string'
    ? componentPackageJson.name
    : '';
  const packageDirsByName = await collectWorkspacePackageDirsByName(monorepoRoot);
  const packageNames = collectInternalWorkspaceDependencyNames(componentPackageJson, componentName, {
    workspacePackageNames: packageDirsByName.keys(),
  });
  const resolvedPublicationMode = resolveWorkspaceBundlePublicationMode({ mode: publicationMode });
  const built = await ensureWorkspacePackageNamesBuilt(monorepoRoot, packageNames, {
    quiet,
    env,
    visitedNames: [componentName].filter(Boolean),
    includeDevDependencies: true,
    packageDirsByName,
    workspaceBuildBoundary,
    admitPriorOutputsImmediately,
    publicationMode: resolvedPublicationMode,
    maxConcurrentBuilds,
  });
  return { ok: true, built, skipped: [] };
}
