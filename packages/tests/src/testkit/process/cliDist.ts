import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { cp } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { repoRootDir } from '../paths';
import { sleep } from '../timing';
import { ensureCliDistSnapshotNodeModules } from './cliDistSnapshotNodeModules';
import { yarnCommand } from './commands';
import { runLoggedCommand } from './spawnProcess';

let _ensurePromise: Promise<string> | null = null;
let _ensureSharedPromise: Promise<void> | null = null;
const DEFAULT_CLI_DIST_BUILD_TIMEOUT_MS = 600_000;

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
  skipSourceFreshnessCheck?: boolean;
  repoRoot?: string;
  buildTimeoutMs?: number;
  maxBuildAttempts?: number;
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
  skipDistIntegrityCheck?: boolean;
  skipSourceFreshnessCheck?: boolean;
  waitForAvailabilityMs?: number;
  repoRoot?: string;
  buildTimeoutMs?: number;
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

const CLI_SHARED_DEP_PACKAGE_NAMES = ['agents', 'cli-common', 'protocol', 'release-runtime'] as const;

type CliSharedDepPackageName = (typeof CLI_SHARED_DEP_PACKAGE_NAMES)[number];

type EnsureCliDistSnapshotOptions = EnsureCliDistBuiltOptions & {
  snapshotDir: string;
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

function serializeCliDistLockOwner(createdAtMs: number): string {
  return JSON.stringify({ pid: process.pid, createdAtMs });
}

function shouldReclaimCliDistBuildLock(lockPath: string, staleAfterMs: number, nowMs: number): boolean {
  let owner: CliDistBuildLockOwner = { pid: null, createdAtMs: null };
  try {
    owner = parseCliDistLockOwner(readFileSync(lockPath, 'utf8'));
  } catch {
    return false;
  }

  if (owner.pid != null) {
    if (isRunningPid(owner.pid)) {
      if (owner.createdAtMs != null && nowMs - owner.createdAtMs <= staleAfterMs) {
        return false;
      }
    } else {
      try {
        unlinkSync(lockPath);
        return true;
      } catch {
        return false;
      }
    }

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
  return CLI_SHARED_DEP_PACKAGE_NAMES.flatMap((packageName) => resolveCliWorkspaceExpectedOutputPaths(rootDir, packageName));
}

function resolveCliBundledSharedDepsOutputPaths(rootDir: string): string[] {
  return CLI_SHARED_DEP_PACKAGE_NAMES.flatMap((packageName) => resolveCliBundledWorkspaceExpectedOutputPaths(rootDir, packageName));
}

function resolveCliWorkspacePackageDir(rootDir: string, packageName: CliSharedDepPackageName): string {
  return resolve(rootDir, 'packages', packageName);
}

function resolveCliBundledWorkspacePackageDir(rootDir: string, packageName: CliSharedDepPackageName): string {
  return resolve(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', packageName);
}

function collectPackageJsonDistPaths(value: unknown, result: Set<string>): void {
  if (typeof value === 'string') {
    if (value.startsWith('./dist/')) {
      result.add(value.slice(2));
    }
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectPackageJsonDistPaths(item, result);
    return;
  }
  for (const nested of Object.values(value)) collectPackageJsonDistPaths(nested, result);
}

function collectAllFilePaths(dir: string): string[] {
  if (!existsSync(dir)) return [];

  const out: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const currentDir = stack.pop()!;
    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      const entryPath = resolve(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }
      if (entry.isFile() || entry.isSymbolicLink()) {
        out.push(entryPath);
      }
    }
  }
  return out;
}

function resolveCliBundledWorkspaceExpectedOutputPaths(rootDir: string, packageName: CliSharedDepPackageName): string[] {
  const packageDir = resolveCliBundledWorkspacePackageDir(rootDir, packageName);
  const packageJsonPath = existsSync(resolve(packageDir, 'package.json'))
    ? resolve(packageDir, 'package.json')
    : resolve(rootDir, 'packages', packageName, 'package.json');
  const distPaths = new Set<string>();

  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      main?: unknown;
      exports?: unknown;
    };
    collectPackageJsonDistPaths(pkg.main, distPaths);
    collectPackageJsonDistPaths(pkg.exports, distPaths);
  } catch {
    distPaths.add('dist/index.js');
  }

  if (distPaths.size === 0) distPaths.add('dist/index.js');
  return [...distPaths].map((relPath) => resolve(packageDir, relPath));
}

