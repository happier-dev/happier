import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, readFile, readdir, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises';

import { pathExists } from '../fs/fs.mjs';
import { run, spawnProc } from './proc.mjs';
import { commandExists } from './commands.mjs';
import {
  coerceHappyMonorepoRootFromPath,
  getDefaultAutostartPaths,
  getHappyStacksHomeDir,
  resolveExplicitStackEnvFilePath,
} from '../paths/paths.mjs';
import { resolveInstalledPath, resolveInstalledCliRoot } from '../paths/runtime.mjs';
import { expandHome } from '../paths/canonical_home.mjs';
import { withCliDistBuildLock } from './cliDistBuildLock.mjs';
import { withDependencyRefresh } from './dependency_refresh.mjs';
import { probeCliDistRuntimeImport, readCliDistIntegrity } from '../cli/cliDistIntegrity.mjs';
import { resolveHappyCliRuntimeInputPaths } from './cli_runtime_inputs.mjs';
import { isDevRuntimeReloadIgnoredPath } from '../dev/devRuntimeInputPolicy.mjs';

export { isCliDistBuildLockActive } from './cliDistBuildLock.mjs';
import {
  ensureWorkspacePackagesBuiltByName as ensureWorkspacePackagesBuiltByNameOwner,
  ensureWorkspacePackagesBuiltForComponent as ensureWorkspacePackagesBuiltForComponentOwner,
} from '../../../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs';

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

function applyStackInfraProcessKind(env) {
  const effectiveEnv = env && typeof env === 'object' ? env : {};
  return (effectiveEnv.HAPPIER_STACK_ENV_FILE ?? '').toString().trim()
    ? { ...effectiveEnv, HAPPIER_STACK_PROCESS_KIND: 'infra' }
    : effectiveEnv;
}

function extractLocalImportSpecifiersFromJs(text) {
  const src = String(text ?? '');
  const out = new Set();

  // import './x.mjs'
  const reBareImport = /^\s*import\s+["'](\.\/[^"']+|\.\.\/[^"']+)["']/gm;
  for (;;) {
    const match = reBareImport.exec(src);
    if (!match) break;
    const spec = String(match[1] ?? '').trim();
    if (!spec) continue;
    out.add(spec);
  }

  // import x from './x.mjs'
  // export * from './x.mjs'
  const reFromImport = /^\s*(?:import|export)\b[\s\w{},*]*?\bfrom\s+["'](\.\/[^"']+|\.\.\/[^"']+)["']/gm;
  for (;;) {
    const match = reFromImport.exec(src);
    if (!match) break;
    const spec = String(match[1] ?? '').trim();
    if (!spec) continue;
    out.add(spec);
  }

  return Array.from(out);
}

async function assertNoMissingLocalImports({ distDir, entryPath, label = 'dist build' }) {
  const root = resolve(distDir);
  const entry = resolve(entryPath);

  const visited = new Set();
  const queue = [entry];
  const missing = [];

  while (queue.length) {
    const current = queue.shift();
    if (!current) continue;
    const abs = resolve(current);
    if (visited.has(abs)) continue;
    visited.add(abs);

    let contents = '';
    try {
      contents = await readFile(abs, 'utf-8');
    } catch {
      // If we can't read a file that exists, something is deeply wrong; surface it as missing.
      missing.push({ from: abs, spec: '(unreadable)' });
      continue;
    }

    for (const spec of extractLocalImportSpecifiersFromJs(contents)) {
      const resolvedImport = resolve(dirname(abs), spec);
      if (!(await pathExists(resolvedImport))) {
        missing.push({ from: abs, spec });
        continue;
      }
      // Only traverse within dist/ to avoid reading arbitrary local files.
      if (resolvedImport === root || resolvedImport.startsWith(root + sep)) {
        if (!visited.has(resolvedImport)) queue.push(resolvedImport);
      }
    }

    // Keep this bounded: if dist explodes unexpectedly, fail-fast rather than hanging dev/watch.
    if (visited.size > 5_000) {
      throw new Error(`[local] dist import graph too large while validating ${entryPath} (visited=${visited.size})`);
    }
  }

  if (missing.length) {
    const preview = missing
      .slice(0, 8)
      .map((m) => `- ${m.spec} (from ${m.from})`)
      .join('\n');
    throw new Error(
      `[local] ${label} looks partial (missing local imports).\n` +
        `Entrypoint: ${entryPath}\n` +
        `Missing (${missing.length}):\n${preview}`,
    );
  }
}

