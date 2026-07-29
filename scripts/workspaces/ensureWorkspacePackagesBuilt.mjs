import { existsSync } from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { buildIntoTempThenReplace } from '../../apps/stack/scripts/utils/fs/atomic_dir_swap.mjs';
import { coerceHappyMonorepoRootFromPath } from '../../apps/stack/scripts/utils/paths/paths.mjs';
import { withCliDistBuildLock } from '../../apps/stack/scripts/utils/proc/cliDistBuildLock.mjs';
import { run } from '../../apps/stack/scripts/utils/proc/proc.mjs';
import { collectWorkspacePackageJsonPaths } from '../../apps/stack/scripts/utils/proc/workspace_package_manifests.mjs';
import { resolveWorkspaceToolBinDirs } from '../../apps/stack/scripts/utils/proc/workspace_tool_bins.mjs';
import { assertNoMissingLocalImports } from './distLocalImports.mjs';
import { resolveYarnCommandInvocation } from './execYarnCommand.mjs';
import { resolveWorkspacePackageBuildLockPath } from './workspacePackageBuildLock.mjs';

const GENERATED_PLUGIN_UI_ARTIFACTS_MANIFEST_RELATIVE_PATH =
  'dist/happier-plugin-ui/ui-artifacts.json';

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
  { includeDevDependencies = true } = {},
) {
  const names = [];
  const dependencyFields = [packageJson?.dependencies, packageJson?.optionalDependencies];
  if (includeDevDependencies) dependencyFields.push(packageJson?.devDependencies);
  for (const dependencies of dependencyFields) {
    if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) continue;
    for (const name of Object.keys(dependencies)) {
      if (!name.startsWith('@happier-dev/') || name === currentPackageName) continue;
      names.push(name);
    }
  }
  return names;
}

function collectExpectedExportFileTargets(exportsField) {
  const targets = [];
  const visit = (value) => {
    if (!value) return;
    if (typeof value === 'string') {
      targets.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const nested of value) visit(nested);
      return;
    }
    if (typeof value === 'object') {
      for (const nested of Object.values(value)) visit(nested);
    }
  };
  visit(exportsField);
  return targets;
}

function collectExpectedPackageFilesFromPackageJson(packageJson) {
  const candidates = [];
  for (const key of ['main', 'module', 'types']) {
    const value = packageJson?.[key];
    if (typeof value === 'string' && value.trim()) candidates.push(value.trim());
  }
  candidates.push(...collectExpectedExportFileTargets(packageJson?.exports));
  // A declared plugin UI build is part of the package's atomic dist contract,
  // even though its generated graph is not a JavaScript export target.
  if (
    typeof packageJson?.scripts?.['build:ui'] === 'string'
    && packageJson.scripts['build:ui'].trim()
  ) {
    candidates.push(GENERATED_PLUGIN_UI_ARTIFACTS_MANIFEST_RELATIVE_PATH);
  }

  return [...new Set(candidates)].filter((path) => {
    if (typeof path !== 'string') return false;
    const normalized = path.startsWith('./') ? path.slice(2) : path;
    return normalized === 'dist' || normalized.startsWith('dist/');
  });
}

function remapDistPathToDir(path, { packageDir, distDir }) {
  const absolutePath = resolve(path);
  const realDistRoot = resolve(join(packageDir, 'dist'));
  if (absolutePath === realDistRoot) return resolve(distDir);
  if (absolutePath.startsWith(realDistRoot + sep)) {
    return join(resolve(distDir), relative(realDistRoot, absolutePath));
  }
  return absolutePath;
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

async function readOldestWorkspaceBuildOutputChangeTimeNs(outputPaths) {
  let oldest = null;
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
    oldest = oldest === null || changedAtNs < oldest ? changedAtNs : oldest;
  };

  for (const outputPath of outputPaths) await visit(outputPath);
  return complete ? oldest : null;
}

