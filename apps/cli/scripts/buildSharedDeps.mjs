import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { syncBundledWorkspacePackages } from '../../../scripts/workspaces/syncBundledWorkspacePackages.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function serializeBuildLockOwner(createdAtMs) {
  return JSON.stringify({ pid: process.pid, createdAtMs });
}

function parseBuildLockOwner(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { pid: null, createdAtMs: null };

  try {
    const parsed = JSON.parse(text);
    return {
      pid: typeof parsed.pid === 'number' && Number.isFinite(parsed.pid) && parsed.pid > 0 ? parsed.pid : null,
      createdAtMs:
        typeof parsed.createdAtMs === 'number' && Number.isFinite(parsed.createdAtMs) && parsed.createdAtMs > 0
          ? parsed.createdAtMs
          : null,
    };
  } catch {
    return { pid: null, createdAtMs: null };
  }
}

function isRunningPid(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ESRCH') return false;
    return true;
  }
}

function shouldReclaimBuildLock(lockPath, staleAfterMs, nowMs) {
  try {
    const owner = parseBuildLockOwner(readFileSync(lockPath, 'utf8'));
    if (owner.pid == null && owner.createdAtMs == null) return true;
    if (owner.pid != null && !isRunningPid(owner.pid)) return true;
    if (owner.createdAtMs != null && nowMs - owner.createdAtMs > staleAfterMs) return true;
  } catch {
    return true;
  }
  return false;
}

export async function withBuildSharedDepsLock(fn, options = {}) {
  const lockPath = options.lockPath ?? DEFAULT_BUILD_LOCK_PATH;
  mkdirSync(dirname(lockPath), { recursive: true });

  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? 240_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const staleAfterMs = options.staleAfterMs ?? timeoutMs;

  let fd = null;
  let heartbeatTimer = null;
  while (true) {
    try {
      fd = openSync(lockPath, 'wx');
      writeFileSync(fd, serializeBuildLockOwner(Date.now()), 'utf8');
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (shouldReclaimBuildLock(lockPath, staleAfterMs, Date.now())) {
        try {
          unlinkSync(lockPath);
        } catch {
          // ignore
        }
        continue;
      }
      if (Date.now() - startedAt > timeoutMs) {
        const owner = parseBuildLockOwner(readFileSync(lockPath, 'utf8'));
        const ownerLabel =
          owner.pid != null
            ? `pid=${owner.pid}, createdAtMs=${owner.createdAtMs ?? 'unknown'}`
            : owner.createdAtMs != null
              ? `createdAtMs=${owner.createdAtMs}`
              : 'unknown owner';
        throw new Error(`Timed out waiting for shared deps build lock: ${lockPath} (${ownerLabel})`);
      }
      await sleep(pollIntervalMs);
    }
  }

  try {
    if (staleAfterMs > 0) {
      const heartbeatIntervalMs = Math.max(250, Math.min(5_000, Math.floor(staleAfterMs / 4) || 250));
      heartbeatTimer = setInterval(() => {
        try {
          writeFileSync(lockPath, serializeBuildLockOwner(Date.now()), 'utf8');
        } catch {
          // Best-effort lease heartbeat only.
        }
      }, heartbeatIntervalMs);
      heartbeatTimer.unref();
    }

    return await fn();
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    try {
      if (fd != null) closeSync(fd);
    } catch {
      // ignore
    }
    try {
      unlinkSync(lockPath);
    } catch {
      // ignore
    }
  }
}

function findRepoRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, 'package.json')) && existsSync(resolve(dir, 'yarn.lock'))) {
      return dir;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback for older layouts (repoRoot/apps/cli/scripts).
  return resolve(startDir, '..', '..', '..');
}

const repoRoot = findRepoRoot(__dirname);
const DEFAULT_BUILD_LOCK_PATH = resolve(repoRoot, '.project', 'tmp', 'cli-shared-deps-build.lock');

function execYarn(args, options) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath) {
    return execFileSync(process.execPath, [npmExecPath, ...args], options);
  }
  return execFileSync(process.platform === 'win32' ? 'yarn.cmd' : 'yarn', args, options);
}

