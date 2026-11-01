import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';

import { pathExists } from '../fs/fs.mjs';
import { appendBoundedTail, formatFailureDiagnostic, run, spawnProc } from './proc.mjs';
import { resolveCommandPath } from './commands.mjs';
import { coerceHappyMonorepoRootFromPath, getDefaultAutostartPaths, getHappyStacksHomeDir, resolveExplicitStackEnvFilePath } from '../paths/paths.mjs';
import { resolveInstalledPath, resolveInstalledCliRoot } from '../paths/runtime.mjs';
import { expandHome } from '../paths/canonical_home.mjs';
import { applyStackInfraProcessKind } from './stack_process_kind.mjs';
export { applyStackInfraProcessKind };
import { resolveCliDistBuildLockPath, withCliDistBuildLock } from './cliDistBuildLock.mjs';
import { inspectDependencyRefresh, isDependencyRefreshDisabled, resolveDependencyInstallRoot, resolveLockedInstallEnv, withDependencyConsumption, withDependencyRefresh, withDependencyRefreshLock } from './dependency_refresh.mjs';
export { resolveDependencyInstallRoot } from './dependency_refresh.mjs';
import { ensureUiPostinstallOutputs as prepareUiPostinstallOutputs, inspectUiPostinstallOutputs } from './ui_postinstall.mjs';
import { createWorkspaceBuildWaitNotifier } from './workspaceBuildWaitNotifier.mjs';
import { resolveWorkspaceToolBinDirs } from './workspace_tool_bins.mjs';
import { resolvePackageManagerCachePaths } from './package_manager_cache.mjs';
import { probeCliDistRuntimeImport, readCliDistIntegrity } from '../cli/cliDistIntegrity.mjs';
export { isCliDistBuildLockActive } from './cliDistBuildLock.mjs';

// These are source-workspace build tools, not part of the installed Stack runtime. Keep their
// repository imports lazy so an installed Stack can load daemon lifecycle code from its bundled
// dependencies without requiring a checkout beside the installation.
function loadSourceWorkspaceModule(relativePath) {
  return import(new URL(`../../../../../scripts/workspaces/${relativePath}`, import.meta.url).href);
}

export async function prepareWorkspaceComponentStartup(options) {
  const owner = await loadSourceWorkspaceModule('ensureWorkspacePackagesBuilt.mjs');
  return await owner.prepareWorkspaceComponentStartup(options);
}

export async function hasUsableWorkspaceLastGreen(componentDir, options) {
  const owner = await loadSourceWorkspaceModule('ensureWorkspacePackagesBuilt.mjs');
  return await owner.hasUsableWorkspaceLastGreen(componentDir, options);
}

export async function readWorkspaceComponentDependencyGraph(componentDir, options) {
  const owner = await loadSourceWorkspaceModule('ensureWorkspacePackagesBuilt.mjs');
  return await owner.readWorkspaceComponentDependencyGraph(componentDir, options);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf-8'));
}

/**
 * Service mode is the explicit `HAPPIER_STACK_SERVICE_MODE` the service installer writes
 * (`service.mjs`), the same fact every other stack consumer reads. A parent pid of 1 is not
 * evidence: a dev watcher whose launching parent exited is re-parented to init too.
 */
function isServiceMode(env = process.env) {
  const raw = String(env?.HAPPIER_STACK_SERVICE_MODE ?? '').trim();
  return raw !== '' && raw !== '0';
}