async function readCliRuntimeInputFreshness(dir) {
  let newestMtimeNs = null;

  const visit = async (path) => {
    if (isDevRuntimeReloadIgnoredPath(path)) return;
    let fileStat;
    try {
      fileStat = await lstat(path, { bigint: true });
    } catch {
      return;
    }
    newestMtimeNs = newestMtimeNs === null || fileStat.mtimeNs > newestMtimeNs
      ? fileStat.mtimeNs
      : newestMtimeNs;
    if (!fileStat.isDirectory()) return;
    let names;
    try {
      names = await readdir(path);
    } catch {
      return;
    }
    for (const name of names) {
      await visit(join(path, name));
    }
  };

  try {
    for (const path of resolveHappyCliRuntimeInputPaths({ cliDir: dir })) {
      await visit(path);
    }
  } catch {
    return null;
  }
  return newestMtimeNs;
}

async function readUsableCliDistFreshness(distEntrypoint) {
  const integrity = readCliDistIntegrity(distEntrypoint);
  if (!integrity.ok || !integrity.manifestPath) return null;
  try {
    const entryStat = await stat(distEntrypoint, { bigint: true });
    if (!entryStat.isFile() || entryStat.size === 0n) return null;
    await assertNoMissingLocalImports({ distDir: dirname(distEntrypoint), entryPath: distEntrypoint });
    const manifestStat = await stat(integrity.manifestPath, { bigint: true });
    return manifestStat.mtimeNs;
  } catch {
    return null;
  }
}

async function isCliDistFreshForInputs(distEntrypoint, inputFreshness) {
  const distFreshness = await readUsableCliDistFreshness(distEntrypoint);
  if (distFreshness === null) return false;
  return inputFreshness === null || inputFreshness <= distFreshness;
}

