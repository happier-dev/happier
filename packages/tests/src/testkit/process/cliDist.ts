import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { repoRootDir } from '../paths';
import { sleep } from '../timing';
import { yarnCommand } from './commands';
import { runLoggedCommand } from './spawnProcess';

let _ensurePromise: Promise<string> | null = null;
let _ensureSharedPromise: Promise<void> | null = null;

type CliDistBuildLockOwner = {
  pid: number | null;
  createdAtMs: number | null;
};

type CliDistBuildLockOptions = {
  lockPath?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  staleAfterMs?: number;
};

type EnsureCliSharedDepsBuiltOptions = CliDistBuildLockOptions & {
  repoRoot?: string;
  runCommand?: (params: {
    command: string;
    args: string[];
    cwd: string;
    env?: NodeJS.ProcessEnv;
    stdoutPath: string;
    stderrPath: string;
    timeoutMs?: number;
  }) => Promise<void>;
};

type EnsureCliDistBuiltOptions = CliDistBuildLockOptions & {
  allowRebuild?: boolean;
  waitForAvailabilityMs?: number;
  repoRoot?: string;
  runCommand?: (params: {
    command: string;
    args: string[];
    cwd: string;
    env?: NodeJS.ProcessEnv;
    stdoutPath: string;
    stderrPath: string;
    timeoutMs?: number;
  }) => Promise<void>;
};

type CliDistBuildInvocation = {
  command: string;
  args: string[];
  cwd: string;
};

function describeCliDistBuildLockOwner(lockPath: string, nowMs: number): string {
  try {
    const owner = parseCliDistLockOwner(readFileSync(lockPath, 'utf8'));
    const ownerPid = owner.pid ?? 'unknown';
    const ownerAgeMs = owner.createdAtMs != null ? Math.max(0, nowMs - owner.createdAtMs) : 'unknown';
    return `ownerPid=${ownerPid} ownerAgeMs=${ownerAgeMs}`;
  } catch {
    return 'ownerPid=unknown ownerAgeMs=unknown';
  }
}

function isRunningPid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    if (error?.code === 'ESRCH') return false;
    return true;
  }
}

function parseCliDistLockOwner(raw: string): CliDistBuildLockOwner {
  const text = raw.trim();
  if (!text) return { pid: null, createdAtMs: null };

  if (/^\d+$/.test(text)) {
    return { pid: Number.parseInt(text, 10), createdAtMs: null };
  }

  try {
    const parsed = JSON.parse(text) as { pid?: unknown; createdAtMs?: unknown };
    const pid = typeof parsed.pid === 'number' && Number.isFinite(parsed.pid) && parsed.pid > 0 ? parsed.pid : null;
    const createdAtMs =
      typeof parsed.createdAtMs === 'number' && Number.isFinite(parsed.createdAtMs) && parsed.createdAtMs > 0
        ? parsed.createdAtMs
        : null;
    return { pid, createdAtMs };
  } catch {
    return { pid: null, createdAtMs: null };
  }
}