function resolveWorkspaceDistImportValidationRetryAttempts(env = process.env) {
  const raw = Number.parseInt(String(env.HAPPIER_WORKSPACE_DIST_IMPORT_VALIDATION_RETRY_ATTEMPTS ?? ''), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 24;
}

function resolveWorkspaceDistImportValidationRetryDelayMs(env = process.env) {
  const raw = Number.parseInt(String(env.HAPPIER_WORKSPACE_DIST_IMPORT_VALIDATION_RETRY_DELAY_MS ?? ''), 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 250;
}

async function waitForWorkspaceDistImportValidationRetry(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function assertNoMissingLocalImportsWithRetry({
  distDir,
  entryPath,
  label = 'dist build',
  env = process.env,
  onRetry = null,
}) {
  const attempts = resolveWorkspaceDistImportValidationRetryAttempts(env);
  const delayMs = resolveWorkspaceDistImportValidationRetryDelayMs(env);
  let lastError = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const { assertNoMissingLocalImports } = await loadSourceWorkspaceModule('distLocalImports.mjs');
      await assertNoMissingLocalImports({ distDir, entryPath, label });
      return;
    } catch (error) {
      lastError = error;
      if (typeof onRetry === 'function') {
        try {
          onRetry({
            attempt,
            attempts,
            delayMs,
            entryPath,
            label,
            waitedMs: attempt * delayMs,
            error,
          });
        } catch {}
      }
      if (attempt >= attempts - 1) {
        throw error;
      }
      await waitForWorkspaceDistImportValidationRetry(delayMs);
    }
  }

  throw lastError ?? new Error(`[local] ${label} import validation failed for ${entryPath}`);
}

async function readUsableCliDistState(distEntrypoint) {
  const integrity = readCliDistIntegrity(distEntrypoint);
  if (!integrity.ok || !integrity.manifestPath) return null;
  try {
    const entryStat = await stat(distEntrypoint, { bigint: true });
    if (!entryStat.isFile() || entryStat.size === 0n) return null;
    const { assertNoMissingLocalImports } = await loadSourceWorkspaceModule('distLocalImports.mjs');
    await assertNoMissingLocalImports({ distDir: dirname(distEntrypoint), entryPath: distEntrypoint });
    const inputFingerprint = String(integrity.manifest?.inputFingerprint ?? '').trim().toLowerCase();
    return {
      fingerprint: integrity.fingerprint,
      inputFingerprint: /^[a-f0-9]{64}$/.test(inputFingerprint) ? inputFingerprint : null,
    };
  } catch {
    return null;
  }
}

export async function readUsableCliDistFreshness(distEntrypoint) {
  return (await readUsableCliDistState(distEntrypoint))?.fingerprint ?? null;
}

export async function isCliDistFreshForInputs(distEntrypoint, inputFreshness) {
  const distState = await readUsableCliDistState(distEntrypoint);
  if (distState === null) return false;
  if (inputFreshness === null) return false;
  const inputFingerprint = String(inputFreshness.fingerprint ?? '').trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(inputFingerprint)
    && distState.inputFingerprint === inputFingerprint;
}

const packageManagerSearchEnvByPreparedEnv = new WeakMap();

async function getComponentPm(dir, env = process.env) {
  const happyMonorepoRoot = await (async () => {
    try {
      return coerceHappyMonorepoRootFromPath(dir);
    } catch {
      return null;
    }
  })();
  void happyMonorepoRoot;

  // Preserve the caller's package manager before Stack adds the Node runtime to PATH.
  const searchEnv = packageManagerSearchEnvByPreparedEnv.get(env) ?? env;
  const { resolvePnpmInvocation } = await loadSourceWorkspaceModule('execPnpmCommand.mjs');
  const inherited = resolvePnpmInvocation(searchEnv.npm_execpath, {
  });
  if (String(searchEnv.npm_execpath ?? '').trim() && !/(^|[\\/])npm-cli\.js$/i.test(searchEnv.npm_execpath)) {
    return {
      name: 'pnpm',
      cmd: inherited.command,
      prefixArgs: inherited.args,
    };
  }

  const binaryMode = String(env.HAPPIER_STACK_BINARY_MODE ?? '').trim() === '1'
    || String(env.HAPPIER_STACK_INSTALL_SOURCE ?? '').trim() === 'binary';
  // Resolve the caller's PATH before consulting directories added for child runtimes.
  const resolveFromPath = async (candidateEnv) => {
    const pnpmPath = await resolveCommandPath('pnpm', { cwd: dir, env: candidateEnv });
    if (pnpmPath) return { name: 'pnpm', cmd: pnpmPath, prefixArgs: [], directCommand: true };
    const npmPath = binaryMode
      ? await resolveCommandPath('npm', { cwd: dir, env: candidateEnv })
      : '';
    if (npmPath) return { name: 'npm', cmd: npmPath, prefixArgs: [], directCommand: true };
    return null;
  };
  const resolvedPm = await resolveFromPath(searchEnv)
    ?? (searchEnv === env ? null : await resolveFromPath(env));
  if (resolvedPm) {
    if (resolvedPm.directCommand) {
      const preferredNodeBinDir = await resolvePreferredNodeBinDir(dir, env);
      prioritizePackageManagerRuntimePath(env, {
        commandPath: resolvedPm.cmd,
        nodeBinDir: preferredNodeBinDir ?? dirname(process.execPath),
      });
    }
    return {
      name: resolvedPm.name,
      cmd: resolvedPm.cmd,
      prefixArgs: resolvedPm.prefixArgs,
    };
  }

  throw new Error(`[local] pnpm is required for component at ${dir}. Run the repository's scripts/ci/setup-pnpm.mjs setup command.`);
}

function resolvePmArgs(pm, args) {
  return [...(pm.prefixArgs ?? []), ...args];
}

function runPm(pm, args, options) {
  return run(pm.cmd, resolvePmArgs(pm, args), options);
}

function spawnPm(label, pm, args, env, options) {
  return spawnProc(label, pm.cmd, resolvePmArgs(pm, args), env, options);
}

function formatPmCommand(pm, args) {
  return [pm.cmd, ...resolvePmArgs(pm, args)]
    .map((arg) => {
      const value = String(arg);
      return /^[a-zA-Z0-9_./:@%+=,-]+$/.test(value) ? value : JSON.stringify(value);
    })
    .join(' ');
}

export function createCommandDependencyAdmission({
  ensureDepsInstalledImpl = ensureDepsInstalled,
  ensureComponentPrerequisitesImpl = ensureComponentPrerequisites,
} = {}) {
  const admittedRoots = new Set();
  return async (dir, label, options) => {
    const installRoot = resolveDependencyInstallRoot(dir);
    const key = await realpath(installRoot).catch(() => resolve(installRoot));
    if (admittedRoots.has(key)) {
      await ensureComponentPrerequisitesImpl(dir, label, options);
      return { admitted: false, installRoot: key };
    }
    await ensureDepsInstalledImpl(dir, label, options);
    admittedRoots.add(key);
    return { admitted: true, installRoot: key };
  };
}

function classifyScriptEntrypointSource(text) {
  const prefix = String(text ?? '').slice(0, 64);
  if (/^#!\/bin\/sh\b/.test(prefix) || /^@echo off\b/i.test(prefix)) {
    return 'shell-wrapper';
  }
  return 'node-module';
}

async function readScriptEntrypointKind(path) {
  if (!(await pathExists(path))) {
    return 'missing';
  }
  const source = await readFile(path, 'utf-8');
  return classifyScriptEntrypointSource(source);
}

function buildDependencyInstallArgs(packageManagerName, { force = false, preserveLockfile = false } = {}) {
  const args = ['install'];
  if (force) {
    args.push('--force');
  }
  if (packageManagerName === 'pnpm') {
    args.push('--prod=false');
    if (preserveLockfile) args.push('--frozen-lockfile');
  }
  return args;
}

async function repairCorruptedCliPkgrollInstallIfNeeded(cliDir, { quiet = false, env }) {
  const installDir = resolveDependencyInstallRoot(cliDir);
  const pkgrollCliPath = join(installDir, 'node_modules', 'pkgroll', 'dist', 'cli.mjs');
  if ((await readScriptEntrypointKind(pkgrollCliPath)) !== 'shell-wrapper') {
    return false;
  }

  const pm = await getComponentPm(installDir, env);
  const stdio = quiet ? 'ignore' : 'inherit';
  const repairArgs = buildDependencyInstallArgs(pm.name, {
    force: true,
    preserveLockfile: String(env?.HAPPIER_DEV_TARGET_EXECUTION ?? '').trim() === '1',
  });

  if (pm.name === 'pnpm') {
    await ensurePnpmReady({ dir: installDir, env, quiet, pm });
  }

  if (!quiet) {
    // eslint-disable-next-line no-console
    console.log(`[local] repairing corrupted pkgroll install at ${pkgrollCliPath}...`);
  }
  await withDependencyRefresh({ installDir, componentDir: cliDir, env, force: true }, async ({ env: installEnv }) => {
    // A concurrent repair may have finished while this caller waited.
    if ((await readScriptEntrypointKind(pkgrollCliPath)) !== 'shell-wrapper') return;
    await runPm(pm, repairArgs, { cwd: installDir, stdio, env: installEnv, captureFailureDiagnostic: true });
    const monorepoRoot = coerceHappyMonorepoRootFromPath(cliDir);
    await ensureUiPostinstallOutputs(monorepoRoot ? join(monorepoRoot, 'apps', 'ui') : cliDir,
      installDir, { quiet, env, pm, force: true });
  });

  if ((await readScriptEntrypointKind(pkgrollCliPath)) !== 'node-module') {
    throw new Error(
      `[local] forced dependency refresh did not repair pkgroll at ${pkgrollCliPath}.\n` +
        `Fix: run the install manually and inspect the package manager output:\n` +
        `  cd "${installDir}" && ${formatPmCommand(pm, repairArgs)}`
    );
  }

  return true;
}

function readEnvPath(env) {
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === 'path');
  return key ? String(env[key] ?? '') : '';
}

function writeEnvPath(env, value) {
  for (const key of Object.keys(env)) {
    if (key !== 'PATH' && key.toLowerCase() === 'path') {
      delete env[key];
    }
  }
  env.PATH = value;
}

function normalizeEnvPath(env) {
  writeEnvPath(env, readEnvPath(env));
  return env;
}

function prependPathEntry(env, entry) {
  const candidate = String(entry ?? '').trim();
  if (!candidate) return env;
  const delimiter = process.platform === 'win32' ? ';' : ':';
  const current = readEnvPath(env)
    .split(delimiter)
    .map((value) => String(value ?? '').trim())
    .filter(Boolean);
  writeEnvPath(env, [candidate, ...current.filter((value) => value !== candidate)].join(delimiter));
  return env;
}

function appendPathEntry(env, entry) {
  const candidate = String(entry ?? '').trim();
  if (!candidate) return env;
  const delimiter = process.platform === 'win32' ? ';' : ':';
  const current = readEnvPath(env)
    .split(delimiter)
    .map((value) => String(value ?? '').trim())
    .filter(Boolean);
  writeEnvPath(env, [...current.filter((value) => value !== candidate), candidate].join(delimiter));
  return env;
}

function prioritizePackageManagerRuntimePath(env, { commandPath, nodeBinDir }) {
  const commandDir = dirname(String(commandPath ?? '').trim());
  const nodeDir = String(nodeBinDir ?? '').trim();
  const delimiter = process.platform === 'win32' ? ';' : ':';
  const current = readEnvPath(env)
    .split(delimiter)
    .map((value) => String(value ?? '').trim())
    .filter(Boolean);

  const prefix = [commandDir, nodeDir].filter(Boolean);
  const prefixSet = new Set(prefix);
  writeEnvPath(env, [...prefix, ...current.filter((value) => !prefixSet.has(value))].join(delimiter));
  return env;
}

function normalizeNvmNodeVersion(raw) {
  const version = String(raw ?? '').trim();
  if (!version) return null;
  return version.startsWith('v') ? version : `v${version}`;
}