async function loadCliCommonWorkspacesModule() {
  const modulePath = resolve(repoRoot, 'packages', 'cli-common', 'dist', 'workspaces', 'index.js');

  if (!existsSync(modulePath)) {
    // `build:shared` is invoked by tests/e2e harnesses that may not have pre-built workspace packages.
    // Ensure `@happier-dev/cli-common` is compiled before importing its build helpers.
    execYarn(['-s', 'workspace', '@happier-dev/cli-common', 'build'], { cwd: repoRoot, stdio: 'inherit' });
  }

  if (!existsSync(modulePath)) {
    throw new Error(`Missing cli-common workspaces build helpers: ${modulePath}`);
  }

  return await import(pathToFileURL(modulePath).href);
}

const {
  bundleInstalledPackageWithRuntimeDependencies,
  resolveWorkspaceBundlesFromPackageJson,
  vendorBundledPackageRuntimeDependencies,
} = await loadCliCommonWorkspacesModule();
const CLI_BUNDLED_HOST_APPS = ['cli'];
const CLI_SHARED_WORKSPACE_BUILD_ORDER = [
  'agents',
  'cli-common',
  'connection-supervisor',
  'protocol',
  'transfers',
  'release-runtime',
];

function resolveBundledWorkspacePackageNameFromSrcDir(srcDir) {
  const normalized = String(srcDir ?? '');
  const marker = `${resolve(repoRoot, 'packages')}/`;
  if (!normalized.startsWith(marker)) return null;
  const rest = normalized.slice(marker.length);
  const name = rest.split('/')[0] ?? '';
  return name.trim() || null;
}

function resolveCliBundledWorkspacePackageNames({ exists = existsSync } = {}) {
  const bundles = resolveWorkspaceBundlesFromPackageJson({
    repoRoot,
    hostPackageDir: resolve(repoRoot, 'apps', 'cli'),
  });

  const names = [];
  for (const bundle of bundles) {
    const name = resolveBundledWorkspacePackageNameFromSrcDir(bundle.srcDir);
    if (name) names.push(name);
  }

  // Keep a stable, intention-revealing build order while still deriving the set from the actual bundles.
  const derived = Array.from(new Set(names));
  const indexByName = new Map(CLI_SHARED_WORKSPACE_BUILD_ORDER.map((name, index) => [name, index]));
  derived.sort((left, right) => {
    const li = indexByName.get(left);
    const ri = indexByName.get(right);
    if (li == null && ri == null) return left.localeCompare(right);
    if (li == null) return 1;
    if (ri == null) return -1;
    return li - ri;
  });

  // Only build packages that look like real repo workspaces.
  return derived.filter((name) => exists(resolve(repoRoot, 'packages', name, 'tsconfig.json')));
}