function shouldReclaimCliDistBuildLock(lockPath: string, staleAfterMs: number, nowMs: number): boolean {
  let owner: CliDistBuildLockOwner = { pid: null, createdAtMs: null };
  try {
    owner = parseCliDistLockOwner(readFileSync(lockPath, 'utf8'));
  } catch {
    return false;
  }

  if (owner.pid != null) {
    if (isRunningPid(owner.pid)) return false;
    try {
      unlinkSync(lockPath);
      return true;
    } catch {
      return false;
    }
  }

  if (owner.createdAtMs != null && nowMs - owner.createdAtMs <= staleAfterMs) {
    return false;
  }

  try {
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function findMissingDistChunkImports(distDir: string): string[] {
  // Sanity check: ensure local chunk imports resolve to files that exist on disk.
  // This catches partially-written dist folders (e.g. interrupted build) which otherwise cause
  // flaky provider E2E failures when the daemon executes bundled commands.
  let distFiles: string[] = [];
  try {
    distFiles = readdirSync(distDir).filter((f) => f.endsWith('.mjs'));
  } catch {
    return [];
  }

  const missing = new Set<string>();
  const importPatterns = [
    /import\(['"]\.\/([^'"]+\.mjs)['"]\)/g,
    /\bimport\s+['"]\.\/([^'"]+\.mjs)['"]/g,
    /\bimport\s+[^'"]+\s+from\s+['"]\.\/([^'"]+\.mjs)['"]/g,
    /\bexport\s+[^'"]+\s+from\s+['"]\.\/([^'"]+\.mjs)['"]/g,
  ];

  for (const f of distFiles) {
    let text = '';
    try {
      text = readFileSync(resolve(distDir, f), 'utf8');
    } catch {
      continue;
    }

    for (const pattern of importPatterns) {
      for (const match of text.matchAll(pattern)) {
        const rel = match[1];
        if (!rel) continue;
        if (!existsSync(resolve(distDir, rel))) missing.add(rel);
      }
    }
  }

  return [...missing].sort();
}

function resolveCliSharedDepsOutputPaths(rootDir: string): string[] {
  return [
    resolve(rootDir, 'packages', 'agents', 'dist', 'index.js'),
    resolve(rootDir, 'packages', 'cli-common', 'dist', 'index.js'),
    resolve(rootDir, 'packages', 'protocol', 'dist', 'index.js'),
  ];
}

function hasCliSharedDepsOutputs(rootDir: string): boolean {
  return resolveCliSharedDepsOutputPaths(rootDir).every((outputPath) => existsSync(outputPath));
}

export function resolveCliDistBuildInvocation(params: { repoRoot?: string } = {}): CliDistBuildInvocation {
  const rootDir = params.repoRoot ?? repoRootDir();
  const pkgrollBin = resolve(rootDir, 'node_modules', '.bin', process.platform === 'win32' ? 'pkgroll.cmd' : 'pkgroll');
  const cwd = resolve(rootDir, 'apps', 'cli');
  if (existsSync(pkgrollBin)) {
    return { command: pkgrollBin, args: [], cwd };
  }
  return { command: 'npx', args: ['pkgroll'], cwd };
}

export async function ensureCliSharedDepsBuilt(
  params: { testDir: string; env: NodeJS.ProcessEnv },
  options: EnsureCliSharedDepsBuiltOptions = {},
): Promise<void> {
  const rootDir = options.repoRoot ?? repoRootDir();
  if (_ensureSharedPromise) return await _ensureSharedPromise;

  const lockPath = options.lockPath ?? resolve(rootDir, '.project', 'tmp', 'cli-shared-deps-build.lock');
  _ensureSharedPromise = withCliDistBuildLock(
    async () => {
      if (hasCliSharedDepsOutputs(rootDir)) return;

      const runCommand = options.runCommand ?? runLoggedCommand;
      await runCommand({
        command: yarnCommand(),
        args: ['-s', 'workspace', '@happier-dev/cli', 'build:shared'],
        cwd: rootDir,
        env: { ...process.env, ...params.env, CI: '1' },
        stdoutPath: resolve(params.testDir, 'cli.buildShared.stdout.log'),
        stderrPath: resolve(params.testDir, 'cli.buildShared.stderr.log'),
        timeoutMs: 240_000,
      });

      if (!hasCliSharedDepsOutputs(rootDir)) {
        throw new Error(`Shared workspace deps output missing after build: ${resolve(rootDir, 'packages')}`);
      }
    },
    {
      lockPath,
      timeoutMs: options.timeoutMs,
      pollIntervalMs: options.pollIntervalMs,
      staleAfterMs: options.staleAfterMs,
    },
  );

  try {
    return await _ensureSharedPromise;
  } finally {
    _ensureSharedPromise = null;
  }
}

export async function withCliDistBuildLock<T>(fn: () => Promise<T>, options: CliDistBuildLockOptions = {}): Promise<T> {
  const lockPath = options.lockPath ?? resolve(repoRootDir(), '.project', 'tmp', 'cli-dist-build.lock');
  mkdirSync(dirname(lockPath), { recursive: true });

  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? 240_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const staleAfterMs = options.staleAfterMs ?? timeoutMs;

  let fd: number | null = null;
  while (true) {
    try {
      fd = openSync(lockPath, 'wx');
      writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAtMs: Date.now() }), 'utf8');
      break;
    } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e;
      if (shouldReclaimCliDistBuildLock(lockPath, staleAfterMs, Date.now())) {
        continue;
      }
      if (Date.now() - startedAt > timeoutMs) {
        const owner = describeCliDistBuildLockOwner(lockPath, Date.now());
        throw new Error(`Timed out waiting for CLI dist build lock: ${lockPath} (${owner})`);
      }
      await sleep(pollIntervalMs);
    }
  }

  try {
    return await fn();
  } finally {
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

export async function ensureCliDistBuilt(
  params: { testDir: string; env: NodeJS.ProcessEnv },
  options: EnsureCliDistBuiltOptions = {},
): Promise<string> {
  const rootDir = options.repoRoot ?? repoRootDir();
  // Daemon processes execute `apps/cli/dist/*` which imports from workspace deps.
  // Ensure those deps are compiled first so we don't start with a stale/partial protocol build.
  await ensureCliSharedDepsBuilt(params, {
    repoRoot: rootDir,
    runCommand: options.runCommand,
    timeoutMs: options.timeoutMs,
    pollIntervalMs: options.pollIntervalMs,
    staleAfterMs: options.staleAfterMs,
  });
  const distDir = resolve(rootDir, 'apps/cli/dist');
  const entrypoint = resolve(distDir, 'index.mjs');
  const allowRebuild = options.allowRebuild ?? true;
  const shouldRebuild = (): boolean => {
    if (!existsSync(entrypoint)) return true;
    const missing = findMissingDistChunkImports(distDir);
    return missing.length > 0;
  };

  // If a previous ensure attempt completed but dist is missing, rebuild.
  if (_ensurePromise) {
    await _ensurePromise.catch(() => {});
    _ensurePromise = null;
  }

  _ensurePromise = withCliDistBuildLock(async () => {
    if (!shouldRebuild()) return entrypoint;
    if (!allowRebuild) {
      const waitForAvailabilityMs = Number.isFinite(options.waitForAvailabilityMs)
        ? Math.max(0, Math.floor(options.waitForAvailabilityMs as number))
        : 30_000;
      const startedAt = Date.now();
      while (Date.now() - startedAt < waitForAvailabilityMs) {
        await sleep(250);
        if (!shouldRebuild()) return entrypoint;
      }

      const missing = findMissingDistChunkImports(distDir);
      if (!existsSync(entrypoint)) {
        throw new Error(`Missing CLI dist entrypoint after build: ${entrypoint}`);
      }
      if (missing.length > 0) {
        throw new Error(`CLI dist build missing chunk imports: ${missing.join(', ')}`);
      }
      throw new Error('CLI dist rebuild required but rebuilds are disabled for this run');
    }

    const invocation = resolveCliDistBuildInvocation({ repoRoot: rootDir });
    const runCommand = options.runCommand ?? runLoggedCommand;
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      await runCommand({
        command: invocation.command,
        args: invocation.args,
        cwd: invocation.cwd,
        env: { ...params.env, CI: '1' },
        stdoutPath: resolve(params.testDir, 'cli.build.stdout.log'),
        stderrPath: resolve(params.testDir, 'cli.build.stderr.log'),
        timeoutMs: 240_000,
      });

      if (!shouldRebuild()) {
        return entrypoint;
      }

      if (attempt === maxAttempts) {
        const missing = findMissingDistChunkImports(distDir);
        if (!existsSync(entrypoint)) {
          throw new Error(`Missing CLI dist entrypoint after build: ${entrypoint}`);
        }
        if (missing.length > 0) {
          throw new Error(`CLI dist build missing chunk imports: ${missing.join(', ')}`);
        }
        throw new Error('CLI dist rebuild required after maximum retry attempts');
      }
    }

    return entrypoint;
  }, {
    lockPath: options.lockPath ?? resolve(rootDir, '.project', 'tmp', 'cli-dist-build.lock'),
    timeoutMs: options.timeoutMs,
    pollIntervalMs: options.pollIntervalMs,
    staleAfterMs: options.staleAfterMs,
  });

  return await _ensurePromise;
}