async function resolvePreferredNodeBinDir(dir, env = process.env) {
  const candidateDirs = [];
  const monorepoRoot = coerceHappyMonorepoRootFromPath(dir);
  if (monorepoRoot) candidateDirs.push(monorepoRoot);
  candidateDirs.push(dir);

  const nvmDir = String(env.NVM_DIR ?? '').trim() || join(homedir(), '.nvm');
  const nodeBinaryName = process.platform === 'win32' ? 'node.exe' : 'node';
  const seenDirs = new Set();

  for (const candidateDir of candidateDirs) {
    const resolvedDir = resolve(candidateDir);
    if (seenDirs.has(resolvedDir)) continue;
    seenDirs.add(resolvedDir);

    let requestedVersion = null;
    try {
      requestedVersion = normalizeNvmNodeVersion(await readFile(join(resolvedDir, '.nvmrc'), 'utf-8'));
    } catch {
      requestedVersion = null;
    }
    if (!requestedVersion) continue;

    const binDir = join(nvmDir, 'versions', 'node', requestedVersion, 'bin');
    if (existsSync(join(binDir, nodeBinaryName))) {
      return binDir;
    }
  }

  return null;
}

async function preparePmEnv(dir, envIn = process.env) {
  const env = await applyStackCacheEnv(envIn);
  normalizeEnvPath(env);
  packageManagerSearchEnvByPreparedEnv.set(env, { ...env });
  if (typeof env.REDISMS_DISABLE_POSTINSTALL === 'undefined') {
    // redis-memory-server only uses postinstall to prefetch binaries; skipping it avoids making
    // stack-managed dependency refreshes depend on local Redis build prerequisites.
    env.REDISMS_DISABLE_POSTINSTALL = '1';
  }
  appendPathEntry(env, dirname(process.execPath));
  const preferredNodeBinDir = await resolvePreferredNodeBinDir(dir, env);
  if (preferredNodeBinDir) {
    prependPathEntry(env, preferredNodeBinDir);
  }
  // pnpm owns installed `node_modules/.bin` entries. Replacing those symlinks while a
  // long-lived crawler (notably Metro) is reading them can leave the crawler with stale
  // symlink metadata and make `readlink` fail with EINVAL. Publish Stack's deterministic
  // command shims in the checkout-local ignored workspace instead.
  const workspaceToolBinDirs = await resolveWorkspaceToolBinDirs(dir);
  for (const workspaceToolBinDir of workspaceToolBinDirs.reverse()) {
    prependPathEntry(env, workspaceToolBinDir);
  }
  const componentTsconfigPath = join(dir, 'tsconfig.json');
  if (existsSync(componentTsconfigPath)) {
    env.TSX_TSCONFIG_PATH = componentTsconfigPath;
  } else {
    delete env.TSX_TSCONFIG_PATH;
  }
  return env;
}

const _pnpmReadyKeys = new Set();

async function readPackageJsonIfExists(pkgJsonPath) {
  if (!(await pathExists(pkgJsonPath))) {
    return null;
  }
  return await readJson(pkgJsonPath);
}

export async function ensureServerGeneratedProviderOutputs(componentDir, installDir, { quiet = false, env: envIn, pm: pmIn, checkOnly = false, signal } = {}) {
  const componentPkgJsonPath = join(componentDir, 'package.json');
  const componentPkg = await readPackageJsonIfExists(componentPkgJsonPath);
  if (componentPkg?.name !== '@happier-dev/server') {
    return;
  }
  if (typeof componentPkg?.scripts?.['generate:providers'] !== 'string') {
    return;
  }

  const preparedEnv = pmIn
    ? (envIn ?? process.env)
    : await preparePmEnv(installDir, envIn ?? process.env);
  // A worker's installed tree serves every server provider, even when this
  // particular caller is preparing a single-provider runtime.
  const env = { ...preparedEnv, HAPPIER_BUILD_DB_PROVIDERS: 'all' };
  const pm = pmIn ?? await getComponentPm(installDir, env);
  const invoke = async (check, childEnv) => {
    const args = pm.name === 'pnpm'
      ? ['--filter', '@happier-dev/server', 'run', '--silent', 'generate:providers']
      : ['run', '-s', 'generate:providers'];
    await runPm(pm, [...args, ...(check ? ['--check'] : [])], {
      cwd: pm.name === 'pnpm' ? installDir : componentDir,
      stdio: check || quiet ? 'ignore' : 'inherit', env: childEnv, signal,
    });
  };
  // The server generator owns every freshness decision, including its source
  // stamps and patched private runtime copies. Healthy checks remain readers.
  try {
    await withDependencyConsumption({ installDir, env, signal }, readEnv => invoke(true, readEnv));
    return;
  } catch (error) {
    signal?.throwIfAborted();
    if (checkOnly) throw error;
  }
  await withDependencyRefreshLock({ installDir, env, signal }, async ({ lockPath, owner }) => {
    const writerEnv = resolveLockedInstallEnv(env, { lockPath, owner });
    try { await invoke(true, writerEnv); return; } catch { signal?.throwIfAborted(); }
    if (!quiet) console.log('[local] regenerating stale happier-server Prisma provider outputs...');
    // Generation replaces client files, not dependency packages. Loaded servers
    // keep their client; no long-lived Stack retirement is needed for this write.
    await invoke(false, writerEnv);
  });
}

export async function ensureUiPostinstallOutputs(componentDir, installDir, { quiet = false, env: envIn, pm: pmIn, force = false } = {}) {
  let env = envIn ?? process.env;
  let pm = pmIn;
  const prepare = async () => {
    if (pm) return;
    env = await preparePmEnv(installDir, env);
    pm = await getComponentPm(installDir, env);
  };
  const stdio = quiet ? 'ignore' : 'inherit';
  await prepareUiPostinstallOutputs(componentDir, installDir, {
    quiet, force, env,
    runPostinstall: async (postinstallEnv) => {
      await prepare();
      if (pm.name === 'pnpm') {
        await ensurePnpmReady({ dir: installDir, env, quiet, pm });
        await runPm(pm, ['--filter', '@happier-dev/app', 'run', '--silent', 'postinstall:real'], { cwd: installDir, stdio, env: postinstallEnv });
      } else {
        await runPm(pm, ['run', '-s', 'postinstall:real'], { cwd: componentDir, stdio, env: postinstallEnv });
      }
    },
    restoreDependencies: async () => {
      await prepare();
      const repairArgs = buildDependencyInstallArgs(pm.name, {
        force: true,
        preserveLockfile: String(env?.HAPPIER_DEV_TARGET_EXECUTION ?? '').trim() === '1',
      });
      repairArgs.push('--ignore-scripts');
      await runPm(pm, repairArgs, { cwd: installDir, stdio, env, captureFailureDiagnostic: true });
    },
  });
}

async function ensureComponentPrerequisites(componentDir, _label, { quiet = false, env = process.env, pm } = {}) {
  const installDir = resolveDependencyInstallRoot(componentDir);
  await ensureServerGeneratedProviderOutputs(componentDir, installDir, { quiet, env, pm });
  await ensureUiPostinstallOutputs(componentDir, installDir, { quiet, env, pm });
}

async function ensurePnpmReady({ dir, env, quiet = false, pm }) {
  const e = env && typeof env === 'object' ? env : process.env;
  // In stack mode we isolate HOME/cache; key by effective HOME+XDG cache so we only do this once.
  const key = [
    resolve(dir),
    String(e.HOME ?? ''),
    String(e.XDG_CACHE_HOME ?? ''),
    pm.cmd,
    ...(pm.prefixArgs ?? []),
  ].join('|');
  if (_pnpmReadyKeys.has(key)) return;

  const stdio = quiet ? 'ignore' : ['ignore', 'ignore', 'inherit'];
  await runPm(pm, ['--version'], { cwd: dir, env: e, stdio });
  _pnpmReadyKeys.add(key);
}

export async function requireDir(label, dir) {
  if (await pathExists(dir)) {
    return;
  }
  throw new Error(
    `[local] missing ${label} at ${dir}\n` +
      `Run: hstack setup-from-source (or hstack bootstrap) to clone the Happier monorepo into your workspace.`
  );
}

function resolveStackCacheBaseDirFromEnv(env) {
  const explicit = (env.HAPPIER_STACK_PM_CACHE_BASE_DIR ?? '').toString().trim();
  if (explicit) {
    try {
      return resolve(expandHome(explicit));
    } catch {
      return null;
    }
  }
  const envFile = (env.HAPPIER_STACK_ENV_FILE ?? '').toString().trim();
  if (!envFile) return null;
  try {
    return join(dirname(envFile), 'cache');
  } catch {
    return null;
  }
}

