import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

import { pathExists } from '../fs/fs.mjs';
import { readJsonIfExists, writeJsonAtomic } from '../fs/json.mjs';
import { run, runCapture, spawnProc } from './proc.mjs';
import { commandExists } from './commands.mjs';
import { coerceHappyMonorepoRootFromPath, getDefaultAutostartPaths, getHappyStacksHomeDir } from '../paths/paths.mjs';
import { resolveInstalledPath, resolveInstalledCliRoot } from '../paths/runtime.mjs';

function sha256Hex(s) {
  return createHash('sha256').update(String(s ?? ''), 'utf-8').digest('hex');
}

function resolveBuildStatePath({ label, dir }) {
  const homeDir = getHappyStacksHomeDir();
  const key = sha256Hex(resolve(dir));
  return join(homeDir, 'cache', 'build', label, `${key}.json`);
}

async function computeGitWorktreeSignature(dir) {
  try {
    // Fast path: only if this is a git worktree.
    const inside = (await runCapture('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'])).trim();
    if (inside !== 'true') return null;
    const head = (await runCapture('git', ['-C', dir, 'rev-parse', 'HEAD'])).trim();
    // Includes staged + unstaged + untracked changes; captures “dirty” vs “clean”.
    const status = await runCapture('git', ['-C', dir, 'status', '--porcelain=v1']);
    return {
      kind: 'git',
      head,
      statusHash: sha256Hex(status),
      signature: sha256Hex(`${head}\n${status}`),
    };
  } catch {
    return null;
  }
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
  if (!(await commandExists('yarn', { cwd: dir, env }))) {
    throw new Error(`[local] yarn is required for component at ${dir}. Install it via Corepack: \`corepack enable\``);
  }
  return { name: 'yarn', cmd: 'yarn' };
}

const _yarnReadyKeys = new Set();

async function ensureYarnReady({ dir, env, quiet = false }) {
  const e = env && typeof env === 'object' ? env : process.env;
  // In stack mode we isolate HOME/cache; key by effective HOME+XDG cache so we only do this once.
  const key = `${resolve(dir)}|${String(e.HOME ?? '')}|${String(e.XDG_CACHE_HOME ?? '')}`;
  if (_yarnReadyKeys.has(key)) return;

  // If stdin isn't a TTY (e.g. `happys tui ...` uses stdio:ignore for child stdin),
  // Corepack prompts can deadlock. Provide a single "yes" to unblock initial downloads.
  const isTui = (e.HAPPY_STACKS_TUI ?? '').toString().trim() === '1';
  // Also auto-yes in quiet mode so guided flows don't get stuck on:
  //   "Corepack is about to download ... Do you want to continue? [Y/n]"
  const autoYes = isTui || !process.stdin.isTTY || quiet;
  const stdio = quiet ? 'ignore' : 'inherit';
  await run('yarn', ['--version'], { cwd: dir, env: e, stdio, ...(autoYes ? { input: 'y\n' } : {}) });
  _yarnReadyKeys.add(key);
}

export async function requireDir(label, dir) {
  if (await pathExists(dir)) {
    return;
  }
  throw new Error(
    `[local] missing ${label} at ${dir}\n` +
      `Run: happys bootstrap (auto-clones missing components), or place the repo under components/`
  );
}

function resolveStackCacheBaseDirFromEnv(env) {
  const envFile = (env.HAPPY_STACKS_ENV_FILE ?? '').toString().trim();
  if (!envFile) return null;
  try {
    return join(dirname(envFile), 'cache');
  } catch {
    return null;
  }
}