// Timestamp ordering is a reuse heuristic, not derivation proof. Artifact
// publishers that must bind outputs to current inputs use this owner's `force`
// admission instead of trusting recreated output timestamps.
async function workspaceOutputsAppearCurrent(packageDir, expectedFiles) {
  const newestInput = await readNewestWorkspaceBuildInputChangeTimeNs(packageDir);
  if (newestInput === null) return true;
  const oldestOutput = await readOldestWorkspaceBuildOutputChangeTimeNs(expectedFiles);
  return oldestOutput !== null && oldestOutput >= newestInput;
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
} = {}) {
  const expectedFiles = collectExpectedPackageFilesFromPackageJson(packageJson)
    .map((path) => join(packageDir, path));
  const missing = expectedFiles.filter((path) => !existsSync(path));
  const distDir = join(packageDir, 'dist');
  const distRoot = resolve(distDir);
  const distEntrypoints = expectedFiles
    .filter((path) => /\.(?:mjs|cjs|js)$/.test(path))
    .filter((path) => {
      const absolutePath = resolve(path);
      return absolutePath === distRoot || absolutePath.startsWith(distRoot + sep);
    });
  const label = packageJson?.name ? `${packageJson.name} dist build` : 'dist build';

  if (missing.length === 0 && distEntrypoints.length === 0) {
    return { complete: true, expectedFiles, missing, distDir, distEntrypoints, label };
  }

  if (missing.length === 0 && await workspaceOutputsAppearCurrent(packageDir, expectedFiles)) {
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
      return { complete: true, expectedFiles, missing, distDir, distEntrypoints, label };
    } catch {
      // A partial import graph is stale even when every package.json target exists.
    }
  }

  return { complete: false, expectedFiles, missing, distDir, distEntrypoints, label };
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

async function runYarn(args, { cwd, env, quiet, input = null, timeoutMs = null }) {
  const invocation = resolveYarnCommandInvocation(args, { npmExecPath: env?.npm_execpath });
  const outputMode = quiet ? 'ignore' : 'inherit';
  const stdio = input === null ? outputMode : ['pipe', outputMode, outputMode];
  await run(invocation.command, invocation.args, {
    cwd,
    env,
    stdio,
    ...(input === null ? {} : { input }),
    ...(timeoutMs === null ? {} : { timeoutMs }),
    ...(invocation.windowsVerbatimArguments
      ? { windowsVerbatimArguments: invocation.windowsVerbatimArguments }
      : {}),
  });
}

async function runWorkspacePackageBuild(packageDir, { env, quiet, timeoutMs }) {
  try {
    await runYarn(['--version'], {
      cwd: packageDir,
      env,
      input: 'y\n',
      quiet,
    });
  } catch {
    throw new Error(
      `[local] yarn is required for component at ${packageDir}. Install it via Corepack: \`corepack enable\``,
    );
  }
  await runYarn(['-s', 'build'], { cwd: packageDir, env, quiet, timeoutMs });
}

const defaultWorkspaceBuildBoundary = {
  prepareEnv: async (packageDir, env) => prepareWorkspaceBuildEnv(packageDir, env),
  runPackageBuild: runWorkspacePackageBuild,
};

async function ensureWorkspacePackageBuiltUnderLock({
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
}) {
  const packageJson = await readJson(packageJsonPath);
  const state = await inspectWorkspacePackageOutput(packageDir, packageJson, {
    env,
    retryImports: true,
  });
  const {
    expectedFiles,
    missing: missingBefore,
    distDir,
    distEntrypoints,
    label,
  } = state;
  const reportImportRetry = createWorkspaceBuildWaitNotifier({ env, label, kind: 'imports' });
  if (expectedFiles.length === 0) return { built: false, reason: 'no-expected-files' };
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

  await onPackageBuildStart?.({
    packageDir,
    packageName: String(packageJson?.name ?? '').trim(),
  });
  await buildIntoTempThenReplace(distDir, async (tmpDistDir) => {
    const buildEnv = {
      ...env,
      HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: heldLockValue,
      HAPPIER_WORKSPACE_DIST_OUTPUT_DIR: tmpDistDir,
    };
    await workspaceBuildBoundary.runPackageBuild(packageDir, {
      env: buildEnv,
      quiet,
      timeoutMs,
    });

    const stagedExpectedFiles = expectedFiles.map((path) => remapDistPathToDir(path, {
      packageDir,
      distDir: tmpDistDir,
    }));
    const missingStaged = stagedExpectedFiles.filter((path) => !existsSync(path));
    if (missingStaged.length > 0) {
      throw new Error(
        `[local] build completed but expected staged outputs are still missing for ${packageJson?.name ?? packageDir}:\n`
        + missingStaged.map((path) => `- ${path}`).join('\n')
        + '\nFix: ensure the package build honors HAPPIER_WORKSPACE_DIST_OUTPUT_DIR or generates the files referenced by package.json exports/main/types.',
      );
    }

    for (const entryPath of distEntrypoints) {
      await assertNoMissingLocalImportsWithRetry({
        distDir: tmpDistDir,
        entryPath: remapDistPathToDir(entryPath, { packageDir, distDir: tmpDistDir }),
        label,
        env,
        onRetry: reportImportRetry,
      });
    }
  });
  await onPackageBuildDone?.({
    packageDir,
    packageName: String(packageJson?.name ?? '').trim(),
  });

  return { built: true, reason: 'rebuilt' };
}