export async function applyStackCacheEnv(baseEnv) {
  const env = { ...(baseEnv && typeof baseEnv === 'object' ? baseEnv : process.env) };
  // IMPORTANT:
  // Stack setup/bootstrap frequently runs `pnpm install` inside the Happier monorepo.
  // Many workspace lifecycle scripts depend on devDependencies (e.g. TypeScript for `tsc`).
  //
  // If a user (or CI) has NODE_ENV=production / *production* npm/pnpm flags set globally,
  // pnpm can skip devDependencies and the install fails in confusing ways.
  //
  // Default: scrub production-mode flags for stack-invoked package-manager commands.
  // Opt-out via: HAPPIER_STACK_PM_ALLOW_PRODUCTION=1
  const allowProduction = String(env.HAPPIER_STACK_PM_ALLOW_PRODUCTION ?? '').trim() === '1';
  const isTruthy = (v) => {
    const s = String(v ?? '').trim().toLowerCase();
    return s === '1' || s === 'true' || s === 'yes' || s === 'on';
  };
  const wantsProduction =
    String(env.NODE_ENV ?? '').trim().toLowerCase() === 'production'
    || isTruthy(env.pnpm_config_production)
    || isTruthy(env.npm_config_production)
    || isTruthy(env.NPM_CONFIG_PRODUCTION);
  if (!allowProduction && wantsProduction) {
    env.NODE_ENV = 'development';
    env.pnpm_config_production = 'false';
    env.npm_config_production = 'false';
    env.NPM_CONFIG_PRODUCTION = 'false';
  }

  const envFile = (env.HAPPIER_STACK_ENV_FILE ?? '').toString().trim();
  const stackCacheBase = resolveStackCacheBaseDirFromEnv(env);
  if (!stackCacheBase) return env;

  // Prisma engines currently default to ~/.cache/prisma (via os.homedir()).
  // In stack mode, isolate HOME for package-manager driven commands so Prisma/pnpm/NPM don't
  // depend on global home caches (and so sandboxed runs can succeed).
  const isolateHomeRaw = (env.HAPPIER_STACK_PM_ISOLATE_HOME ?? '').toString().trim();
  const isolateHome = isolateHomeRaw ? isolateHomeRaw !== '0' : true;
  if (isolateHome) {
    const stackHome = envFile ? join(dirname(envFile), 'home') : join(stackCacheBase, 'home');
    if (stackHome) {
      env.HOME = stackHome;
      env.USERPROFILE = stackHome;
      try {
        await mkdir(stackHome, { recursive: true });
      } catch {
        // best-effort
      }
    }
  }

  // Keep the pnpm store/cache and npm's provisioning cache stack-owned.
  for (const [key, path] of Object.entries(resolvePackageManagerCachePaths(stackCacheBase))) {
    if (!(env[key] ?? '').toString().trim()) env[key] = path;
  }
  try {
    await mkdir(env.XDG_CACHE_HOME, { recursive: true });
    await mkdir(env.pnpm_config_store_dir, { recursive: true });
    await mkdir(env.pnpm_config_cache_dir, { recursive: true });
    await mkdir(env.npm_config_cache, { recursive: true });
  } catch {
    // best-effort
  }

  return env;
}

export async function ensureDepsInstalled(dir, label, options = {}) {
  try {
    return await ensureComponentDependenciesInstalled(dir, label, options);
  } catch (error) {
    const env = options.env ?? process.env;
    if (String(env.HAPPIER_STACK_DEV_AUTO_REFRESH_DEPS ?? '').trim() !== '1') throw error;
    const callerEnvFile = resolveExplicitStackEnvFilePath(env);
    const foreignPreparation = error?.code === 'HAPPIER_DEPENDENCY_STACK_START_IN_PROGRESS'
      && typeof error.pendingStackBaseDir === 'string'
      && callerEnvFile
      && resolve(dirname(callerEnvFile)) !== resolve(error.pendingStackBaseDir)
      && await pathExists(join(resolveDependencyInstallRoot(dir), 'node_modules'));
    if (error?.code !== 'HAPPIER_DEPENDENCY_METRO_RESTART_REQUIRED' && !foreignPreparation) throw error;
    // Only defer mutation: component preflight still verifies installed bytes.
    // Cold trees and the caller's own source preparation must remain fail-closed.
    console.warn(`[local] ${label} dependency refresh is temporarily blocked; continuing with installed bytes. Will retry on the next dependency input change or startup.\n${error.message}`);
    return { admitted: false, required: true, reason: error.code };
  }
}