function resolveCliWorkspaceExpectedOutputPaths(rootDir: string, packageName: CliSharedDepPackageName): string[] {
  const packageDir = resolveCliWorkspacePackageDir(rootDir, packageName);
  const packageJsonPath = resolve(packageDir, 'package.json');
  const distPaths = new Set<string>();

  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      main?: unknown;
      exports?: unknown;
    };
    collectPackageJsonDistPaths(pkg.main, distPaths);
    collectPackageJsonDistPaths(pkg.exports, distPaths);
  } catch {
    distPaths.add('dist/index.js');
  }

  if (distPaths.size === 0) distPaths.add('dist/index.js');
  return [...distPaths].map((relPath) => resolve(packageDir, relPath));
}

function hasCliBundledWorkspaceDistParity(rootDir: string, packageName: CliSharedDepPackageName): boolean {
  const workspaceDistDir = resolveCliWorkspacePackageDir(rootDir, packageName);
  const bundledDistDir = resolveCliBundledWorkspacePackageDir(rootDir, packageName);
  const workspaceFiles = collectAllFilePaths(resolve(workspaceDistDir, 'dist'));
  if (workspaceFiles.length === 0) return false;
  if (!existsSync(resolve(bundledDistDir, 'dist'))) return false;

  const bundledFileSet = new Set(
    collectAllFilePaths(resolve(bundledDistDir, 'dist')).map((filePath) => filePath.slice(resolve(bundledDistDir, 'dist').length + 1)),
  );

  return workspaceFiles.every((workspaceFilePath) => {
    const relativePath = workspaceFilePath.slice(resolve(workspaceDistDir, 'dist').length + 1);
    return bundledFileSet.has(relativePath);
  });
}