async function ensureWorkspacePackageBuilt(packageDir, {
  quiet,
  env: envIn,
  force,
  timeoutMs,
  onPackageBuildStart,
  onPackageBuildDone,
  workspaceBuildBoundary,
}) {
  const packageJsonPath = join(packageDir, 'package.json');
  if (!existsSync(packageJsonPath)) return { built: false, reason: 'missing-package-json' };

  const packageJson = await readJson(packageJsonPath);
  const initial = await inspectWorkspacePackageOutput(packageDir, packageJson, { env: envIn });
  if (initial.expectedFiles.length === 0) return { built: false, reason: 'no-expected-files' };
  if (!force && initial.complete) return { built: false, reason: 'already-built' };

  const env = await workspaceBuildBoundary.prepareEnv(packageDir, envIn);
  const lockPath = resolveWorkspacePackageBuildLockPath(packageDir, packageJson);
  const reportLockWait = createWorkspaceBuildWaitNotifier({
    env,
    label: initial.label,
    kind: 'lock',
  });
  return await withCliDistBuildLock(
    ({ waited, heldLockValue }) => ensureWorkspacePackageBuiltUnderLock({
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
    }),
    { lockPath, env, onWait: reportLockWait },
  );
}

async function ensureWorkspacePackageNamesBuilt(monorepoRoot, packageNames, {
  quiet,
  env,
  forcePackageNames = [],
  timeoutMs,
  beforePackageBuild,
  onPackageBuildStart,
  onPackageBuildDone,
  visitedNames = [],
  includeDevDependencies,
  workspaceBuildBoundary,
}) {
  const built = [];
  const visited = new Set(visitedNames);
  const forced = new Set(forcePackageNames);
  const packageDirsByName = await collectWorkspacePackageDirsByName(monorepoRoot);

  const buildWorkspaceClosure = async (packageDir) => {
    const packageJsonPath = join(packageDir, 'package.json');
    if (!existsSync(packageJsonPath)) return;

    const packageJson = await readJson(packageJsonPath);
    const packageName = typeof packageJson?.name === 'string' ? packageJson.name : '';
    if (packageName && visited.has(packageName)) return;
    if (packageName) visited.add(packageName);

    for (const dependencyName of collectInternalWorkspaceDependencyNames(
      packageJson,
      packageName,
      { includeDevDependencies },
    )) {
      const dependencyDir = packageDirsByName.get(dependencyName);
      if (dependencyDir) await buildWorkspaceClosure(dependencyDir);
    }

    await beforePackageBuild?.({ packageDir, packageName });
    const result = await ensureWorkspacePackageBuilt(packageDir, {
      quiet,
      env,
      force: forced.has(packageName),
      timeoutMs,
      onPackageBuildStart,
      onPackageBuildDone,
      workspaceBuildBoundary,
    });
    if (result.built && packageName) built.push(packageName);
  };

  for (const packageName of packageNames ?? []) {
    const packageDir = packageDirsByName.get(packageName);
    if (packageDir) await buildWorkspaceClosure(packageDir);
  }

  return built;
}

export async function ensureWorkspacePackagesBuiltByName(monorepoPath, packageNames, {
  quiet = false,
  env = process.env,
  force = false,
  timeoutMs = null,
  beforePackageBuild = null,
  onPackageBuildStart = null,
  onPackageBuildDone = null,
  includeDevDependencies = true,
  workspaceBuildBoundary = defaultWorkspaceBuildBoundary,
} = {}) {
  const monorepoRoot = coerceHappyMonorepoRootFromPath(monorepoPath);
  if (!monorepoRoot) return { ok: true, built: [], skipped: ['not-monorepo'] };

  const normalizedPackageNames = [...new Set(
    (packageNames ?? [])
      .map((name) => String(name ?? '').trim())
      .filter(Boolean),
  )];
  const built = await ensureWorkspacePackageNamesBuilt(monorepoRoot, normalizedPackageNames, {
    quiet,
    env,
    forcePackageNames: force ? normalizedPackageNames : [],
    timeoutMs,
    beforePackageBuild,
    onPackageBuildStart,
    onPackageBuildDone,
    includeDevDependencies,
    workspaceBuildBoundary,
  });
  return { ok: true, built, skipped: [] };
}

export async function ensureWorkspacePackagesBuiltForComponent(componentDir, {
  quiet = false,
  env = process.env,
  workspaceBuildBoundary = defaultWorkspaceBuildBoundary,
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
  const packageNames = collectInternalWorkspaceDependencyNames(componentPackageJson, componentName);
  const built = await ensureWorkspacePackageNamesBuilt(monorepoRoot, packageNames, {
    quiet,
    env,
    visitedNames: [componentName].filter(Boolean),
    includeDevDependencies: true,
    workspaceBuildBoundary,
  });
  return { ok: true, built, skipped: [] };
}