async function ensureComponentDependenciesInstalled(
  dir,
  label,
  {
    quiet = false,
    env: envIn = process.env,
    refreshExisting = true,
    waitForPendingStart = false,
    prepareComponentOutputs = true,
    onDependenciesReady = null,
  } = {},
) {
  if (onDependenciesReady != null && typeof onDependenciesReady !== 'function') {
    throw new TypeError('ensureDepsInstalled requires onDependenciesReady to be a function when provided');
  }
  const componentDir = dir;
  const componentPkgJson = join(componentDir, 'package.json');
  if (!(await pathExists(componentPkgJson))) {
    return;
  }

  const installDir = resolveDependencyInstallRoot(componentDir);
  const nodeModules = join(installDir, 'node_modules');
  const stdio = quiet ? 'ignore' : 'inherit';
  // Stack explicitly prepares component-owned lifecycle outputs. UI postinstall
  // is run explicitly below: pnpm may skip lifecycle scripts after a scriptless
  // bootstrap, and its outputs must precede freshness publication. Server
  // provider generation is already owned explicitly by ensureComponentPrerequisites;
  // its postinstall also runs build:shared and would duplicate the source-dev/package
  // publication owners.
  const env = resolveLockedInstallEnv(await preparePmEnv(installDir, envIn));
  const pm = await getComponentPm(installDir, env);
  if (onDependenciesReady && pm.name !== 'pnpm') {
    throw new Error(`[local] ${label} dependency-ready actions require the canonical pnpm dependency refresh owner`);
  }
  const ensureCanonicalPnpmReady = async () => {
    if (pm.name === 'pnpm') {
      await ensurePnpmReady({ dir: installDir, env, quiet, pm });
    }
  };
  const monorepoRoot = coerceHappyMonorepoRootFromPath(componentDir);
  const sharedUiDir = monorepoRoot && resolve(monorepoRoot) === resolve(installDir)
    ? join(monorepoRoot, 'apps', 'ui') : null;
  const needsSharedUiRepair = sharedUiDir && (
    (await inspectDependencyRefresh({ installDir, componentDir, env })).required
    || (await inspectUiPostinstallOutputs(sharedUiDir, installDir, { env })).length > 0
  );
  const guardedDependencyReadyAction = onDependenciesReady || prepareComponentOutputs || needsSharedUiRepair
    ? async ({ env: readyEnv = env } = {}) => {
        await ensureCanonicalPnpmReady();
        // CLI, server and Stack callers share UI's installed dependencies too.
        // Inspection is read-only when healthy; repairs remain under admission.
        if (sharedUiDir) await ensureUiPostinstallOutputs(sharedUiDir, installDir, { quiet, env, pm });
        if (onDependenciesReady) await onDependenciesReady({ env: readyEnv });
        if (prepareComponentOutputs) {
          await ensureComponentPrerequisites(componentDir, label, { quiet, env: readyEnv, pm });
        }
      }
    : null;
  // Startup is not a dependency mutation merely because it also prepares
  // first-party component outputs. A current, fully postinstalled tree is
  // verified read-only; only an active installer is waited for (its custody is
  // reused and the tree rechecked after it exits), never a long-lived reader.
  // Stale or incomplete trees fall through to the owner's writer path.
  const admitCurrentTree = async ({ refreshExisting }) => {
    if (pm.name !== 'pnpm' || onDependenciesReady || needsSharedUiRepair) return false;
    const readiness = await inspectDependencyRefresh({ installDir, componentDir, env });
    if (readiness.required || (await inspectUiPostinstallOutputs(componentDir, installDir, { env })).length > 0) return false;
    await withDependencyRefresh({ installDir, componentDir, env, refreshExisting, waitForPendingStart }, refreshDependencies);
    if (prepareComponentOutputs) await ensureComponentPrerequisites(componentDir, label, { quiet, env, pm });
    return true;
  };
  const prepareWithoutInstall = async () => {
    if (!guardedDependencyReadyAction) return;
    if (await admitCurrentTree({ refreshExisting: false })) return;
    if (pm.name === 'pnpm') {
      await withDependencyRefresh({ installDir, componentDir, env,
        refreshExisting: false, waitForPendingStart, onDependenciesReady: guardedDependencyReadyAction }, async () => {});
    } else {
      await ensureComponentPrerequisites(componentDir, label, { quiet, env, pm });
    }
  };
  const installArgs = buildDependencyInstallArgs(pm.name, {
    // A dev target is a one-way synchronized replica. Its dependency tree is
    // mutable, but dependency inputs remain owned by the source checkout.
    preserveLockfile: String(env?.HAPPIER_DEV_TARGET_EXECUTION ?? '').trim() === '1',
  });
  const installAndPrepare = async (installEnv = env) => {
    await runPm(pm, installArgs, { cwd: installDir, stdio, env: installEnv, captureFailureDiagnostic: true });
    if (pm.name === 'pnpm' && String(installEnv.HAPPIER_DEV_TARGET_EXECUTION ?? '').trim() === '1') {
      await ensureServerGeneratedProviderOutputs(join(installDir, 'apps', 'server'), installDir, { quiet, env: installEnv, pm });
    }
    const uiDir = sharedUiDir ?? componentDir;
    // The full installed tree belongs to every worker role. A markdown sentinel
    // cannot prove changed patches or generated worker/webview assets are current.
    await ensureUiPostinstallOutputs(uiDir, installDir, { quiet, env: installEnv, pm, force: true });
  };
  const refreshDependencies = async ({ env: installEnv = env } = {}) => {
    await ensureCanonicalPnpmReady();
    if (!quiet) {
      // eslint-disable-next-line no-console
      console.log(`[local] refreshing ${label} dependencies (pnpm-lock.yaml/pnpm-workspace.yaml/package.json/patches changed)...`);
    }
    await installAndPrepare(installEnv);
  };

  if (await pathExists(nodeModules)) {
    const skipRefresh =
      refreshExisting === false ||
      isDependencyRefreshDisabled(env);
    if (skipRefresh) {
      if (onDependenciesReady) {
        throw new Error(`[local] cannot run ${label} dependency-ready actions while dependency refresh is disabled`);
      }
      await prepareWithoutInstall();
      return;
    }

    // In service contexts (launchd/systemd), avoid doing surprise dependency refreshes just because
    // files changed on disk. This keeps long-running stacks resilient even if the checkout becomes
    // temporarily un-buildable (e.g. mid-rebase / failing typecheck).
    const allowRefresh =
      String(env?.HAPPIER_STACK_SERVICE_ALLOW_REFRESH_DEPS ?? '').trim() === '1' ||
      String(env?.HAPPIER_STACK_ALLOW_REFRESH_DEPS ?? '').trim() === '1';
    if (isServiceMode(env) && !allowRefresh) {
      if (onDependenciesReady) {
        throw new Error(`[local] cannot run ${label} dependency-ready actions in a service without dependency refresh permission`);
      }
      await prepareWithoutInstall();
      return;
    }

    if (await admitCurrentTree({ refreshExisting: true })) return;

    if (pm.name === 'pnpm') {
      await withDependencyRefresh({
        installDir,
        componentDir,
        env,
        waitForPendingStart,
        onDependenciesReady: guardedDependencyReadyAction,
      }, refreshDependencies);
    }

    if (prepareComponentOutputs && pm.name !== 'pnpm') {
      await ensureComponentPrerequisites(componentDir, label, { quiet, env, pm });
    }
    return;
  }

  const installFirstRun = async ({ env: installEnv = env } = {}) => {
    await ensureCanonicalPnpmReady();
    if (!quiet) {
      // eslint-disable-next-line no-console
      console.log(`[local] installing ${label} dependencies (first run)...`);
    }
    await installAndPrepare(installEnv);
  };
  if (pm.name === 'pnpm') {
    await withDependencyRefresh(
      {
        installDir,
        componentDir,
        env,
        waitForPendingStart,
        onDependenciesReady: guardedDependencyReadyAction,
      },
      installFirstRun,
    );
  } else {
    await installFirstRun();
  }
  if (pm.name !== 'pnpm') await ensureComponentPrerequisites(componentDir, label, { quiet, env, pm });
}

async function runStackWorkspacePackageScript(packageDir, script, { env, quiet, args = [], timeoutMs, captureFailureDiagnostic = quiet }) {
  const pm = await getComponentPm(packageDir, env);
  const stdio = quiet ? 'ignore' : 'inherit';
  if (pm.name === 'pnpm') await ensurePnpmReady({ dir: packageDir, env, quiet, pm });
  await runPm(pm, ['run', '--silent', script, ...args], {
    ownedProcessGroup: true,
    cwd: packageDir,
    stdio,
    env,
    timeoutMs,
    captureFailureDiagnostic,
  });
}

export const stackWorkspaceBuildBoundary = {
  workerModule: import.meta.url,
  workerExport: 'stackWorkspaceBuildBoundary',
  prepareEnv: preparePmEnv,
  runPackageBuild: (packageDir, options) => runStackWorkspacePackageScript(packageDir, 'build', options),
  runPackageScript: runStackWorkspacePackageScript,
};

export async function ensureWorkspacePackagesBuiltByName(monorepoPath, packageNames, options = {}) {
  const { ensureWorkspacePackagesBuiltByName: ensureWorkspacePackagesBuiltByNameCanonical } =
    await loadSourceWorkspaceModule('ensureWorkspacePackagesBuilt.mjs');
  return ensureWorkspacePackagesBuiltByNameCanonical(monorepoPath, packageNames, {
    ...options,
    workspaceBuildBoundary: stackWorkspaceBuildBoundary,
  });
}

export async function ensureWorkspacePackagesBuiltForComponent(componentDir, options = {}) {
  const { ensureWorkspacePackagesBuiltForComponent: ensureWorkspacePackagesBuiltForComponentCanonical } =
    await loadSourceWorkspaceModule('ensureWorkspacePackagesBuilt.mjs');
  return ensureWorkspacePackagesBuiltForComponentCanonical(componentDir, {
    ...options,
    workspaceBuildBoundary: stackWorkspaceBuildBoundary,
  });
}