export async function applyStackCacheEnv(baseEnv) {
  const env = { ...(baseEnv && typeof baseEnv === 'object' ? baseEnv : process.env) };
  const envFile = (env.HAPPY_STACKS_ENV_FILE ?? '').toString().trim();
  const stackCacheBase = resolveStackCacheBaseDirFromEnv(env);
  if (!stackCacheBase) return env;

  // Prisma engines currently default to ~/.cache/prisma (via os.homedir()).
  // In stack mode, isolate HOME for package-manager driven commands so Prisma/Yarn/NPM don't
  // depend on global home caches (and so sandboxed runs can succeed).
  const isolateHomeRaw = (env.HAPPY_STACKS_PM_ISOLATE_HOME ?? '').toString().trim();
  const isolateHome = isolateHomeRaw ? isolateHomeRaw !== '0' : true;
  if (isolateHome && envFile) {
    const stackHome = join(dirname(envFile), 'home');
    env.HOME = stackHome;
    env.USERPROFILE = stackHome;
    try {
      await mkdir(stackHome, { recursive: true });
    } catch {
      // best-effort
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

export async function ensureDepsInstalled(dir, label, { quiet = false, env: envIn = process.env } = {}) {
  const pkgJson = join(dir, 'package.json');
  if (!(await pathExists(pkgJson))) {
    return;
  }

  const nodeModules = join(dir, 'node_modules');
  const stdio = quiet ? 'ignore' : 'inherit';
  const env = await applyStackCacheEnv(envIn);
  const pm = await getComponentPm(dir, env);
  if (pm.name === 'yarn') {
    await ensureYarnReady({ dir, env, quiet });
  }

  if (await pathExists(nodeModules)) {
    const yarnLock = join(dir, 'yarn.lock');
    const yarnIntegrity = join(nodeModules, '.yarn-integrity');

    // If dependencies changed since the last install, re-run install even if node_modules exists.
    const mtimeMs = async (p) => {
      try {
        const s = await stat(p);
        return s.mtimeMs ?? 0;
      } catch {
        return 0;
      }
    };

    const patchesMtimeMs = async () => {
      // Happy's mobile app (and some other repos) use patch-package and keep patches under `patches/`.
      // If a patch file changes but yarn.lock/package.json do not, Yarn won't reinstall and
      // patch-package won't re-apply the patch, leading to confusing "why isn't my patch wired?"
      // failures later (e.g. during iOS pod install).
      const patchesDir = join(dir, 'patches');
      if (!(await pathExists(patchesDir))) return 0;
      try {
        const entries = await readdir(patchesDir, { withFileTypes: true });
        let max = 0;
        for (const e of entries) {
          if (!e.isFile()) continue;
          if (!e.name.endsWith('.patch')) continue;
          const m = await mtimeMs(join(patchesDir, e.name));
          if (m > max) max = m;
        }
        return max;
      } catch {
        return 0;
      }
    };

    if (pm.name === 'yarn' && (await pathExists(yarnLock))) {
      const lockM = await mtimeMs(yarnLock);
      const pkgM = await mtimeMs(pkgJson);
      const intM = await mtimeMs(yarnIntegrity);
      const patchM = await patchesMtimeMs();
      if (!intM || lockM > intM || pkgM > intM || patchM > intM) {
        if (!quiet) {
          // eslint-disable-next-line no-console
          console.log(`[local] refreshing ${label} dependencies (yarn.lock/package.json/patches changed)...`);
        }
        await run(pm.cmd, ['install'], { cwd: dir, stdio, env });
      }
    }

    return;
  }

  if (!quiet) {
    // eslint-disable-next-line no-console
    console.log(`[local] installing ${label} dependencies (first run)...`);
  }
  await run(pm.cmd, ['install'], { cwd: dir, stdio, env });
}

export async function ensureCliBuilt(cliDir, { buildCli, quiet = false, env: envIn = process.env } = {}) {
  await ensureDepsInstalled(cliDir, 'happy-cli', { quiet, env: envIn });
  if (!buildCli) {
    return { built: false, reason: 'disabled' };
  }
  // Default: build only when needed (fast + reliable for worktrees that haven't been built yet).
  //
  // You can force always-build by setting:
  // - HAPPY_STACKS_CLI_BUILD_MODE=always
  // Or disable via:
  // - HAPPY_STACKS_CLI_BUILD=0
  const modeRaw = (process.env.HAPPY_STACKS_CLI_BUILD_MODE ?? 'auto').trim().toLowerCase();
  const mode = modeRaw === 'always' || modeRaw === 'auto' || modeRaw === 'never' ? modeRaw : 'auto';
  const distEntrypoint = join(cliDir, 'dist', 'index.mjs');
  const buildStatePath = resolveBuildStatePath({ label: 'happy-cli', dir: cliDir });
  const gitSig = await computeGitWorktreeSignature(cliDir);
  const prev = await readJsonIfExists(buildStatePath);

  // "never" should prevent rebuild churn, but it must not make the stack unrunnable.
  // If the dist entrypoint is missing, build once even in "never" mode.
  if (mode === 'never') {
    if (await pathExists(distEntrypoint)) {
      return { built: false, reason: 'mode_never' };
    }
    // fallthrough to build
  }

  if (mode === 'auto') {
    // If dist doesn't exist, we must build.
    if (!(await pathExists(distEntrypoint))) {
      // fallthrough to build
    } else if (gitSig && prev?.signature && prev.signature === gitSig.signature) {
      return { built: false, reason: 'up_to_date' };
    } else if (!gitSig) {
      // No git info: best-effort skip if dist exists (keeps this fast outside git worktrees).
      return { built: false, reason: 'no_git_info' };
    }
  }

  if (!quiet) {
    // eslint-disable-next-line no-console
    console.log('[local] building happy-cli...');
  }
  const pm = await getComponentPm(cliDir, envIn);
  await run(pm.cmd, ['build'], { cwd: cliDir, env: envIn, stdio: quiet ? 'ignore' : 'inherit' });

  // Sanity check: happy-cli daemon entrypoint must exist after a successful build.
  // Without this, watch-based rebuilds can restart the daemon into a MODULE_NOT_FOUND crash,
  // which looks like the UI "dies out of nowhere" even though the root cause is missing build output.
  if (!(await pathExists(distEntrypoint))) {
    throw new Error(
      `[local] happy-cli build finished but did not produce expected entrypoint.\n` +
        `Expected: ${distEntrypoint}\n` +
        `Fix: run the component build directly and inspect its output:\n` +
        `  cd "${cliDir}" && ${pm.cmd} build`
    );
  }

  // Persist new build state (best-effort).
  const nowSig = gitSig ?? (await computeGitWorktreeSignature(cliDir));
  if (nowSig) {
    await writeJsonAtomic(buildStatePath, {
      label: 'happy-cli',
      dir: resolve(cliDir),
      signature: nowSig.signature,
      head: nowSig.head,
      statusHash: nowSig.statusHash,
      builtAt: new Date().toISOString(),
    }).catch(() => {});
  }
  return { built: true, reason: mode === 'always' ? 'mode_always' : 'changed' };
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

  const happysShim = join(binDir, 'happys');
  const happyShim = join(binDir, 'happy');

  const shim = `#!/bin/bash
set -euo pipefail
# Prefer the sibling happys shim (works for sandbox installs too).
BIN_DIR="$(cd "$(dirname "$0")" && pwd)"
HAPPYS="$BIN_DIR/happys"
if [[ -x "$HAPPYS" ]]; then
  exec "$HAPPYS" happy "$@"
fi

# Fallback: run happy-stacks from runtime install if present.
HOME_DIR="\${HAPPY_STACKS_HOME_DIR:-$HOME/.happier-stack}"
RUNTIME="$HOME_DIR/runtime/node_modules/happy-stacks/bin/happys.mjs"
if [[ -f "$RUNTIME" ]]; then
  exec node "$RUNTIME" happy "$@"
fi

echo "error: cannot find happys shim or runtime install" >&2
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

  await writeIfChanged(happyShim, shim);
  await chmod(happyShim, 0o755).catch(() => {});

  // happys shim: use node + CLI root; if runtime install exists, prefer it.
  const cliRoot = resolveInstalledCliRoot(rootDir);
  const happysShimText = `#!/bin/bash
set -euo pipefail
exec node "${resolveInstalledPath(rootDir, 'bin/happys.mjs')}" "$@"
`;
  await writeIfChanged(happysShim, happysShimText);
  await chmod(happysShim, 0o755).catch(() => {});

  // If user’s PATH points at a legacy install path, try to make it sane (best-effort).
  const entries = getPathEntries();
  const legacyBin = join(homedir(), '.happy-stacks', 'bin');
  const newBin = join(getDefaultAutostartPaths().baseDir, 'bin');
  if (entries.some((p) => isPathInside(p, legacyBin)) && !entries.some((p) => isPathInside(p, newBin))) {
    if (!quiet) {
      // eslint-disable-next-line no-console
      console.log(`[local] note: your PATH includes ${legacyBin}; recommended path is ${newBin}`);
    }
  }

  return { ok: true, cliRoot, binDir, happyShim, happysShim };
}

export async function pmExecBin(dirOrOpts, binArg, argsArg, optsArg) {
  const usesObjectStyle = typeof dirOrOpts === 'object' && dirOrOpts !== null;

  const dir = usesObjectStyle ? dirOrOpts.dir : dirOrOpts;
  const bin = usesObjectStyle ? dirOrOpts.bin : binArg;
  const args = usesObjectStyle ? (dirOrOpts.args ?? []) : (argsArg ?? []);

  const envIn = usesObjectStyle ? (dirOrOpts.env ?? process.env) : (optsArg?.env ?? process.env);
  const env = await applyStackCacheEnv(envIn);
  const quiet = usesObjectStyle ? Boolean(dirOrOpts.quiet) : Boolean(optsArg?.quiet);
  const stdio = quiet ? 'ignore' : 'inherit';

  const pm = await getComponentPm(dir, env);
  if (pm.name === 'yarn') {
    await ensureYarnReady({ dir, env, quiet });
  }
  await run(pm.cmd, ['run', bin, ...args], { cwd: dir, env, stdio });
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

  const effectiveEnv = await applyStackCacheEnv(componentEnv);
  const pm = await getComponentPm(componentDir, effectiveEnv);
  if (pm.name === 'yarn') {
    await ensureYarnReady({ dir: componentDir, env: effectiveEnv, quiet });
  }
  return spawnProc(componentLabel, pm.cmd, ['run', componentBin, ...componentArgs], effectiveEnv, { cwd: componentDir, ...options });
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

  const effectiveEnv = await applyStackCacheEnv(componentEnv);
  const pm = await getComponentPm(componentDir, effectiveEnv);
  if (pm.name === 'yarn') {
    await ensureYarnReady({ dir: componentDir, env: effectiveEnv, quiet });
  }
  return spawnProc(componentLabel, pm.cmd, ['run', componentScript, ...componentArgs], effectiveEnv, { cwd: componentDir, ...options });
}