async function getComponentPm(dir, env = process.env) {
  const happyMonorepoRoot = await (async () => {
    try {
      return coerceHappyMonorepoRootFromPath(dir);
    } catch {
      return null;
    }
  })();
  void happyMonorepoRoot;

  // IMPORTANT: probe yarn with cwd=componentDir; yarn can be blocked depending on Corepack context.
  if (await commandExists('yarn', { cwd: dir, env })) {
    return { name: 'yarn', cmd: 'yarn', prefixArgs: [] };
  }

  const binaryMode = String(env.HAPPIER_STACK_BINARY_MODE ?? '').trim() === '1'
    || String(env.HAPPIER_STACK_INSTALL_SOURCE ?? '').trim() === 'binary';
  if (binaryMode && (await commandExists('npm', { cwd: dir, env }))) {
    return { name: 'npm', cmd: 'npm', prefixArgs: [] };
  }

  if (await commandExists('corepack', { cwd: dir, env })) {
    return { name: 'yarn', cmd: 'corepack', prefixArgs: ['yarn'] };
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
  if (typeof env.REDISMS_DISABLE_POSTINSTALL === 'undefined') {
    // redis-memory-server only uses postinstall to prefetch binaries; skipping it avoids making
    // stack-managed dependency refreshes depend on local Redis build prerequisites.
    env.REDISMS_DISABLE_POSTINSTALL = '1';
  }
  const preferredNodeBinDir = await resolvePreferredNodeBinDir(dir, env);
  if (preferredNodeBinDir) {
    prependPathEntry(env, preferredNodeBinDir);
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

  const requiredOutputs = [
    join(installDir, 'node_modules', '.prisma', 'client', 'default.js'),
    join(componentDir, 'generated', 'sqlite-client', 'index.js'),
  ];
  if (requiredOutputs.every((outputPath) => existsSync(outputPath))) {
    return;
  }

  const env = pmIn
    ? (envIn ?? process.env)
    : await preparePmEnv(installDir, envIn ?? process.env);
  const pm = pmIn ?? await getComponentPm(installDir, env);
  const stdio = quiet ? 'ignore' : 'inherit';
  if (!quiet) {
    // eslint-disable-next-line no-console
    console.log('[local] generating happier-server Prisma provider outputs...');
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
  const key = `${resolve(dir)}|${String(e.HOME ?? '')}|${String(e.XDG_CACHE_HOME ?? '')}`;
  if (_yarnReadyKeys.has(key)) return;

  const stdio = quiet ? 'ignore' : 'inherit';
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
      return resolve(expandHome(explicit, env));
    } catch {
      return null;
    }
  }
  const envFile = resolveExplicitStackEnvFilePath(env);
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

  const envFile = resolveExplicitStackEnvFilePath(env);
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

export function resolveDependencyInstallRoot(componentDir) {
  const monorepoRoot = coerceHappyMonorepoRootFromPath(componentDir);
  if (!monorepoRoot) return componentDir;
  return existsSync(join(monorepoRoot, 'package.json')) ? monorepoRoot : componentDir;
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

export async function ensureDepsInstalled(dir, label, { quiet = false, env: envIn = process.env } = {}) {
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
  const installArgs = pm.name === 'yarn' ? ['install', '--production=false'] : ['install'];

  if (await pathExists(nodeModules)) {
    const skipRefresh =
      String(env?.HAPPIER_STACK_SKIP_REFRESH_DEPS ?? '').trim() === '1' ||
      String(env?.HAPPIER_STACK_DISABLE_REFRESH_DEPS ?? '').trim() === '1';
    if (skipRefresh) {
      await ensureServerGeneratedProviderOutputs(componentDir, installDir, { quiet, env, pm });
      return;
    }

    // In service contexts (launchd/systemd), avoid doing surprise dependency refreshes just because
    // files changed on disk. This keeps long-running stacks resilient even if the checkout becomes
    // temporarily un-buildable (e.g. mid-rebase / failing typecheck).
    const allowRefresh =
      String(env?.HAPPIER_STACK_SERVICE_ALLOW_REFRESH_DEPS ?? '').trim() === '1' ||
      String(env?.HAPPIER_STACK_ALLOW_REFRESH_DEPS ?? '').trim() === '1';
    if (isServiceMode(env) && !allowRefresh) {
      await ensureServerGeneratedProviderOutputs(componentDir, installDir, { quiet, env, pm });
      return;
    }

    // Yarn workspaces keep yarn.lock at the monorepo root. If invoked from a workspace directory,
    // we must read lock/integrity from the root; otherwise "deps changed" detection silently breaks
    // (because apps/* typically has no yarn.lock, and node_modules is often nohoisted).
    if (pm.name === 'yarn') {
      await withDependencyRefresh({ installDir, componentDir, env }, async ({ heldCliLockValue }) => {
        if (!quiet) {
          // eslint-disable-next-line no-console
          console.log(`[local] refreshing ${label} dependencies (yarn.lock/package.json/workspace package.json/patches changed)...`);
        }
        await runPm(pm, installArgs, {
          cwd: installDir,
          stdio,
          env: heldCliLockValue
            ? { ...env, HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: heldCliLockValue }
            : env,
        });
      });
    }

    await ensureServerGeneratedProviderOutputs(componentDir, installDir, { quiet, env, pm });
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
      env: heldCliLockValue
        ? { ...env, HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: heldCliLockValue }
        : env,
    });
  };
  if (pm.name === 'yarn') {
    await withDependencyRefresh({ installDir, componentDir, env }, async ({ heldCliLockValue }) => {
      await installFirstRun(heldCliLockValue);
    });
  } else {
    await installFirstRun();
  }
  await ensureServerGeneratedProviderOutputs(componentDir, installDir, { quiet, env, pm });
}

const stackWorkspaceBuildBoundary = {
  prepareEnv: preparePmEnv,
  runPackageBuild: async (pkgDir, { env, quiet }) => {
    const pm = await getComponentPm(pkgDir, env);
    const stdio = quiet ? 'ignore' : 'inherit';
    if (pm.name === 'yarn') {
      await ensureYarnReady({ dir: pkgDir, env, quiet, pm });
      await runPm(pm, ['-s', 'build'], { cwd: pkgDir, stdio, env });
      return;
    }
    await runPm(pm, ['run', '-s', 'build'], { cwd: pkgDir, stdio, env });
  },
};

export async function ensureWorkspacePackagesBuiltByName(monorepoPath, packageNames, options = {}) {
  return await ensureWorkspacePackagesBuiltByNameOwner(monorepoPath, packageNames, {
    ...options,
    workspaceBuildBoundary: stackWorkspaceBuildBoundary,
  });
}

export async function ensureWorkspacePackagesBuiltForComponent(componentDir, options = {}) {
  return await ensureWorkspacePackagesBuiltForComponentOwner(componentDir, {
    ...options,
    workspaceBuildBoundary: stackWorkspaceBuildBoundary,
  });
}

export async function ensureCliBuilt(cliDir, { buildCli, quiet = false, env: envIn = process.env } = {}) {
  const invocationInputFreshness = await readCliRuntimeInputFreshness(cliDir);
  const distEntrypoint = join(cliDir, 'dist', 'index.mjs');
  const invocationDistFreshness = await readUsableCliDistFreshness(distEntrypoint);
  const repoRoot = coerceHappyMonorepoRootFromPath(cliDir);
  const lockPath = repoRoot
    ? join(repoRoot, '.project', 'tmp', 'cli-dist-build.lock')
    : join(cliDir, '.dist.hstack-build.lock');
  await ensureDepsInstalled(cliDir, 'happier-cli', { quiet, env: envIn });

  return await withCliDistBuildLock(async ({ heldLockValue }) => {
    const skip = (reason, current = false) => {
      if (!quiet) {
        // eslint-disable-next-line no-console
        console.log(`[local] happier-cli build skipped (${reason}).`);
      }
      return { built: false, current, reason };
    };
    // A full CLI build owns shared dependency compilation through Yarn's automatic
    // prebuild -> build:shared lifecycle. Only repair shared outputs separately when
    // this admission will trust an existing CLI dist without running that lifecycle.
    const prepareWorkspaceOutputs = async () =>
      await ensureWorkspacePackagesBuiltForComponent(cliDir, { quiet, env: envIn });
    const skipAfterWorkspacePreparation = async (reason, current = false) => {
      await prepareWorkspaceOutputs();
      return skip(reason, current);
    };
    if (!buildCli) {
      return await skipAfterWorkspacePreparation('disabled');
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
    const legacyDistBackupDir = join(cliDir, '.dist.hstack-backup');
    const inputFreshness = await readCliRuntimeInputFreshness(cliDir);
    const currentDistFreshness = await readUsableCliDistFreshness(distEntrypoint);
    const buildCompletedSinceInvocation = currentDistFreshness !== invocationDistFreshness;
    const inputsChangedWhileWaiting = invocationInputFreshness !== null
      && inputFreshness !== null
      && invocationInputFreshness !== inputFreshness;

    await rm(legacyDistBackupDir, { recursive: true, force: true }).catch(() => {});

    if (buildCompletedSinceInvocation) {
      if (!inputsChangedWhileWaiting && await isCliDistFreshForInputs(distEntrypoint, inputFreshness)) {
        return skip('concurrent_build_already_completed', true);
      }
      return skip('concurrent_build_superseded', false);
    }

    // "never" should prevent rebuild churn, but it must not make the stack unrunnable.
    // If the dist entrypoint is missing, build once even in "never" mode.
    if (mode === 'never') {
      if (await readUsableCliDistFreshness(distEntrypoint) !== null) {
        return await skipAfterWorkspacePreparation('mode_never');
      }
      // fallthrough to build
    }

    if (mode === 'auto') {
      // If dist doesn't exist, we must build.
      if (inputsChangedWhileWaiting) {
        // A build completed while this caller waited, but its inputs moved during that
        // transaction. Rebuild from the latest observed inputs instead of admitting it.
      } else if (!(await pathExists(distEntrypoint))) {
        // fallthrough to build
      } else if (await isCliDistFreshForInputs(distEntrypoint, inputFreshness)) {
        const workspacePreparation = await prepareWorkspaceOutputs();
        if (workspacePreparation.built.length === 0) {
          return skip('up_to_date', true);
        }
        // A repaired dependency changes the inputs consumed by the CLI bundle even
        // when its source mtimes predate the current CLI publication. Run the full
        // Yarn lifecycle so prebuild syncs those outputs before publishing the CLI.
      }
    }

    const env = await preparePmEnv(cliDir, envIn);
    const pm = await getComponentPm(cliDir, env);
    // The CLI build owns staging, generation-CAS, manifest publication, and atomic dist promotion.
    // Stack orchestration must not wrap it in a second temp/swap owner; it validates the published
    // generation before any daemon activation instead.
    const buildEnv = {
      ...env,
      // The stack lock covers the cache decision and the delegated CLI build as one transaction.
      // The CLI build owner authenticates this exact owner lease and must not reacquire its
      // parent's live lock in the child process.
      HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: heldLockValue,
    };
    await runPm(pm, ['build'], { cwd: cliDir, env: buildEnv, stdio: quiet ? 'ignore' : 'inherit' });

    if (!(await pathExists(distEntrypoint))) {
      throw new Error(
        `[local] happier-cli build finished but did not produce expected entrypoint.\n` +
          `Expected: ${distEntrypoint}\n` +
          `Fix: run the component build directly and inspect its output:\n` +
          `  cd "${cliDir}" && ${pm.cmd} build`
      );
    }

    await assertNoMissingLocalImports({ distDir, entryPath: distEntrypoint });
    if (await readUsableCliDistFreshness(distEntrypoint) === null) {
      const integrity = readCliDistIntegrity(distEntrypoint);
      throw new Error(`[local] happier-cli dist build is not usable: ${integrity.reason}`);
    }
    await probeCliDistRuntimeImport(distEntrypoint, { cwd: cliDir, env: buildEnv });

    const nowFreshness = await readCliRuntimeInputFreshness(cliDir);
    const inputsStayedCurrent = inputFreshness === null
      ? nowFreshness === null
      : nowFreshness === inputFreshness;
    return inputsStayedCurrent
      ? { built: true, current: true, reason: mode === 'always' ? 'mode_always' : 'changed' }
      : { built: true, current: false, reason: 'inputs_changed_during_build' };
  }, { lockPath });
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