function repairMissingCliBundledSharedDepsOutputs(rootDir: string): void {
  for (const packageName of CLI_SHARED_DEP_PACKAGE_NAMES) {
    const packageDir = resolveCliBundledWorkspacePackageDir(rootDir, packageName);
    if (!existsSync(packageDir)) continue;

    const workspaceDistDir = resolve(rootDir, 'packages', packageName, 'dist');
    if (!existsSync(workspaceDistDir)) continue;

    const expectedOutputPaths = resolveCliBundledWorkspaceExpectedOutputPaths(rootDir, packageName);
    if (
      expectedOutputPaths.length > 0
      && expectedOutputPaths.every((candidatePath) => existsSync(candidatePath))
      && hasCliBundledWorkspaceDistParity(rootDir, packageName)
    ) {
      continue;
    }

    const bundledDistDir = resolve(packageDir, 'dist');
    try {
      rmSync(bundledDistDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup only.
    }

    mkdirSync(dirname(bundledDistDir), { recursive: true });
    symlinkSync(workspaceDistDir, bundledDistDir, process.platform === 'win32' ? 'junction' : 'dir');
  }
}

function hasCliBundledSharedDepsOutputs(rootDir: string): boolean {
  const cliNodeModulesDir = resolve(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev');
  if (!existsSync(cliNodeModulesDir)) return true;

  return CLI_SHARED_DEP_PACKAGE_NAMES.every((packageName) => {
    const packageDir = resolveCliBundledWorkspacePackageDir(rootDir, packageName);
    if (!existsSync(packageDir)) return false;
    const expectedOutputPaths = resolveCliBundledWorkspaceExpectedOutputPaths(rootDir, packageName);
    if (!expectedOutputPaths.every((candidatePath) => existsSync(candidatePath))) return false;
    if (!hasCliBundledWorkspaceDistParity(rootDir, packageName)) return false;
    return isBundledWorkspaceRuntimeDependencyTreeHealthy(resolve(packageDir, 'package.json'));
  });
}

function collectExternalRuntimeDepNamesFromPackageJson(packageJson: any): ReadonlyArray<{ name: string; optional: boolean }> {
  const deps = packageJson?.dependencies ?? {};
  const optionalDeps = packageJson?.optionalDependencies ?? {};

  const required = Object.keys(deps)
    .filter((name) => typeof name === 'string' && !name.startsWith('@happier-dev/'))
    .map((name) => ({ name, optional: false }));
  const optional = Object.keys(optionalDeps)
    .filter((name) => typeof name === 'string' && !name.startsWith('@happier-dev/'))
    .map((name) => ({ name, optional: true }));

  return [...required, ...optional];
}

function isBundledWorkspaceRuntimeDependencyTreeHealthy(
  packageJsonPath: string,
  opts?: { visited?: Set<string> },
): boolean {
  if (!existsSync(packageJsonPath)) return false;

  const visited = opts?.visited ?? new Set<string>();
  if (visited.has(packageJsonPath)) return true;
  visited.add(packageJsonPath);

  let pkg: any;
  try {
    pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  } catch {
    return false;
  }

  const packageDir = dirname(packageJsonPath);
  const deps = collectExternalRuntimeDepNamesFromPackageJson(pkg);

  for (const dep of deps) {
    const depPackageDir = resolve(packageDir, 'node_modules', ...dep.name.split('/'));
    if (!existsSync(depPackageDir)) {
      if (dep.optional) continue;
      return false;
    }

    const depPackageJsonPath = resolve(depPackageDir, 'package.json');
    if (!existsSync(depPackageJsonPath)) {
      if (dep.optional) continue;
      return false;
    }

    if (!isBundledWorkspaceRuntimeDependencyTreeHealthy(depPackageJsonPath, { visited })) {
      return false;
    }
  }

  return true;
}

function resolveCliSharedDepsSourcePaths(rootDir: string): string[] {
  return [
    resolve(rootDir, 'packages', 'agents', 'src'),
    resolve(rootDir, 'packages', 'agents', 'package.json'),
    resolve(rootDir, 'packages', 'agents', 'tsconfig.json'),
    resolve(rootDir, 'packages', 'cli-common', 'src'),
    resolve(rootDir, 'packages', 'cli-common', 'package.json'),
    resolve(rootDir, 'packages', 'cli-common', 'tsconfig.json'),
    resolve(rootDir, 'packages', 'protocol', 'src'),
    resolve(rootDir, 'packages', 'protocol', 'package.json'),
    resolve(rootDir, 'packages', 'protocol', 'tsconfig.json'),
    resolve(rootDir, 'packages', 'release-runtime', 'src'),
    resolve(rootDir, 'packages', 'release-runtime', 'package.json'),
    resolve(rootDir, 'packages', 'release-runtime', 'tsconfig.json'),
  ];
}

function resolveCliDistSourcePaths(rootDir: string): string[] {
  return [
    resolve(rootDir, 'apps', 'cli', 'src'),
  ];
}

function resolveCliDistDir(rootDir: string): string {
  return resolve(rootDir, 'apps', 'cli', 'dist');
}

function resolveCliBackupDistDir(rootDir: string): string {
  return resolve(rootDir, 'apps', 'cli', '.dist.hstack-backup');
}

function resolveCliDistEntrypoint(dir: string): string {
  return resolve(dir, 'index.mjs');
}

function shouldIgnoreBuildFreshnessSourcePath(path: string): boolean {
  return /\.(?:test|spec|integration|e2e|slow)\.[cm]?[jt]sx?$/.test(path);
}

function readNewestPathMtimeMs(path: string, opts: { ignoreBuildFreshnessTestFiles?: boolean } = {}): number {
  if (opts.ignoreBuildFreshnessTestFiles && shouldIgnoreBuildFreshnessSourcePath(path)) {
    return 0;
  }
  if (!existsSync(path)) return 0;

  try {
    const stats = statSync(path);
    if (!stats.isDirectory()) return stats.mtimeMs;

    let newestMtimeMs = 0;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      newestMtimeMs = Math.max(
        newestMtimeMs,
        readNewestPathMtimeMs(resolve(path, entry.name), opts),
      );
    }
    return newestMtimeMs > 0 ? newestMtimeMs : stats.mtimeMs;
  } catch {
    return 0;
  }
}

function readOldestPathMtimeMs(path: string, opts: { ignoreBuildFreshnessTestFiles?: boolean } = {}): number {
  if (opts.ignoreBuildFreshnessTestFiles && shouldIgnoreBuildFreshnessSourcePath(path)) {
    return Number.POSITIVE_INFINITY;
  }
  if (!existsSync(path)) return 0;

  try {
    const stats = statSync(path);
    if (!stats.isDirectory()) return stats.mtimeMs;

    let oldestMtimeMs = Number.POSITIVE_INFINITY;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      oldestMtimeMs = Math.min(
        oldestMtimeMs,
        readOldestPathMtimeMs(resolve(path, entry.name), opts),
      );
    }
    return Number.isFinite(oldestMtimeMs) ? oldestMtimeMs : stats.mtimeMs;
  } catch {
    return 0;
  }
}