export function resolveTscBin({ exists } = {}) {
  const existsImpl = exists ?? existsSync;
  const isWindows = process.platform === 'win32';
  const binName = isWindows ? 'tsc.cmd' : 'tsc';
  const candidates = isWindows
    ? [
        // Windows: prefer cmd shims when present.
        resolve(repoRoot, 'node_modules', '.bin', binName),
        resolve(repoRoot, 'cli', 'node_modules', '.bin', binName),
        // Fallback: allow executing the JS entry via Node if shims are missing.
        resolve(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
        resolve(repoRoot, 'cli', 'node_modules', 'typescript', 'bin', 'tsc'),
      ]
    : [
        // Prefer the real TypeScript entrypoint over node_modules/.bin symlinks.
        // On macOS, workspace-hoisted `.bin/*` symlinks can intermittently fail with ENOENT.
        resolve(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
        resolve(repoRoot, 'cli', 'node_modules', 'typescript', 'bin', 'tsc'),
        resolve(repoRoot, 'node_modules', '.bin', binName),
        resolve(repoRoot, 'cli', 'node_modules', '.bin', binName),
      ];

  for (const candidate of candidates) {
    if (existsImpl(candidate)) return candidate;
  }

  return candidates[0];
}

const tscBin = resolveTscBin();

export function runTsc(tsconfigPath, opts) {
  const exec = opts?.execFileSync ?? execFileSync;
  const tsc = opts?.tscBin ?? tscBin;
  const platform = opts?.platform ?? process.platform;
  try {
    if (platform === 'win32' && (tsc.endsWith('.cmd') || tsc.endsWith('.bat'))) {
      const command = `"${tsc}" -p "${tsconfigPath}"`;
      exec('cmd.exe', ['/d', '/s', '/c', command], { stdio: 'inherit' });
    } else {
      // Execute tsc via Node to avoid `.bin/*` symlink spawn issues and shebang portability quirks.
      exec(process.execPath, [tsc, '-p', tsconfigPath], { stdio: 'inherit' });
    }
  } catch (error) {
    const suffix = tsconfigPath ? ` (${tsconfigPath})` : '';
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to compile shared workspace deps${suffix}: ${message}`);
  }
}

export function syncBundledWorkspaceDist(opts = {}) {
  const repoRootArg = opts.repoRoot;
  const repoRoot = typeof repoRootArg === 'string' && repoRootArg.trim() ? repoRootArg : findRepoRoot(__dirname);
  syncBundledWorkspacePackages({
    repoRoot,
    hostApps: Array.isArray(opts.bundledHostApps) && opts.bundledHostApps.length > 0 ? opts.bundledHostApps : CLI_BUNDLED_HOST_APPS,
    existsSync: opts.existsSync,
    cpSync: opts.cpSync,
    mkdirSync: opts.mkdirSync,
    rmSync: opts.rmSync,
    readFileSync: opts.readFileSync,
    writeFileSync: opts.writeFileSync,
  });
}

export function syncCliRuntimeDependencies(opts = {}) {
  const repoRootArg = opts.repoRoot;
  const repoRoot = typeof repoRootArg === 'string' && repoRootArg.trim() ? repoRootArg : findRepoRoot(__dirname);
  const cliPackageJsonPath = resolve(repoRoot, 'apps', 'cli', 'package.json');
  const cliNodeModulesDir = resolve(repoRoot, 'apps', 'cli', 'node_modules');
  const cliRequire = createRequire(pathToFileURL(cliPackageJsonPath).href);
  const resolvedTweetnaclEntry = cliRequire.resolve('tweetnacl');
  const resolvedTweetnaclDir = dirname(resolvedTweetnaclEntry);

  if (resolvedTweetnaclDir === resolve(cliNodeModulesDir, 'tweetnacl')) {
    return;
  }

  bundleInstalledPackageWithRuntimeDependencies({
    packageName: 'tweetnacl',
    resolveFromPackageJsonPath: cliPackageJsonPath,
    destNodeModulesDir: cliNodeModulesDir,
  });
}

export function syncBundledWorkspaceRuntimeDependencies(opts = {}) {
  const repoRootArg = opts.repoRoot;
  const repoRoot = typeof repoRootArg === 'string' && repoRootArg.trim() ? repoRootArg : findRepoRoot(__dirname);
  const bundles = resolveWorkspaceBundlesFromPackageJson({
    repoRoot,
    hostPackageDir: resolve(repoRoot, 'apps', 'cli'),
  });

  for (const bundle of bundles) {
    vendorBundledPackageRuntimeDependencies({
      srcPackageJsonPath: resolve(bundle.srcDir, 'package.json'),
      destPackageDir: bundle.destDir,
    });
  }
}

export function main() {
  return withBuildSharedDepsLock(async () => {
    const bundledWorkspaceNames = resolveCliBundledWorkspacePackageNames();
    for (const name of bundledWorkspaceNames) {
      runTsc(resolve(repoRoot, 'packages', name, 'tsconfig.json'));
    }

    const protocolDist = resolve(repoRoot, 'packages', 'protocol', 'dist', 'index.js');
    if (!existsSync(protocolDist)) {
      throw new Error(`Expected @happier-dev/protocol build output missing: ${protocolDist}`);
    }

    // If the CLI currently has bundled workspace deps under apps/cli/node_modules,
    // keep their dist outputs in sync so local builds/tests do not consume stale artifacts.
    syncBundledWorkspaceDist({ repoRoot });
    syncBundledWorkspaceRuntimeDependencies({ repoRoot });
    syncCliRuntimeDependencies({ repoRoot });
  });
}

const invokedAsMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return import.meta.url === pathToFileURL(argv1).href;
})();

if (invokedAsMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