export async function syncSharedDepsForSourceDev(repoRoot, {
  cliDir = join(repoRoot, 'apps', 'cli'),
  platform = process.platform,
  env,
  heldLockValue,
  lockPath,
  quiet,
  workspaceNames,
  includeRuntimeDependencies = true,
  spawnProcImpl = spawnProc,
} = {}) {
  const sourceDevSyncModulePath = join(cliDir, 'scripts', 'buildSharedDeps.mjs');
  if (!(await pathExists(sourceDevSyncModulePath))) {
    return null;
  }
  const sourceDevSyncEntrypoint = join(cliDir, 'scripts', 'syncSharedDepsForDev.mjs');
  if (!(await pathExists(sourceDevSyncEntrypoint))) {
    throw new Error(
      `Current CLI source-dev dependency entrypoint is unavailable: ${sourceDevSyncEntrypoint}`,
    );
  }
  const normalizedWorkspaceNames = [...new Set((workspaceNames ?? [])
    .map((value) => String(value ?? '').trim().replace(/^@happier-dev\//, ''))
    .filter(Boolean))];
  const sourceDevSyncArgs = [
    sourceDevSyncEntrypoint,
    '--json',
    ...(!includeRuntimeDependencies ? ['--no-runtime-dependencies'] : []),
    ...normalizedWorkspaceNames,
  ];
  // Source-dev dependency publication is CPU/filesystem-heavy. On Linux, reuse
  // the canonical protected local-dispatch path so a rescue-priority Stack
  // owner cannot leak its scheduling priority into the publisher and its
  // compiler children. This startup-critical publication must keep progressing
  // under load, so it intentionally does not enter the heavyweight wait queue.
  const command = platform === 'linux'
    ? fileURLToPath(new URL('../../../bin/hstack-exec', import.meta.url))
    : process.execPath;
  const args = platform === 'linux'
    ? ['--local', '--', process.execPath, ...sourceDevSyncArgs]
    : sourceDevSyncArgs;
  const childEnv = {
    ...(env ?? process.env),
    ...(platform === 'linux' ? { HAPPIER_HSTACK_DISPATCH_CONTROL: '1' } : {}),
    ...(heldLockValue ? { HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: heldLockValue } : {}),
    ...(lockPath ? { HAPPIER_SOURCE_DEV_SHARED_DEPS_LOCK_PATH: lockPath } : {}),
  };
  let resultPayload = null;
  const diagnosticStreamMaxChars = 8_000;
  let diagnosticOut = '';
  let diagnosticErr = '';
  let failureDiagnosticTruncated = false;
  const resultPrefix = '__HAPPIER_SOURCE_DEV_SYNC_RESULT__=';
  const child = spawnProcImpl('local', command, args, childEnv, {
    cwd: repoRoot,
    silent: Boolean(quiet),
    lineFilter: ({ stream, line }) => {
      if (stream === 'stdout' && line.startsWith(resultPrefix)) {
        resultPayload = JSON.parse(line.slice(resultPrefix.length));
        return false;
      }
      const chunk = `${line}\n`;
      if (stream === 'stdout') {
        failureDiagnosticTruncated ||= diagnosticOut.length + chunk.length > diagnosticStreamMaxChars;
        diagnosticOut = appendBoundedTail(diagnosticOut, chunk, diagnosticStreamMaxChars);
      } else if (stream === 'stderr') {
        failureDiagnosticTruncated ||= diagnosticErr.length + chunk.length > diagnosticStreamMaxChars;
        diagnosticErr = appendBoundedTail(diagnosticErr, chunk, diagnosticStreamMaxChars);
      }
      return true;
    },
  });
  const completion = await child.completion;
  if (completion.code !== 0) {
    const failureDiagnostic = formatFailureDiagnostic({
      out: diagnosticOut,
      err: diagnosticErr,
      truncated: failureDiagnosticTruncated,
      env: childEnv,
    });
    const error = new Error(
      `Current CLI source-dev dependency publication failed ` +
      `(code=${completion.code ?? 'null'}, sig=${completion.signal ?? 'null'})${failureDiagnostic}`,
    );
    error.code = 'EEXIT';
    error.exitCode = completion.code;
    error.signal = completion.signal;
    throw error;
  }
  if (!resultPayload || typeof resultPayload !== 'object') {
    throw new Error('Current CLI source-dev dependency publication did not report its result');
  }
  return resultPayload;
}

export async function inspectUsableSourceDevSharedDepsLastGreen(repoRoot, {
  cliDir = join(repoRoot, 'apps', 'cli'),
  workspaceNames,
} = {}) {
  const sourceDevSyncModulePath = join(cliDir, 'scripts', 'buildSharedDeps.mjs');
  if (!(await pathExists(sourceDevSyncModulePath))) {
    return { usable: false, reason: 'readiness-unavailable' };
  }
  const sourceDevSyncModule = await import(pathToFileURL(sourceDevSyncModulePath).href);
  if (typeof sourceDevSyncModule.inspectUsableSourceDevSharedDepsLastGreen !== 'function') {
    return { usable: false, reason: 'readiness-unavailable' };
  }
  return sourceDevSyncModule.inspectUsableSourceDevSharedDepsLastGreen({
    repoRoot,
    workspaceNames,
  });
}

export async function ensureCliBuilt(cliDir, {
  buildCli,
  quiet = false,
  env: envIn = process.env,
  platform = process.platform,
} = {}) {
  const { readHappyCliRuntimeInputFreshness } = await import('./cli_runtime_inputs.mjs');
  const distEntrypoint = join(cliDir, 'dist', 'index.mjs');
  const invocationDistFreshness = await readUsableCliDistFreshness(distEntrypoint);
  const invocationInputFreshness = await readHappyCliRuntimeInputFreshness(cliDir);
  const repoRoot = coerceHappyMonorepoRootFromPath(cliDir);
  const lockPath = repoRoot
    ? resolveCliDistBuildLockPath(repoRoot)
    : join(cliDir, '.dist.hstack-build.lock');
  await ensureDepsInstalled(cliDir, 'happier-cli', { quiet, env: envIn });

  const prepareWorkspaceOutputs = async () => {
    let sourceDevPreparation = null;
    if (repoRoot) {
      sourceDevPreparation = await syncSharedDepsForSourceDev(repoRoot, {
        cliDir,
        env: envIn,
        quiet,
        platform,
      });
    }
    return { sourceDevPreparation };
  };
  const preparation = await prepareWorkspaceOutputs();
  const request = { cliDir, buildCli, quiet, platform, repoRoot, lockPath,
    invocationDistFreshness, invocationInputFreshness, preparation };
  if (repoRoot && buildCli) {
    // A usable warm CLI requires no compiler envelope. Recheck that optimistic
    // observation under the same owner; if compilation is needed, leave the
    // lease before entering the finite transaction gate.
    const mode = String(envIn.HAPPIER_STACK_CLI_BUILD_MODE ?? (isServiceMode(envIn) ? 'never' : 'auto')).trim().toLowerCase();
    if ((mode === 'never' && invocationDistFreshness !== null)
      || (mode !== 'always' && preparation.sourceDevPreparation?.synced !== true
        && await isCliDistFreshForInputs(distEntrypoint, invocationInputFreshness))) {
      const reused = await ensureCliBuiltUnderLock(request, envIn, false);
      if (reused !== null) return reused;
    }
    const { runWorkspaceBuildAdmission } = await import('./workspace_build_admission.mjs');
    const { requiresTypeScriptAdmission } = await loadSourceWorkspaceModule('resolveTypeScriptCliInvocation.mjs');
    const resultDir = await mkdtemp(join(tmpdir(), 'happier-cli-readiness-result-'));
    const resultPath = join(resultDir, 'result.json');
    try {
      const terminal = await runWorkspaceBuildAdmission({
        command: process.execPath,
        args: [fileURLToPath(import.meta.url), '--cli-build-worker', JSON.stringify({ ...request, resultPath,
          invocationInputFreshness: invocationInputFreshness && {
            ...invocationInputFreshness,
            newestMtimeNs: invocationInputFreshness.newestMtimeNs?.toString() ?? null,
          } })],
        locks: [{ path: lockPath }], cwd: cliDir, env: envIn,
        admissionClass: 'compilation', admissionRequired: requiresTypeScriptAdmission({ env: envIn }),
        stdio: quiet ? ['ignore', 'ignore', 'inherit'] : 'inherit',
      });
      if (!existsSync(resultPath)) {
        if (terminal.error) throw terminal.error;
        const error = new Error('[local] CLI readiness worker did not complete');
        Object.assign(error, { code: 'EEXIT', exitCode: terminal.status, signal: terminal.signal });
        throw error;
      }
      const response = JSON.parse(await readFile(resultPath, 'utf8'));
      if (response.error) {
        const error = new Error(response.error.message);
        Object.assign(error, { name: response.error.name, code: response.error.code,
          exitCode: response.error.exitCode, signal: response.error.signal });
        throw error;
      }
      if (terminal.error || terminal.status !== 0 || terminal.signal) {
        throw terminal.error ?? new Error('[local] CLI readiness worker did not complete successfully');
      }
      return response.result;
    } finally {
      await rm(resultDir, { recursive: true, force: true });
    }
  }
  return await ensureCliBuiltUnderLock(request, envIn);
}

async function ensureCliBuiltUnderLock({ cliDir, buildCli, quiet, lockPath,
  invocationDistFreshness, invocationInputFreshness, preparation }, envIn, allowCompilation = true) {
  const { happyCliRuntimeInputFreshnessEqual, readHappyCliRuntimeInputFreshness } = await import('./cli_runtime_inputs.mjs');
  const distEntrypoint = join(cliDir, 'dist', 'index.mjs');
  return await withCliDistBuildLock(async ({ heldLockValue }) => {
    if (!buildCli) {
      return { built: false, reason: 'disabled' };
    }
    // Default: build only when needed (fast + reliable for worktrees that haven't been built yet).
    //
    // You can force always-build by setting:
    // - HAPPIER_STACK_CLI_BUILD_MODE=always
    // Or disable via:
    // - HAPPIER_STACK_CLI_BUILD=0
    const serviceDefaultMode = isServiceMode(envIn) ? 'never' : 'auto';
    const modeRaw = (envIn.HAPPIER_STACK_CLI_BUILD_MODE ?? serviceDefaultMode).trim().toLowerCase();
    const mode = modeRaw === 'always' || modeRaw === 'auto' || modeRaw === 'never' ? modeRaw : 'auto';
    const distDir = join(cliDir, 'dist');
    if (!allowCompilation && await readUsableCliDistFreshness(distEntrypoint) === null) return null;
    const releaseDistBackupDir = join(cliDir, '.dist.hstack-backup');
    const backupDistEntrypoint = join(releaseDistBackupDir, 'index.mjs');
    const inputFreshness = await readHappyCliRuntimeInputFreshness(cliDir);
    const releaseBackupFreshness = await readUsableCliDistFreshness(backupDistEntrypoint);
    const restoredReleaseBackup =
      await readUsableCliDistFreshness(distEntrypoint) === null
      && releaseBackupFreshness !== null;
    if (restoredReleaseBackup) {
      await rm(distDir, { recursive: true, force: true });
      try {
        await cp(releaseDistBackupDir, distDir, {
          recursive: true,
          force: false,
          errorOnExist: true,
        });
      } catch (error) {
        try {
          await rm(distDir, { recursive: true, force: true });
          await rename(releaseDistBackupDir, distDir);
        } catch (recoveryError) {
          throw new AggregateError(
            [error, recoveryError],
            `${String(error?.message ?? error)}\n[local] failed to restore the prior CLI release artifact after recovery copy failed`,
            { cause: error },
          );
        }
        throw error;
      }
    }
    const currentDistFreshness = await readUsableCliDistFreshness(distEntrypoint);
    const buildCompletedSinceInvocation =
      !restoredReleaseBackup
      && currentDistFreshness !== invocationDistFreshness;
    const inputsChangedWhileWaiting = invocationInputFreshness !== null
      && inputFreshness !== null
      && !happyCliRuntimeInputFreshnessEqual(invocationInputFreshness, inputFreshness);

    const discardReleaseBackup = async () => {
      await rm(releaseDistBackupDir, { recursive: true, force: true }).catch(() => {});
    };
    const completeWithReleaseBackupRollback = async (
      operation,
      { retainReleaseBackupOnSuccess = false } = {},
    ) => {
      try {
        const result = await operation();
        if (!retainReleaseBackupOnSuccess) {
          await discardReleaseBackup();
        }
        return result;
      } catch (error) {
        if (restoredReleaseBackup) {
          try {
            if (await readUsableCliDistFreshness(backupDistEntrypoint) === null) {
              throw new Error('[local] prior CLI release backup became unusable during the failed build');
            }
            await rm(distDir, { recursive: true, force: true });
            await rename(releaseDistBackupDir, distDir);
          } catch (recoveryError) {
            throw new AggregateError(
              [error, recoveryError],
              `${String(error?.message ?? error)}\n[local] failed to restore the prior CLI release artifact after the CLI build failed`,
              { cause: error },
            );
          }
        }
        throw error;
      }
    };

    if (!restoredReleaseBackup) {
      await discardReleaseBackup();
    }

    if (buildCompletedSinceInvocation) {
      if (!inputsChangedWhileWaiting && await isCliDistFreshForInputs(distEntrypoint, inputFreshness)) {
        return {
          built: false,
          current: true,
          reason: 'concurrent_build_already_completed',
        };
      }
      return {
        built: false,
        current: false,
        reason: 'concurrent_build_superseded',
      };
    }

    // "never" should prevent rebuild churn, but it must not make the stack unrunnable.
    // If the dist entrypoint is missing, build once even in "never" mode.
    if (mode === 'never') {
      if (await readUsableCliDistFreshness(distEntrypoint) !== null) {
        return await completeWithReleaseBackupRollback(
          () => ({ built: false, current: false, reason: 'mode_never' }),
        );
      }
      // fallthrough to build
    }

    if (mode === 'auto') {
      // If dist doesn't exist, we must build.
      if (inputsChangedWhileWaiting) {
        // Rebuild from the inputs observed after acquiring the serialized build lock.
      } else if (!(await pathExists(distEntrypoint))) {
        // fallthrough to build
      } else if (await isCliDistFreshForInputs(distEntrypoint, inputFreshness)) {
        if (
          preparation.sourceDevPreparation?.synced !== true
        ) {
          await discardReleaseBackup();
          return { built: false, current: true, reason: 'up_to_date' };
        }
        // Rebuilt workspace outputs or a refreshed source-dev bundle change the
        // inputs consumed by pkgroll without changing the CLI source fingerprint.
        // Run the full pnpm lifecycle before admitting this CLI publication.
      }
    }

    if (!allowCompilation) return null;
    return await completeWithReleaseBackupRollback(async () => {
      const env = await preparePmEnv(cliDir, envIn);
      await repairCorruptedCliPkgrollInstallIfNeeded(cliDir, { quiet, env });
      const pm = await getComponentPm(cliDir, env);
      const buildEnv = {
        ...env,
        HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: heldLockValue,
      };
      await runPm(pm, ['run', 'build:prepared'], {
        ownedProcessGroup: true,
        cwd: cliDir,
        env: buildEnv,
        stdio: quiet ? 'ignore' : 'inherit',
        captureFailureDiagnostic: quiet ? { env: buildEnv } : false,
      });
      if (!(await pathExists(distEntrypoint))) {
        throw new Error(
            `[local] happier-cli build finished but did not produce expected entrypoint.\n` +
            `Expected: ${distEntrypoint}\n` +
            `Fix: run the component build directly and inspect its output:\n` +
            `  cd "${cliDir}" && ${formatPmCommand(pm, ['build:prepared'])}`
        );
      }

      if (await readUsableCliDistFreshness(distEntrypoint) === null) {
        const integrity = readCliDistIntegrity(distEntrypoint);
        throw new Error(`[local] happier-cli dist build is not usable: ${integrity.reason}`);
      }
      await probeCliDistRuntimeImport(distEntrypoint, { cwd: cliDir, env: buildEnv });

      const nowFreshness = await readHappyCliRuntimeInputFreshness(cliDir);
      // The canonical pnpm prebuild may publish generated CLI source before
      // build.mjs snapshots the inputs it actually compiles. Judge the result
      // against the manifest recorded by that builder, not the earlier Stack
      // admission, so a coherent prebuild publication does not trigger an
      // identical trailing build. Live edits after the immutable snapshot still
      // produce a different current fingerprint and remain correctly stale.
      const inputsStayedCurrent = await isCliDistFreshForInputs(
        distEntrypoint,
        nowFreshness,
      );
      return inputsStayedCurrent
        ? { built: true, current: true, reason: mode === 'always' ? 'mode_always' : 'changed' }
        : { built: true, current: false, reason: 'inputs_changed_during_build' };
    });
  }, {
    lockPath,
    env: envIn,
    onWait: createWorkspaceBuildWaitNotifier({ env: envIn, label: 'happier-cli', kind: 'lock' }),
  });
}

async function runCliBuildWorker(rawRequest) {
  const request = JSON.parse(rawRequest);
  if (request.invocationInputFreshness?.newestMtimeNs !== null
    && request.invocationInputFreshness?.newestMtimeNs !== undefined) {
    request.invocationInputFreshness.newestMtimeNs = BigInt(request.invocationInputFreshness.newestMtimeNs);
  }
  const { callerHoldsWorkspaceBundleLock } = await loadSourceWorkspaceModule('workspaceBundleLock.mjs');
  let leases;
  try { leases = JSON.parse(process.env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_LEASES ?? '[]'); }
  catch { leases = []; }
  const candidates = [process.env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD,
    ...(Array.isArray(leases) ? leases : [])];
  if (!candidates.some(value => typeof value === 'string'
    && callerHoldsWorkspaceBundleLock(request.lockPath, value))) {
    throw new Error('[local] CLI readiness worker requires its authenticated publication lease');
  }
  let response;
  try { response = { result: await ensureCliBuiltUnderLock(request, process.env) }; }
  catch (error) {
    response = { error: { name: error.name, message: error.message,
      code: error.code, exitCode: error.exitCode, signal: error.signal } };
    process.exitCode = error.exitCode ?? 1;
  }
  await writeFile(request.resultPath, JSON.stringify(response));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
  && process.argv[2] === '--cli-build-worker') {
  runCliBuildWorker(process.argv[3]).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

function getPathEntries() {
  const raw = process.env.PATH ?? '';
  const delimiter = process.platform === 'win32' ? ';' : ':';
  return raw.split(delimiter).filter(Boolean);
}

function isPathInside(path, dir) {
  const p = resolve(path);
  const d = resolve(dir);
  return p === d || p.startsWith(d.endsWith(sep) ? d : d + sep);
}

export async function ensureHappyCliLocalNpmLinked(rootDir, { npmLinkCli, quiet = false } = {}) {
  if (!npmLinkCli) {
    return;
  }

  const homeDir = getHappyStacksHomeDir();
  const binDir = join(homeDir, 'bin');
  await mkdir(binDir, { recursive: true });

  const legacyHappyShim = join(binDir, 'happy');
  const happierShim = join(binDir, 'happier');

  const shim = `#!/bin/bash
set -euo pipefail
# Prefer the sibling hstack shim (works for sandbox installs too).
BIN_DIR="$(cd "$(dirname "$0")" && pwd)"
hstack="$BIN_DIR/hstack"
if [[ -x "$hstack" ]]; then
  exec "$hstack" happier "$@"
fi

# Fallback: run hstack from runtime install if present.
HOME_DIR="\${HAPPIER_STACK_HOME_DIR:-$HOME/.happier-stack}"
RUNTIME="$HOME_DIR/runtime/node_modules/@happier-dev/stack/bin/hstack.mjs"
if [[ -f "$RUNTIME" ]]; then
  exec node "$RUNTIME" happier "$@"
fi

echo "error: cannot find hstack shim or runtime install" >&2
exit 1
`;

  const writeIfChanged = async (path, text) => {
    let existing = '';
    try {
      existing = await readFile(path, 'utf-8');
    } catch {
      existing = '';
    }
    if (existing === text) return false;
    await writeFile(path, text, 'utf-8');
    return true;
  };

  // Install the Happier CLI shim under `happier` (avoid clashing with Happy's `happy` shim).
  await writeIfChanged(happierShim, shim);
  await chmod(happierShim, 0o755).catch(() => {});

  // Remove legacy `happy` shim (it conflicts with Happy stacks installs).
  try {
    await unlink(legacyHappyShim);
  } catch {
    // ignore
  }

  // If user’s PATH points at a legacy install path, try to make it sane (best-effort).
  const entries = getPathEntries();
  const legacyBin = join(homedir(), '.happier-stack', 'bin');
  const newBin = join(homeDir, 'bin');
  if (entries.some((p) => isPathInside(p, legacyBin)) && !entries.some((p) => isPathInside(p, newBin))) {
    if (!quiet) {
      // eslint-disable-next-line no-console
      console.log(`[local] note: your PATH includes ${legacyBin}; recommended path is ${newBin}`);
    }
  }

  const cliRoot = resolveInstalledCliRoot(rootDir);
  return { ok: true, cliRoot, binDir, happierShim, removedLegacyHappyShim: true };
}

export async function pmExecScript({ dir, script, args = [], env = process.env, quiet = false }) {
  await runStackWorkspacePackageScript(dir, script, {
    args,
    env: await preparePmEnv(dir, env),
    quiet,
  });
}

export async function pmExecBin(dirOrOpts, binArg, argsArg, optsArg) {
  const usesObjectStyle = typeof dirOrOpts === 'object' && dirOrOpts !== null;

  const dir = usesObjectStyle ? dirOrOpts.dir : dirOrOpts;
  const bin = usesObjectStyle ? dirOrOpts.bin : binArg;
  const args = usesObjectStyle ? (dirOrOpts.args ?? []) : (argsArg ?? []);

  const envIn = usesObjectStyle ? (dirOrOpts.env ?? process.env) : (optsArg?.env ?? process.env);
  const env = await preparePmEnv(dir, envIn);
  const quiet = usesObjectStyle ? Boolean(dirOrOpts.quiet) : Boolean(optsArg?.quiet);
  const stdio = quiet ? 'ignore' : 'inherit';

  const pm = await getComponentPm(dir, env);
  if (pm.name === 'pnpm') {
    await ensurePnpmReady({ dir, env, quiet, pm });
  }
  await runPm(pm, [pm.name === 'pnpm' ? 'exec' : 'run', bin, ...args], { cwd: dir, env, stdio });
}

export async function pmSpawnBin(dir, label, bin, args, { env = process.env } = {}) {
  const usesObjectStyle = typeof dir === 'object' && dir !== null;
  const componentDir = usesObjectStyle ? dir.dir : dir;
  const componentLabel = usesObjectStyle ? dir.label : label;
  const componentBin = usesObjectStyle ? dir.bin : bin;
  const componentArgs = usesObjectStyle ? (dir.args ?? []) : (args ?? []);
  const componentEnv = usesObjectStyle ? (dir.env ?? process.env) : (env ?? process.env);
  const options = usesObjectStyle ? (dir.options ?? {}) : {};
  const quiet = usesObjectStyle ? Boolean(dir.quiet) : false;

  const effectiveEnv = await preparePmEnv(componentDir, componentEnv);
  const pm = await getComponentPm(componentDir, effectiveEnv);
  if (pm.name === 'pnpm') {
    await ensurePnpmReady({ dir: componentDir, env: effectiveEnv, quiet, pm });
  }
  const envForChild = applyStackInfraProcessKind(effectiveEnv);
  return spawnPm(componentLabel, pm, [pm.name === 'pnpm' ? 'exec' : 'run', componentBin, ...componentArgs], envForChild, { cwd: componentDir, ...options });
}

export async function pmSpawnScript(dir, label, script, args, { env = process.env } = {}) {
  const usesObjectStyle = typeof dir === 'object' && dir !== null;
  const componentDir = usesObjectStyle ? dir.dir : dir;
  const componentLabel = usesObjectStyle ? dir.label : label;
  const componentScript = usesObjectStyle ? dir.script : script;
  const componentArgs = usesObjectStyle ? (dir.args ?? []) : (args ?? []);
  const componentEnv = usesObjectStyle ? (dir.env ?? process.env) : (env ?? process.env);
  const options = usesObjectStyle ? (dir.options ?? {}) : {};
  const quiet = usesObjectStyle ? Boolean(dir.quiet) : false;

  const effectiveEnv = await preparePmEnv(componentDir, componentEnv);
  const pm = await getComponentPm(componentDir, effectiveEnv);
  if (pm.name === 'pnpm') {
    await ensurePnpmReady({ dir: componentDir, env: effectiveEnv, quiet, pm });
  }
  const envForChild = applyStackInfraProcessKind(effectiveEnv);
  return spawnPm(componentLabel, pm, ['run', componentScript, ...componentArgs], envForChild, { cwd: componentDir, ...options });
}