function readNewestPathsMtimeMs(paths: readonly string[], opts: { ignoreBuildFreshnessTestFiles?: boolean } = {}): number {
  return paths.reduce((max, candidatePath) => Math.max(max, readNewestPathMtimeMs(candidatePath, opts)), 0);
}

function readOldestExistingOutputMtimeMs(paths: readonly string[]): number {
  let oldestMtimeMs = Number.POSITIVE_INFINITY;
  for (const candidatePath of paths) {
    if (!existsSync(candidatePath)) return 0;
    try {
      oldestMtimeMs = Math.min(oldestMtimeMs, statSync(candidatePath).mtimeMs);
    } catch {
      return 0;
    }
  }
  return Number.isFinite(oldestMtimeMs) ? oldestMtimeMs : 0;
}

function areBuildOutputsStale(params: { sourcePaths: readonly string[]; outputPaths: readonly string[] }): boolean {
  const oldestOutputMtimeMs = readOldestExistingOutputMtimeMs(params.outputPaths);
  if (oldestOutputMtimeMs <= 0) return true;

  const newestSourceMtimeMs = readNewestPathsMtimeMs(params.sourcePaths, {
    ignoreBuildFreshnessTestFiles: true,
  });
  if (newestSourceMtimeMs <= 0) return false;

  return newestSourceMtimeMs > oldestOutputMtimeMs;
}

function isBuildDirectoryStale(params: { sourcePaths: readonly string[]; outputDir: string }): boolean {
  const newestOutputMtimeMs = readNewestPathMtimeMs(params.outputDir);
  if (newestOutputMtimeMs <= 0) return true;

  const newestSourceMtimeMs = readNewestPathsMtimeMs(params.sourcePaths, {
    ignoreBuildFreshnessTestFiles: true,
  });
  if (newestSourceMtimeMs <= 0) return false;

  return newestSourceMtimeMs > newestOutputMtimeMs;
}

function hasCliSharedDepsOutputs(rootDir: string, opts: { skipSourceFreshnessCheck?: boolean } = {}): boolean {
  const workspaceOutputPaths = resolveCliSharedDepsOutputPaths(rootDir);
  if (!workspaceOutputPaths.every((candidatePath) => existsSync(candidatePath))) {
    return false;
  }

  repairMissingCliBundledSharedDepsOutputs(rootDir);
  if (!hasCliBundledSharedDepsOutputs(rootDir)) return false;
  if (opts.skipSourceFreshnessCheck) return true;

  return !areBuildOutputsStale({
    sourcePaths: resolveCliSharedDepsSourcePaths(rootDir),
    outputPaths: resolveCliBundledSharedDepsOutputPaths(rootDir),
  });
}

export function resolveCliDistBuildInvocation(params: { repoRoot?: string } = {}): CliDistBuildInvocation {
  const rootDir = params.repoRoot ?? repoRootDir();
  const cwd = resolve(rootDir, 'apps', 'cli');
  // Use the canonical workspace build script. Some E2E lanes run multiple daemons concurrently and
  // rely on hashed-chunk stability; building via pkgroll directly can leave partial dist folders.
  // The workspace build is expected to produce a fully coherent dist/ output.
  return { command: yarnCommand(), args: ['-s', 'workspace', '@happier-dev/cli', 'build'], cwd: rootDir };
}

