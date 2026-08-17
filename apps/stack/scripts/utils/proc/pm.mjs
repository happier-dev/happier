import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { chmod, cp, mkdir, readFile, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';

import { pathExists } from '../fs/fs.mjs';
import { run, spawnProc } from './proc.mjs';
import { resolveCommandPath } from './commands.mjs';
import { coerceHappyMonorepoRootFromPath, getDefaultAutostartPaths, getHappyStacksHomeDir } from '../paths/paths.mjs';
import { resolveInstalledPath, resolveInstalledCliRoot } from '../paths/runtime.mjs';
import { expandHome } from '../paths/canonical_home.mjs';
import { resolveCliDistBuildLockPath, withCliDistBuildLock } from './cliDistBuildLock.mjs';
import { withDependencyRefresh } from './dependency_refresh.mjs';
import { describeJsonOwnerLockOwner } from './jsonOwnerFileLock.mjs';
import { resolveWorkspaceToolBinDirs } from './workspace_tool_bins.mjs';
import { probeCliDistRuntimeImport, readCliDistIntegrity } from '../cli/cliDistIntegrity.mjs';
import {
  happyCliRuntimeInputFreshnessEqual,
  readHappyCliRuntimeInputFreshness,
} from './cli_runtime_inputs.mjs';
export { isCliDistBuildLockActive } from './cliDistBuildLock.mjs';

// These are source-workspace build tools, not part of the installed Stack runtime. Keep their
// repository imports lazy so an installed Stack can load daemon lifecycle code from its bundled
// dependencies without requiring a checkout beside the installation.
function loadSourceWorkspaceModule(relativePath) {
  return import(new URL(`../../../../../scripts/workspaces/${relativePath}`, import.meta.url).href);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf-8'));
}

function isServiceMode(env = process.env) {
  const raw = String(env?.HAPPIER_STACK_SERVICE_MODE ?? '').trim();
  if (raw) return raw !== '0';

  // In CI, we prefer deterministic builds and want failures to surface.
  const isCi = Boolean(String(env?.CI ?? '').trim());
  if (isCi) return false;

  const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (isInteractive) return false;

  // launchd (macOS) and systemd (Linux) typically run as pid 1.
  return process.ppid === 1;
}

function parsePositiveEnvInt(envValue, fallback) {
  const raw = Number.parseInt(String(envValue ?? '').trim(), 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

function resolveWorkspaceBuildWaitNoticeAfterMs(env = process.env) {
  return parsePositiveEnvInt(env.HAPPIER_WORKSPACE_BUILD_NOTICE_AFTER_MS, 5_000);
}

function resolveWorkspaceBuildWaitNoticeEveryMs(env = process.env) {
  return parsePositiveEnvInt(env.HAPPIER_WORKSPACE_BUILD_NOTICE_EVERY_MS, 30_000);
}

function createWorkspaceBuildWaitNotifier({ env = process.env, label, kind }) {
  const noticeAfterMs = resolveWorkspaceBuildWaitNoticeAfterMs(env);
  const noticeEveryMs = resolveWorkspaceBuildWaitNoticeEveryMs(env);
  let lastNoticeMs = null;

  return (event = {}) => {
    const waitedMs = Number(event.waitedMs ?? 0);
    if (!Number.isFinite(waitedMs) || waitedMs < noticeAfterMs) {
      return;
    }

    if (lastNoticeMs != null && waitedMs - lastNoticeMs < noticeEveryMs) {
      return;
    }
    lastNoticeMs = waitedMs;

    let message = '';
    if (kind === 'lock') {
      const ownerText = describeJsonOwnerLockOwner(event.owner, Date.now());
      message = `[local] waiting for ${label} lock (${Math.ceil(waitedMs / 1000)}s): ${event.lockPath} (${ownerText})`;
    } else if (kind === 'imports') {
      const attempt = Number(event.attempt ?? 0);
      const attempts = Number(event.attempts ?? 0);
      const attemptLabel = Number.isFinite(attempts) && attempts > 0 ? `${attempt + 1}/${attempts}` : `${attempt + 1}/?`;
      message = `[local] waiting for ${label} local imports to settle (${Math.ceil(waitedMs / 1000)}s, attempt ${attemptLabel}): ${event.entryPath}`;
    } else {
      message = `[local] waiting for ${label} (${Math.ceil(waitedMs / 1000)}s)`;
    }

    try {
      process.stderr.write(`${message}\n`);
    } catch {}
  };
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
    const manifestStat = await stat(integrity.manifestPath, { bigint: true });
    const inputFingerprint = String(integrity.manifest?.inputFingerprint ?? '').trim().toLowerCase();
    return {
      manifestMtimeNs: manifestStat.mtimeNs,
      inputFingerprint: /^[a-f0-9]{64}$/.test(inputFingerprint) ? inputFingerprint : null,
    };
  } catch {
    return null;
  }
}

async function readUsableCliDistFreshness(distEntrypoint) {
  return (await readUsableCliDistState(distEntrypoint))?.manifestMtimeNs ?? null;
}

async function isCliDistFreshForInputs(distEntrypoint, inputFreshness) {
  const distState = await readUsableCliDistState(distEntrypoint);
  if (distState === null) return false;
  if (inputFreshness === null) return true;
  const inputFingerprint = String(inputFreshness.fingerprint ?? '').trim().toLowerCase();
  if (inputFingerprint) {
    return distState.inputFingerprint === inputFingerprint;
  }
  return inputFreshness.newestMtimeNs === null
    || inputFreshness.newestMtimeNs <= distState.manifestMtimeNs;
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

  // Preserve the package-manager invocation selected by the caller. Stack augments PATH with
  // the active Node runtime so package-manager child scripts can always launch Node; that must
  // not accidentally make a sibling Yarn shim outrank the explicit Yarn JS entrypoint inherited
  // through npm_execpath.
  const searchEnv = packageManagerSearchEnvByPreparedEnv.get(env) ?? env;
  const { resolveYarnCommandInvocation } = await loadSourceWorkspaceModule('execYarnCommand.mjs');
  const inheritedYarnInvocation = resolveYarnCommandInvocation([], {
    npmExecPath: searchEnv.npm_execpath,
  });
  if (
    inheritedYarnInvocation.command === process.execPath
    && inheritedYarnInvocation.args.length > 0
  ) {
    return {
      name: 'yarn',
      cmd: inheritedYarnInvocation.command,
      prefixArgs: inheritedYarnInvocation.args,
    };
  }

  const binaryMode = String(env.HAPPIER_STACK_BINARY_MODE ?? '').trim() === '1'
    || String(env.HAPPIER_STACK_INSTALL_SOURCE ?? '').trim() === 'binary';
  // IMPORTANT: probe with cwd=componentDir; Yarn can be blocked depending on Corepack context.
  // Resolve the caller's complete PATH policy before consulting directories Stack added for
  // child-runtime compatibility. Otherwise a sibling Yarn shim beside the preferred Node binary
  // can incorrectly outrank an explicit caller-provided Corepack (or npm in binary mode).
  const resolveFromPath = async (candidateEnv) => {
    const yarnPath = await resolveCommandPath('yarn', { cwd: dir, env: candidateEnv });
    if (yarnPath) return { name: 'yarn', cmd: yarnPath, prefixArgs: [], directCommand: true };
    const npmPath = binaryMode
      ? await resolveCommandPath('npm', { cwd: dir, env: candidateEnv })
      : '';
    if (npmPath) return { name: 'npm', cmd: npmPath, prefixArgs: [], directCommand: true };
    const corepackPath = await resolveCommandPath('corepack', { cwd: dir, env: candidateEnv });
    if (corepackPath) return { name: 'yarn', cmd: corepackPath, prefixArgs: ['yarn'], directCommand: false };
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

  throw new Error(`[local] yarn is required for component at ${dir}. Install it via Corepack: \`corepack enable\``);
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

export function resolveDependencyInstallRoot(componentDir) {
  const monorepoRoot = coerceHappyMonorepoRootFromPath(componentDir);
  if (!monorepoRoot) {
    return componentDir;
  }
  const rootPkgJson = join(monorepoRoot, 'package.json');
  return existsSync(rootPkgJson) ? monorepoRoot : componentDir;
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

function buildDependencyInstallArgs(packageManagerName, { force = false } = {}) {
  const args = ['install'];
  if (force) {
    args.push('--force');
  }
  if (packageManagerName === 'yarn') {
    args.push('--production=false', '--ignore-engines');
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
  const repairArgs = buildDependencyInstallArgs(pm.name, { force: true });

  if (pm.name === 'yarn') {
    await ensureYarnReady({ dir: installDir, env, quiet, pm });
  }

  if (!quiet) {
    // eslint-disable-next-line no-console
    console.log(`[local] repairing corrupted pkgroll install at ${pkgrollCliPath}...`);
  }
  await runPm(pm, repairArgs, { cwd: installDir, stdio, env });

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
  // Yarn owns installed `node_modules/.bin` entries. Replacing those symlinks while a
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

const _yarnReadyKeys = new Set();

async function readPackageJsonIfExists(pkgJsonPath) {
  if (!(await pathExists(pkgJsonPath))) {
    return null;
  }
  return await readJson(pkgJsonPath);
}

async function ensureServerGeneratedProviderOutputs(componentDir, installDir, { quiet = false, env: envIn, pm: pmIn } = {}) {
  const componentPkgJsonPath = join(componentDir, 'package.json');
  const componentPkg = await readPackageJsonIfExists(componentPkgJsonPath);
  if (componentPkg?.name !== '@happier-dev/server') {
    return;
  }
  if (typeof componentPkg?.scripts?.['generate:providers'] !== 'string') {
    return;
  }

  const env = pmIn
    ? (envIn ?? process.env)
    : await preparePmEnv(installDir, envIn ?? process.env);
  const pm = pmIn ?? await getComponentPm(installDir, env);
  const stdio = quiet ? 'ignore' : 'inherit';
  if (!quiet) {
    // eslint-disable-next-line no-console
    console.log('[local] checking happier-server Prisma provider outputs...');
  }

  if (pm.name === 'yarn') {
    await ensureYarnReady({ dir: installDir, env, quiet, pm });
    await runPm(pm, ['-s', 'workspace', '@happier-dev/server', 'generate:providers'], {
      cwd: installDir,
      stdio,
      env,
    });
    return;
  }

  await runPm(pm, ['run', '-s', 'generate:providers'], {
    cwd: componentDir,
    stdio,
    env,
  });
}

async function ensureComponentPrerequisites(componentDir, _label, { quiet = false, env = process.env } = {}) {
  await ensureServerGeneratedProviderOutputs(componentDir, resolveDependencyInstallRoot(componentDir), { quiet, env });
}

async function ensureYarnReady({ dir, env, quiet = false, pm }) {
  const e = env && typeof env === 'object' ? env : process.env;
  // In stack mode we isolate HOME/cache; key by effective HOME+XDG cache so we only do this once.
  const key = [
    resolve(dir),
    String(e.HOME ?? ''),
    String(e.XDG_CACHE_HOME ?? ''),
    pm.cmd,
    ...(pm.prefixArgs ?? []),
  ].join('|');
  if (_yarnReadyKeys.has(key)) return;

  const stdio = quiet ? 'ignore' : ['pipe', 'ignore', 'inherit'];
  // Corepack sometimes prompts on first use:
  //   "Corepack is about to download ... Do you want to continue? [Y/n]"
  //
  // In TUI mode, the terminal is interactive but keyboard input is consumed by the TUI itself,
  // so Corepack's prompt can deadlock. Always provide a single "yes" to unblock the download.
  await runPm(pm, ['--version'], { cwd: dir, env: e, stdio, input: 'y\n' });
  _yarnReadyKeys.add(key);
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
  // Stack setup/bootstrap frequently runs `yarn install` inside the Happier monorepo.
  // Many workspace lifecycle scripts depend on devDependencies (e.g. TypeScript for `tsc`).
  //
  // If a user (or CI) has NODE_ENV=production / *production* npm/Yarn flags set globally,
  // Yarn can skip devDependencies and the install fails in confusing ways.
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
    || isTruthy(env.YARN_PRODUCTION)
    || isTruthy(env.npm_config_production)
    || isTruthy(env.NPM_CONFIG_PRODUCTION);
  if (!allowProduction && wantsProduction) {
    env.NODE_ENV = 'development';
    env.YARN_PRODUCTION = '0';
    env.npm_config_production = 'false';
    env.NPM_CONFIG_PRODUCTION = 'false';
  }

  const envFile = (env.HAPPIER_STACK_ENV_FILE ?? '').toString().trim();
  const stackCacheBase = resolveStackCacheBaseDirFromEnv(env);
  if (!stackCacheBase) return env;

  // Prisma engines currently default to ~/.cache/prisma (via os.homedir()).
  // In stack mode, isolate HOME for package-manager driven commands so Prisma/Yarn/NPM don't
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

  if (!(env.XDG_CACHE_HOME ?? '').toString().trim()) {
    env.XDG_CACHE_HOME = join(stackCacheBase, 'xdg');
  }
  if (!(env.YARN_CACHE_FOLDER ?? '').toString().trim()) {
    env.YARN_CACHE_FOLDER = join(stackCacheBase, 'yarn');
  }
  if (!(env.npm_config_cache ?? '').toString().trim()) {
    env.npm_config_cache = join(stackCacheBase, 'npm');
  }
  // Corepack caches downloaded package managers (like Yarn) under COREPACK_HOME.
  // In stack mode we want this to be stable and writable so first-run downloads don't prompt/hang in TUI.
  if (!(env.COREPACK_HOME ?? '').toString().trim()) {
    env.COREPACK_HOME = join(stackCacheBase, 'corepack');
  }
  // Avoid Corepack mutating package.json by auto-adding a packageManager field.
  // (This is safe and reduces noise when Corepack is used implicitly.)
  if (!(env.COREPACK_ENABLE_AUTO_PIN ?? '').toString().trim()) {
    env.COREPACK_ENABLE_AUTO_PIN = '0';
  }

  try {
    await mkdir(env.XDG_CACHE_HOME, { recursive: true });
    await mkdir(env.YARN_CACHE_FOLDER, { recursive: true });
    await mkdir(env.npm_config_cache, { recursive: true });
    await mkdir(env.COREPACK_HOME, { recursive: true });
  } catch {
    // best-effort
  }

  return env;
}

export async function ensureDepsInstalled(
  dir,
  label,
  {
    quiet = false,
    env: envIn = process.env,
    refreshExisting = true,
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
  const env = await preparePmEnv(installDir, envIn);
  const pm = await getComponentPm(installDir, env);
  if (pm.name === 'yarn') {
    await ensureYarnReady({ dir: installDir, env, quiet, pm });
  }
  if (onDependenciesReady && pm.name !== 'yarn') {
    throw new Error(`[local] ${label} dependency-ready actions require the canonical Yarn dependency refresh owner`);
  }
  const installArgs = buildDependencyInstallArgs(pm.name);

  if (await pathExists(nodeModules)) {
    const skipRefresh =
      refreshExisting === false ||
      String(env?.HAPPIER_STACK_SKIP_REFRESH_DEPS ?? '').trim() === '1' ||
      String(env?.HAPPIER_STACK_DISABLE_REFRESH_DEPS ?? '').trim() === '1';
    if (skipRefresh) {
      if (onDependenciesReady) {
        throw new Error(`[local] cannot run ${label} dependency-ready actions while dependency refresh is disabled`);
      }
      if (prepareComponentOutputs) {
        await ensureServerGeneratedProviderOutputs(componentDir, installDir, { quiet, env, pm });
      }
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
      if (prepareComponentOutputs) {
        await ensureServerGeneratedProviderOutputs(componentDir, installDir, { quiet, env, pm });
      }
      return;
    }

    if (pm.name === 'yarn') {
      await withDependencyRefresh({ installDir, componentDir, env, onDependenciesReady }, async ({ heldCliLockValue }) => {
        if (!quiet) {
          // eslint-disable-next-line no-console
          console.log(`[local] refreshing ${label} dependencies (yarn.lock/package.json/workspace package.json/patches changed)...`);
        }
        await runPm(pm, installArgs, {
          cwd: installDir,
          stdio,
          env: heldCliLockValue ? { ...env, HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: heldCliLockValue } : env,
        });
      });
    }

    if (prepareComponentOutputs) {
      await ensureServerGeneratedProviderOutputs(componentDir, installDir, { quiet, env, pm });
    }
    return;
  }

  const installFirstRun = async (heldCliLockValue = null) => {
    if (!quiet) {
      // eslint-disable-next-line no-console
      console.log(`[local] installing ${label} dependencies (first run)...`);
    }
    await runPm(pm, installArgs, {
      cwd: installDir,
      stdio,
      env: heldCliLockValue ? { ...env, HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: heldCliLockValue } : env,
    });
  };
  if (pm.name === 'yarn') {
    await withDependencyRefresh(
      { installDir, componentDir, env, onDependenciesReady },
      async ({ heldCliLockValue }) => installFirstRun(heldCliLockValue),
    );
  } else {
    await installFirstRun();
  }
  await ensureServerGeneratedProviderOutputs(componentDir, installDir, { quiet, env, pm });
}

const stackWorkspaceBuildBoundary = {
  prepareEnv: preparePmEnv,
  runPackageBuild: async (packageDir, { env, quiet, timeoutMs }) => {
    const pm = await getComponentPm(packageDir, env);
    const stdio = quiet ? 'ignore' : 'inherit';
    if (pm.name === 'yarn') {
      await ensureYarnReady({ dir: packageDir, env, quiet, pm });
      await runPm(pm, ['-s', 'build'], {
        cwd: packageDir,
        stdio,
        env,
        timeoutMs,
        captureFailureDiagnostic: quiet,
      });
      return;
    }
    await runPm(pm, ['run', '-s', 'build'], {
      cwd: packageDir,
      stdio,
      env,
      timeoutMs,
      captureFailureDiagnostic: quiet,
    });
  },
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
  env,
  heldLockValue,
  lockPath,
  quiet,
  workspaceNames,
  includeRuntimeDependencies = true,
} = {}) {
  const sourceDevSyncModulePath = join(cliDir, 'scripts', 'buildSharedDeps.mjs');
  if (!(await pathExists(sourceDevSyncModulePath))) {
    return null;
  }
  const sourceDevSyncModule = await import(pathToFileURL(sourceDevSyncModulePath).href);
  if (typeof sourceDevSyncModule.syncSharedDepsForSourceDev !== 'function') {
    throw new Error(
      `Current CLI source-dev dependency owner is unavailable: ${sourceDevSyncModulePath}`,
    );
  }
  return await sourceDevSyncModule.syncSharedDepsForSourceDev({
    repoRoot,
    env,
    quiet,
    workspaceNames,
    includeRuntimeDependencies,
    lockOptions: {
      heldLockValue,
      lockPath,
    },
  });
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

export async function ensureCliBuilt(cliDir, { buildCli, quiet = false, env: envIn = process.env } = {}) {
  const distEntrypoint = join(cliDir, 'dist', 'index.mjs');
  const invocationDistFreshness = await readUsableCliDistFreshness(distEntrypoint);
  const invocationInputFreshness = await readHappyCliRuntimeInputFreshness(cliDir);
  const repoRoot = coerceHappyMonorepoRootFromPath(cliDir);
  const lockPath = repoRoot
    ? resolveCliDistBuildLockPath(repoRoot)
    : join(cliDir, '.dist.hstack-build.lock');
  await ensureDepsInstalled(cliDir, 'happier-cli', { quiet, env: envIn });

  return await withCliDistBuildLock(async ({ heldLockValue }) => {
    const prepareWorkspaceOutputs = async () => {
      const workspacePreparation = await ensureWorkspacePackagesBuiltForComponent(
        cliDir,
        { quiet, env: envIn },
      );
      let sourceDevPreparation = null;
      if (repoRoot) {
        sourceDevPreparation = await syncSharedDepsForSourceDev(repoRoot, {
          cliDir,
          env: envIn,
          heldLockValue,
          lockPath,
          quiet,
        });
      }
      return { workspacePreparation, sourceDevPreparation };
    };
    const skipAfterWorkspacePreparation = async (result) => {
      await prepareWorkspaceOutputs();
      return result;
    };
    if (!buildCli) {
      return await skipAfterWorkspacePreparation({ built: false, reason: 'disabled' });
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
          () => skipAfterWorkspacePreparation({ built: false, current: false, reason: 'mode_never' }),
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
        const preparation = await completeWithReleaseBackupRollback(
          prepareWorkspaceOutputs,
          { retainReleaseBackupOnSuccess: true },
        );
        if (
          preparation.workspacePreparation.built.length === 0
          && preparation.sourceDevPreparation?.synced !== true
        ) {
          await discardReleaseBackup();
          return { built: false, current: true, reason: 'up_to_date' };
        }
        // Rebuilt workspace outputs or a refreshed source-dev bundle change the
        // inputs consumed by pkgroll without changing the CLI source fingerprint.
        // Run the full Yarn lifecycle before admitting this CLI publication.
      }
    }

    return await completeWithReleaseBackupRollback(async () => {
      const env = await preparePmEnv(cliDir, envIn);
      await repairCorruptedCliPkgrollInstallIfNeeded(cliDir, { quiet, env });
      const pm = await getComponentPm(cliDir, env);
      const buildEnv = {
        ...env,
        HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: heldLockValue,
        ...(inputFreshness?.fingerprint
          ? { HAPPIER_CLI_BUILD_INPUT_FINGERPRINT: inputFreshness.fingerprint }
          : {}),
      };
      await runPm(pm, ['build'], {
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
            `  cd "${cliDir}" && ${formatPmCommand(pm, ['build'])}`
        );
      }

      if (await readUsableCliDistFreshness(distEntrypoint) === null) {
        const integrity = readCliDistIntegrity(distEntrypoint);
        throw new Error(`[local] happier-cli dist build is not usable: ${integrity.reason}`);
      }
      await probeCliDistRuntimeImport(distEntrypoint, { cwd: cliDir, env: buildEnv });

      const nowFreshness = await readHappyCliRuntimeInputFreshness(cliDir);
      // The canonical Yarn prebuild may publish generated CLI source before
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
  if (pm.name === 'yarn') {
    await ensureYarnReady({ dir, env, quiet, pm });
  }
  await runPm(pm, ['run', bin, ...args], { cwd: dir, env, stdio });
}

export function applyStackInfraProcessKind(env) {
  if (!(env.HAPPIER_STACK_ENV_FILE ?? '').toString().trim()) {
    return env;
  }
  return { ...env, HAPPIER_STACK_PROCESS_KIND: 'infra' };
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
  if (pm.name === 'yarn') {
    await ensureYarnReady({ dir: componentDir, env: effectiveEnv, quiet, pm });
  }
  const envForChild = applyStackInfraProcessKind(effectiveEnv);
  return spawnPm(componentLabel, pm, ['run', componentBin, ...componentArgs], envForChild, { cwd: componentDir, ...options });
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
  if (pm.name === 'yarn') {
    await ensureYarnReady({ dir: componentDir, env: effectiveEnv, quiet, pm });
  }
  const envForChild = applyStackInfraProcessKind(effectiveEnv);
  return spawnPm(componentLabel, pm, ['run', componentScript, ...componentArgs], envForChild, { cwd: componentDir, ...options });
}