export async function ensureCliSharedDepsBuilt(
  params: { testDir: string; env: NodeJS.ProcessEnv },
  options: EnsureCliSharedDepsBuiltOptions = {},
): Promise<void> {
  const rootDir = options.repoRoot ?? repoRootDir();
  const skipSourceFreshnessCheck = options.skipSourceFreshnessCheck ?? false;
  const maxBuildAttempts = Math.max(1, options.maxBuildAttempts ?? 2);
  if (_ensureSharedPromise) return await _ensureSharedPromise;

  if (hasCliSharedDepsOutputs(rootDir, { skipSourceFreshnessCheck })) {
    return;
  }

  _ensureSharedPromise = (async () => {
    if (hasCliSharedDepsOutputs(rootDir, { skipSourceFreshnessCheck })) {
      return;
    }

    const runCommand = options.runCommand ?? runLoggedCommand;
    for (let attempt = 1; attempt <= maxBuildAttempts; attempt += 1) {
      await runCommand({
        command: yarnCommand(),
        args: ['-s', 'workspace', '@happier-dev/cli', 'build:shared'],
        cwd: rootDir,
        env: { ...process.env, ...params.env, CI: '1' },
        stdoutPath: resolve(params.testDir, 'cli.buildShared.stdout.log'),
        stderrPath: resolve(params.testDir, 'cli.buildShared.stderr.log'),
        timeoutMs: options.buildTimeoutMs ?? DEFAULT_CLI_DIST_BUILD_TIMEOUT_MS,
      });

      if (hasCliSharedDepsOutputs(rootDir)) {
        return;
      }
    }

    if (!hasCliSharedDepsOutputs(rootDir)) {
      throw new Error(`Shared workspace deps output missing after build: ${resolve(rootDir, 'packages')}`);
    }
  })();

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
  const timeoutMs = options.timeoutMs ?? DEFAULT_CLI_DIST_BUILD_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const staleAfterMs = options.staleAfterMs ?? timeoutMs;

  let fd: number | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  while (true) {
    try {
      fd = openSync(lockPath, 'wx');
      writeFileSync(fd, serializeCliDistLockOwner(Date.now()), 'utf8');
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
    if (staleAfterMs > 0) {
      const heartbeatIntervalMs = Math.max(250, Math.min(5_000, Math.floor(staleAfterMs / 4) || 250));
      heartbeatTimer = setInterval(() => {
        try {
          writeFileSync(lockPath, serializeCliDistLockOwner(Date.now()), 'utf8');
        } catch {
          // Best-effort lease heartbeat only.
        }
      }, heartbeatIntervalMs);
      heartbeatTimer.unref();
    }

    return await fn();
  } finally {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }
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
    skipSourceFreshnessCheck: options.skipSourceFreshnessCheck,
    timeoutMs: options.timeoutMs,
    pollIntervalMs: options.pollIntervalMs,
    staleAfterMs: options.staleAfterMs,
  });
  const distDir = resolveCliDistDir(rootDir);
  const entrypoint = resolveCliDistEntrypoint(distDir);
  const allowRebuild = options.allowRebuild ?? true;
  const skipDistIntegrityCheck = options.skipDistIntegrityCheck ?? false;
  const skipSourceFreshnessCheck = options.skipSourceFreshnessCheck ?? false;
  const resolveReusableEntrypoint = (): string | null => {
    const reusableDir = resolveExistingCliDistDir({
      rootDir,
      skipDistIntegrityCheck,
      skipSourceFreshnessCheck,
    });
    return reusableDir ? resolveCliDistEntrypoint(reusableDir) : null;
  };
  const shouldRebuild = (): boolean => {
    return resolveReusableEntrypoint() === null;
  };

  const reusableEntrypoint = resolveReusableEntrypoint();
  if (reusableEntrypoint) {
    return reusableEntrypoint;
  }

  // If a previous ensure attempt completed but dist is missing, rebuild.
  if (_ensurePromise) {
    await _ensurePromise.catch(() => {});
    _ensurePromise = null;
  }

  _ensurePromise = withCliDistBuildLock(async () => {
    const reusableEntrypoint = resolveReusableEntrypoint();
    if (reusableEntrypoint) return reusableEntrypoint;
    if (!allowRebuild) {
      const waitForAvailabilityMs = Number.isFinite(options.waitForAvailabilityMs)
        ? Math.max(0, Math.floor(options.waitForAvailabilityMs as number))
        : 30_000;
      const startedAt = Date.now();
      while (Date.now() - startedAt < waitForAvailabilityMs) {
        await sleep(250);
        const availableEntrypoint = resolveReusableEntrypoint();
        if (availableEntrypoint) return availableEntrypoint;
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
        timeoutMs: options.buildTimeoutMs ?? DEFAULT_CLI_DIST_BUILD_TIMEOUT_MS,
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
        if (isHealthyCliDist(distDir)) {
          return entrypoint;
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

function isHealthyCliDist(dir: string): boolean {
  const entrypoint = resolveCliDistEntrypoint(dir);
  if (!existsSync(entrypoint)) return false;
  return findMissingDistChunkImports(dir).length === 0;
}

function resolveExistingCliDistDir(params: {
  rootDir: string;
  skipDistIntegrityCheck: boolean;
  skipSourceFreshnessCheck: boolean;
}): string | null {
  const candidates = [resolveCliDistDir(params.rootDir), resolveCliBackupDistDir(params.rootDir)];
  for (const dir of candidates) {
    const entrypoint = resolveCliDistEntrypoint(dir);
    if (!existsSync(entrypoint)) continue;
    if (!params.skipDistIntegrityCheck && findMissingDistChunkImports(dir).length > 0) continue;
    if (!params.skipSourceFreshnessCheck && isBuildDirectoryStale({ sourcePaths: resolveCliDistSourcePaths(params.rootDir), outputDir: dir })) {
      continue;
    }
    return dir;
  }
  return null;
}

function ensureSnapshotProjectFile(snapshotDir: string, rootDir: string, relPath: string): void {
  const target = resolve(rootDir, 'apps', 'cli', relPath);
  if (!existsSync(target)) return;
  const dest = resolve(snapshotDir, relPath);
  if (existsSync(dest)) return;
  mkdirSync(dirname(dest), { recursive: true });
  try {
    // Keep snapshots immutable: copy small files, and symlink large folders elsewhere.
    writeFileSync(dest, readFileSync(target));
  } catch {
    // Best-effort only. Tests can still proceed if the file isn't required by the current lane.
  }
}

function ensureSnapshotProjectLink(snapshotDir: string, rootDir: string, relPath: string): void {
  const target = resolve(rootDir, 'apps', 'cli', relPath);
  if (!existsSync(target)) return;
  const dest = resolve(snapshotDir, relPath);
  if (existsSync(dest)) return;
  mkdirSync(dirname(dest), { recursive: true });
  try {
    symlinkSync(target, dest, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    // Best-effort only. Some environments disallow symlinks; callers must tolerate missing links.
  }
}

export async function ensureCliDistSnapshotEntrypoint(
  params: { testDir: string; env: NodeJS.ProcessEnv },
  options: EnsureCliDistSnapshotOptions,
): Promise<string> {
  const rootDir = options.repoRoot ?? repoRootDir();
  const distLockPath = options.lockPath ?? resolve(rootDir, '.project', 'tmp', 'cli-dist-build.lock');
  const snapshotDistDir = resolve(options.snapshotDir, 'dist');
  const snapshotEntrypoint = resolve(snapshotDistDir, 'index.mjs');
  const snapshotReadyMarkerPath = resolve(options.snapshotDir, '.cli-dist-snapshot.ready.json');
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    // Ensure dist is available first. We intentionally do this outside the snapshot lock to avoid
    // re-entering the same lock from ensureCliDistBuilt.
    await ensureCliDistBuilt(params, { ...options, repoRoot: rootDir, lockPath: distLockPath });

    try {
      return await withCliDistBuildLock(
        async () => {
          const snapshotHasReadyMarker = (): boolean => {
            return (
              existsSync(snapshotReadyMarkerPath) && existsSync(resolve(options.snapshotDir, 'node_modules'))
            );
          };

          const ensureSnapshotScaffolding = (): void => {
            ensureSnapshotProjectFile(options.snapshotDir, rootDir, 'package.json');
            ensureSnapshotProjectLink(options.snapshotDir, rootDir, 'scripts');
            ensureSnapshotProjectLink(options.snapshotDir, rootDir, 'tools');
            ensureSnapshotProjectLink(options.snapshotDir, rootDir, 'bin');
            ensureSnapshotProjectFile(options.snapshotDir, rootDir, 'tsconfig.json');
          };

          const ensureSnapshotNodeModules = (): void => {
            const mode = (params.env.HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE ?? '').toString().trim().toLowerCase();
            if (mode === 'symlink') {
              const snapshotNodeModulesDir = resolve(options.snapshotDir, 'node_modules');
              if (existsSync(snapshotNodeModulesDir)) return;

              const cliNodeModulesDir = resolve(rootDir, 'apps', 'cli', 'node_modules');
              const rootNodeModulesDir = resolve(rootDir, 'node_modules');
              const source = existsSync(cliNodeModulesDir) ? cliNodeModulesDir : rootNodeModulesDir;
              if (!existsSync(source)) return;

              mkdirSync(dirname(snapshotNodeModulesDir), { recursive: true });
              try {
                symlinkSync(source, snapshotNodeModulesDir, process.platform === 'win32' ? 'junction' : 'dir');
              } catch {
                // Best-effort only.
              }
              return;
            }

            ensureCliDistSnapshotNodeModules({
              snapshotDir: options.snapshotDir,
              snapshotDistDir,
              rootDir,
            });
          };

          const markSnapshotReady = (): void => {
            if (snapshotHasReadyMarker()) return;
            try {
              writeFileSync(
                snapshotReadyMarkerPath,
                JSON.stringify({ v: 1, createdAt: new Date().toISOString() }),
                'utf8',
              );
            } catch {
              // Best-effort only.
            }
          };

          if (isHealthyCliDist(snapshotDistDir) && snapshotHasReadyMarker()) {
            // Fast path: keep daemon startups cheap during slow E2E lanes.
            ensureSnapshotScaffolding();
            return snapshotEntrypoint;
          }

          // If a previous run left a partial snapshot behind, self-heal instead of failing closed.
          if (existsSync(options.snapshotDir) && !isHealthyCliDist(snapshotDistDir)) {
            rmSync(options.snapshotDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
          }

          if (isHealthyCliDist(snapshotDistDir)) {
            ensureSnapshotNodeModules();
            ensureSnapshotScaffolding();
            markSnapshotReady();
            return snapshotEntrypoint;
          }

          const distDir = resolveExistingCliDistDir({
            rootDir,
            skipDistIntegrityCheck: options.skipDistIntegrityCheck ?? false,
            skipSourceFreshnessCheck: options.skipSourceFreshnessCheck ?? false,
          });
          if (!distDir) {
            const canonicalDistDir = resolveCliDistDir(rootDir);
            const missing = findMissingDistChunkImports(canonicalDistDir);
            throw new Error(
              missing.length > 0
                ? `Refusing to snapshot an incomplete CLI dist (missing chunk imports): ${missing.join(', ')}`
                : `Refusing to snapshot an incomplete CLI dist (missing index.mjs): ${resolveCliDistEntrypoint(canonicalDistDir)}`,
            );
          }

          mkdirSync(dirname(options.snapshotDir), { recursive: true });
          // Ensure we never mutate an existing snapshot (which could be in-use by a running daemon).
          rmSync(options.snapshotDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
          mkdirSync(options.snapshotDir, { recursive: true });
          await cp(distDir, snapshotDistDir, { recursive: true });
          ensureSnapshotNodeModules();
          ensureSnapshotScaffolding();

          if (!(options.skipDistIntegrityCheck ?? false) && !isHealthyCliDist(snapshotDistDir)) {
            const missing = findMissingDistChunkImports(snapshotDistDir);
            throw new Error(
              missing.length > 0
                ? `CLI dist snapshot missing chunk imports: ${missing.join(', ')}`
                : `CLI dist snapshot missing entrypoint: ${snapshotEntrypoint}`,
            );
          }

          markSnapshotReady();
          return snapshotEntrypoint;
        },
        {
          lockPath: distLockPath,
          timeoutMs: options.timeoutMs,
          pollIntervalMs: options.pollIntervalMs,
          staleAfterMs: options.staleAfterMs,
        },
      );
    } catch (error: any) {
      if (error?.code !== 'ENOENT' || attempt === maxAttempts) {
        throw error;
      }
      rmSync(options.snapshotDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }

  throw new Error(`Failed to create CLI dist snapshot after ${maxAttempts} attempts: ${snapshotEntrypoint}`);
}
