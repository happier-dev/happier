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
import { basename, dirname, resolve } from 'node:path';

import { repoRootDir } from '../paths';
import { sleep } from '../timing';
import { ensureCliDistSnapshotNodeModules } from './cliDistSnapshotNodeModules';
import { yarnCommand } from './commands';
import { runLoggedCommand } from './spawnProcess';
import {
  CLI_SHARED_DEP_PACKAGE_NAMES,
  resolveCliBundledWorkspacePackageDir,
  resolveCliWorkspacePackageDir,
  type CliSharedDepPackageName,
} from './workspacePackageResolution';

const ensureDistPromisesByRepoRoot = new Map<string, Promise<string>>();
const ensureSharedPromisesByRepoRoot = new Map<string, Promise<void>>();
const DEFAULT_CLI_DIST_BUILD_TIMEOUT_MS = 600_000;
const CLI_DIST_SNAPSHOT_MTIME_TOLERANCE_MS = 5;

function shouldSkipCliSharedDepsBuildForE2e(env: NodeJS.ProcessEnv): boolean {
  const raw = (
    env.HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD ??
    env.HAPPY_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD ??
    ''
  )
    .toString()
    .trim()
    .toLowerCase();

  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'y';
}

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
  beforeRepairBundledWorkspaceDistSymlink?: (params: {
    packageName: CliSharedDepPackageName;
    workspaceDistDir: string;
    bundledDistDir: string;
  }) => void;
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

function resolveWorkspacePackageExpectedOutputPaths(
  rootDir: string,
  packageName: CliSharedDepPackageName,
  packageDir: string,
): string[] {
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

function resolveCliBundledWorkspaceExpectedOutputPaths(rootDir: string, packageName: CliSharedDepPackageName): string[] {
  return resolveWorkspacePackageExpectedOutputPaths(
    rootDir,
    packageName,
    resolveCliBundledWorkspacePackageDir(rootDir, packageName),
  );
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

function hasWorkspacePackageDistParity(
  rootDir: string,
  packageName: CliSharedDepPackageName,
  packageDir: string,
): boolean {
  const workspaceDistDir = resolveCliWorkspacePackageDir(rootDir, packageName);
  const bundledDistDir = packageDir;
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

function hasCliBundledWorkspaceDistParity(rootDir: string, packageName: CliSharedDepPackageName): boolean {
  return hasWorkspacePackageDistParity(
    rootDir,
    packageName,
    resolveCliBundledWorkspacePackageDir(rootDir, packageName),
  );
}

function stableJsonStringify(value: unknown): string {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'string') return JSON.stringify(value);
  if (t === 'number' || t === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableJsonStringify(v)).join(',')}]`;
  if (t !== 'object') return JSON.stringify(String(value));
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJsonStringify(obj[k])}`).join(',')}}`;
}

function readPackageJsonField(packageJsonPath: string, field: string): unknown {
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as Record<string, unknown>;
    return parsed[field];
  } catch {
    return undefined;
  }
}

function hasWorkspacePackageManifestParity(
  rootDir: string,
  packageName: CliSharedDepPackageName,
  packageDir: string,
): boolean {
  const workspacePackageJsonPath = resolve(resolveCliWorkspacePackageDir(rootDir, packageName), 'package.json');
  const bundledPackageJsonPath = resolve(packageDir, 'package.json');
  if (!existsSync(bundledPackageJsonPath)) return false;

  // Some harnesses build a minimal scratch "repo root" that only contains `packages/<name>/dist/**`.
  // In that case, we can't enforce exports parity, and a rebuild can't create the missing manifest.
  // Fail open so bundled outputs can still be treated as healthy.
  if (!existsSync(workspacePackageJsonPath)) return true;

  const workspaceExports = readPackageJsonField(workspacePackageJsonPath, 'exports');
  const bundledExports = readPackageJsonField(bundledPackageJsonPath, 'exports');

  // When the CLI imports an internal workspace via a subpath export (e.g. `@happier-dev/cli-common/systemTasks`),
  // a stale bundled `package.json#exports` can crash at runtime even if dist files exist. Treat exports parity
  // as part of the shared-deps contract so E2E snapshots rebuild when exports evolve.
  return stableJsonStringify(workspaceExports) === stableJsonStringify(bundledExports);
}

function hasCliBundledWorkspaceManifestParity(rootDir: string, packageName: CliSharedDepPackageName): boolean {
  return hasWorkspacePackageManifestParity(
    rootDir,
    packageName,
    resolveCliBundledWorkspacePackageDir(rootDir, packageName),
  );
}

function hasCliDistSnapshotNodeModulesHealth(rootDir: string, snapshotDir: string): boolean {
  const snapshotNodeModulesDir = resolve(snapshotDir, 'node_modules');
  if (!existsSync(snapshotNodeModulesDir)) return false;

  const snapshotWorkspaceScopeDir = resolve(snapshotNodeModulesDir, '@happier-dev');
  if (!existsSync(snapshotWorkspaceScopeDir)) return true;

  return CLI_SHARED_DEP_PACKAGE_NAMES.every((packageName) => {
    const packageDir = resolve(snapshotNodeModulesDir, '@happier-dev', packageName);
    if (!existsSync(packageDir)) return false;
    if (!hasWorkspacePackageManifestParity(rootDir, packageName, packageDir)) return false;

    const expectedOutputPaths = resolveWorkspacePackageExpectedOutputPaths(rootDir, packageName, packageDir);
    if (!expectedOutputPaths.every((candidatePath) => existsSync(candidatePath))) return false;
    if (!hasWorkspacePackageDistParity(rootDir, packageName, packageDir)) return false;
    if (packageName === 'protocol' && !hasValidProtocolDistIndexExportsAtPath(resolve(packageDir, 'dist', 'index.js'))) {
      return false;
    }

    return isBundledWorkspaceRuntimeDependencyTreeHealthy(resolve(packageDir, 'package.json'));
  });
}

function hasCliDistSnapshotProtocolExportsHealth(snapshotDir: string): boolean {
  return hasValidProtocolDistIndexExportsAtPath(
    resolve(snapshotDir, 'node_modules', '@happier-dev', 'protocol', 'dist', 'index.js'),
  );
}

function hasCliDistSnapshotProtocolRootImportCompatibility(snapshotDir: string): boolean {
  return hasCliDistProtocolRootImportCompatibility({
    distDir: resolve(snapshotDir, 'dist'),
    protocolDistIndexPath: resolve(snapshotDir, 'node_modules', '@happier-dev', 'protocol', 'dist', 'index.js'),
  });
}

function repairMissingCliBundledSharedDepsOutputs(
  rootDir: string,
  opts?: {
    beforeRepairBundledWorkspaceDistSymlink?: (params: {
      packageName: CliSharedDepPackageName;
      workspaceDistDir: string;
      bundledDistDir: string;
    }) => void;
  },
): void {
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
    opts?.beforeRepairBundledWorkspaceDistSymlink?.({
      packageName,
      workspaceDistDir,
      bundledDistDir,
    });
    try {
      symlinkSync(workspaceDistDir, bundledDistDir, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      const err = error as NodeJS.ErrnoException | null;
      if (err?.code === 'EEXIST' && existsSync(bundledDistDir)) {
        // Another process won the race and created the same symlink before we did.
        // The shared-deps health check runs immediately after this repair, so an existing
        // dist link is sufficient.
        continue;
      }
      throw error;
    }
  }
}

function hasCliBundledSharedDepsOutputs(rootDir: string): boolean {
  const cliNodeModulesDir = resolve(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev');
  if (!existsSync(cliNodeModulesDir)) return true;

  return CLI_SHARED_DEP_PACKAGE_NAMES.every((packageName) => {
    const packageDir = resolveCliBundledWorkspacePackageDir(rootDir, packageName);
    if (!existsSync(packageDir)) return false;
    if (!hasCliBundledWorkspaceManifestParity(rootDir, packageName)) return false;
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

function collectPackageJsonRelativeFileTargets(value: unknown, result: Set<string>): void {
  if (typeof value === 'string') {
    if (value.startsWith('./') && !value.includes('*')) {
      result.add(value.slice(2));
    }
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectPackageJsonRelativeFileTargets(item, result);
    return;
  }
  for (const nested of Object.values(value)) collectPackageJsonRelativeFileTargets(nested, result);
}

function doesPackageRelativeFileTargetExist(packageDir: string, relativeTarget: string): boolean {
  const absoluteTargetPath = resolve(packageDir, relativeTarget);
  if (existsSync(absoluteTargetPath)) return true;

  const extensionCandidates = ['', '.js', '.mjs', '.cjs', '.json', '.node'];
  const hasExplicitExtension = /\.[^/\\]+$/u.test(absoluteTargetPath);
  if (!hasExplicitExtension) {
    for (const extension of extensionCandidates) {
      if (existsSync(`${absoluteTargetPath}${extension}`)) return true;
    }
    for (const extension of extensionCandidates) {
      if (existsSync(resolve(absoluteTargetPath, `index${extension}`))) return true;
    }
  }

  return false;
}

function hasBundledWorkspacePackageReferencedFiles(packageJsonPath: string): boolean {
  if (!existsSync(packageJsonPath)) return false;

  let pkg: any;
  try {
    pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  } catch {
    return false;
  }

  const packageDir = dirname(packageJsonPath);
  const relativeFileTargets = new Set<string>();
  collectPackageJsonRelativeFileTargets(pkg.main, relativeFileTargets);
  collectPackageJsonRelativeFileTargets(pkg.module, relativeFileTargets);
  collectPackageJsonRelativeFileTargets(pkg.types, relativeFileTargets);
  collectPackageJsonRelativeFileTargets(pkg.exports, relativeFileTargets);

  for (const relPath of relativeFileTargets) {
    if (!doesPackageRelativeFileTargetExist(packageDir, relPath)) {
      return false;
    }
  }

  return true;
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

  if (!hasBundledWorkspacePackageReferencedFiles(packageJsonPath)) {
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

function resolveCanonicalSharedCliDistSnapshotDir(rootDir: string): string {
  return resolve(rootDir, '.project', 'tmp', 'cli-dist-snapshot');
}

function resolveCliDistSnapshotLockPath(params: Readonly<{
  rootDir: string;
  snapshotDir: string;
  defaultLockPath: string;
}>): string {
  const canonicalSharedSnapshotDir = resolveCanonicalSharedCliDistSnapshotDir(params.rootDir);
  if (resolve(params.snapshotDir) === canonicalSharedSnapshotDir) {
    return params.defaultLockPath;
  }

  return `${params.snapshotDir}.lock`;
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

function isBuildDirectoryStale(params: {
  sourcePaths: readonly string[];
  outputDir: string;
  mtimeToleranceMs?: number;
}): boolean {
  const newestOutputMtimeMs = readNewestPathMtimeMs(params.outputDir);
  if (newestOutputMtimeMs <= 0) return true;

  const newestSourceMtimeMs = readNewestPathsMtimeMs(params.sourcePaths, {
    ignoreBuildFreshnessTestFiles: true,
  });
  if (newestSourceMtimeMs <= 0) return false;

  return newestSourceMtimeMs - newestOutputMtimeMs > (params.mtimeToleranceMs ?? 0);
}

function listExplicitNamedExportsFromModuleSource(sourceText: string): string[] {
  const namedExports: string[] = [];
  const exportDeclarationPattern = /\bexport\s+(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gu;
  for (const match of sourceText.matchAll(exportDeclarationPattern)) {
    const exportName = match[1];
    if (exportName) namedExports.push(exportName);
  }

  const exportListPattern = /\bexport\s*\{([\s\S]*?)\}\s*(?:from\b[\s\S]*?)?;/gu;
  for (const match of sourceText.matchAll(exportListPattern)) {
    const specifierBlock = match[1];
    if (!specifierBlock) continue;
    const specifiers = specifierBlock.split(',');
    for (const rawSpecifier of specifiers) {
      const normalizedSpecifier = rawSpecifier.replace(/\/\*[\s\S]*?\*\//gu, '').trim();
      if (!normalizedSpecifier) continue;
      const aliasMatch = normalizedSpecifier.match(/\bas\s+([A-Za-z_$][\w$]*)$/u);
      if (aliasMatch?.[1]) {
        namedExports.push(aliasMatch[1]);
        continue;
      }
      const directMatch = normalizedSpecifier.match(/^([A-Za-z_$][\w$]*)$/u);
      if (directMatch?.[1]) {
        namedExports.push(directMatch[1]);
      }
    }
  }

  return namedExports;
}

function listImportedNamesFromProtocolSpecifierBlock(specifierBlock: string): string[] {
  const importedNames: string[] = [];
  for (const rawSpecifier of specifierBlock.split(',')) {
    const normalizedSpecifier = rawSpecifier
      .replace(/\/\*[\s\S]*?\*\//gu, '')
      .trim()
      .replace(/^type\s+/u, '')
      .trim();
    if (!normalizedSpecifier) continue;
    const importedName = normalizedSpecifier.split(/\s+as\s+/u)[0]?.split(':')[0]?.trim();
    if (importedName && /^[A-Za-z_$][\w$]*$/u.test(importedName)) {
      importedNames.push(importedName);
    }
  }
  return importedNames;
}

function listCliDistProtocolRootReferences(sourceText: string): string[] {
  const references: string[] = [];
  const namedImportPattern = /\bimport\s*\{([^}]*)\}\s*from\s*['"]@happier-dev\/protocol['"]/gu;
  for (const match of sourceText.matchAll(namedImportPattern)) {
    references.push(...listImportedNamesFromProtocolSpecifierBlock(match[1] ?? ''));
  }

  const destructuredRequirePattern =
    /\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(['"]@happier-dev\/protocol['"]\)/gu;
  for (const match of sourceText.matchAll(destructuredRequirePattern)) {
    references.push(...listImportedNamesFromProtocolSpecifierBlock(match[1] ?? ''));
  }

  const namespaceNames = new Set<string>();
  const namespaceImportPattern = /\bimport\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s*['"]@happier-dev\/protocol['"]/gu;
  for (const match of sourceText.matchAll(namespaceImportPattern)) {
    if (match[1]) namespaceNames.add(match[1]);
  }

  const namespaceRequirePattern =
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:[A-Za-z_$][\w$]*\()?require\(['"]@happier-dev\/protocol['"]\)\)?/gu;
  for (const match of sourceText.matchAll(namespaceRequirePattern)) {
    if (match[1]) namespaceNames.add(match[1]);
  }

  for (const namespaceName of namespaceNames) {
    const propertyPattern = new RegExp(`(^|[^.$\\w])${namespaceName}\\.([A-Za-z_$][\\w$]*)`, 'gu');
    for (const match of sourceText.matchAll(propertyPattern)) {
      const propertyName = match[2];
      if (propertyName && propertyName !== 'default') references.push(propertyName);
    }
  }

  return references;
}

function hasDuplicateExplicitNamedExports(sourceText: string): boolean {
  const seenExports = new Set<string>();
  for (const exportName of listExplicitNamedExportsFromModuleSource(sourceText)) {
    if (seenExports.has(exportName)) return true;
    seenExports.add(exportName);
  }
  return false;
}

function hasValidProtocolDistIndexExportsAtPath(protocolDistIndexPath: string): boolean {
  try {
    const sourceText = readFileSync(protocolDistIndexPath, 'utf8');
    if (!sourceText.trim()) return false;
    return !hasDuplicateExplicitNamedExports(sourceText);
  } catch {
    return false;
  }
}

function readModuleExportNames(modulePath: string, visited = new Set<string>()): Set<string> | null {
  if (visited.has(modulePath)) return new Set();
  visited.add(modulePath);

  try {
    const sourceText = readFileSync(modulePath, 'utf8');
    if (!sourceText.trim()) return null;
    const exportNames = new Set(listExplicitNamedExportsFromModuleSource(sourceText));
    const exportStarPattern = /\bexport\s+\*\s+from\s+['"]\.\/([^'"]+)['"]\s*;/gu;
    for (const match of sourceText.matchAll(exportStarPattern)) {
      const relModulePath = match[1];
      if (!relModulePath) continue;
      const nestedExportNames = readModuleExportNames(resolve(dirname(modulePath), relModulePath), visited);
      if (!nestedExportNames) return null;
      for (const exportName of nestedExportNames) {
        exportNames.add(exportName);
      }
    }
    return exportNames;
  } catch {
    return null;
  }
}

function readProtocolDistIndexExportNames(protocolDistIndexPath: string): Set<string> | null {
  return readModuleExportNames(protocolDistIndexPath);
}

function hasCliDistProtocolRootImportCompatibility(params: {
  distDir: string;
  protocolDistIndexPath: string;
}): boolean {
  const protocolExportNames = readProtocolDistIndexExportNames(params.protocolDistIndexPath);
  if (!protocolExportNames) return true;
  if (protocolExportNames.size === 0) return true;

  let distFiles: string[] = [];
  try {
    distFiles = readdirSync(params.distDir).filter((fileName) => fileName.endsWith('.mjs') || fileName.endsWith('.cjs'));
  } catch {
    return false;
  }

  for (const fileName of distFiles) {
    let sourceText = '';
    try {
      sourceText = readFileSync(resolve(params.distDir, fileName), 'utf8');
    } catch {
      return false;
    }
    for (const referenceName of listCliDistProtocolRootReferences(sourceText)) {
      if (!protocolExportNames.has(referenceName)) return false;
    }
  }

  return true;
}

export const __cliDistTestHooks = {
  hasCliDistProtocolRootImportCompatibility,
};

function hasValidCliSharedDepsProtocolExports(rootDir: string): boolean {
  const workspaceProtocolDistIndexPath = resolve(rootDir, 'packages', 'protocol', 'dist', 'index.js');
  const bundledProtocolDistIndexPath = resolve(
    rootDir,
    'apps',
    'cli',
    'node_modules',
    '@happier-dev',
    'protocol',
    'dist',
    'index.js',
  );
  return hasValidProtocolDistIndexExportsAtPath(workspaceProtocolDistIndexPath)
    && hasValidProtocolDistIndexExportsAtPath(bundledProtocolDistIndexPath);
}

function hasCliSharedDepsOutputs(
  rootDir: string,
  opts: { skipSourceFreshnessCheck?: boolean; beforeRepairBundledWorkspaceDistSymlink?: EnsureCliSharedDepsBuiltOptions['beforeRepairBundledWorkspaceDistSymlink'] } = {},
): boolean {
  const workspaceOutputPaths = resolveCliSharedDepsOutputPaths(rootDir);
  if (!workspaceOutputPaths.every((candidatePath) => existsSync(candidatePath))) {
    return false;
  }

  repairMissingCliBundledSharedDepsOutputs(rootDir, {
    beforeRepairBundledWorkspaceDistSymlink: opts.beforeRepairBundledWorkspaceDistSymlink,
  });
  if (!hasCliBundledSharedDepsOutputs(rootDir)) return false;
  if (!hasValidCliSharedDepsProtocolExports(rootDir)) return false;
  if (opts.skipSourceFreshnessCheck) return true;

  return !areBuildOutputsStale({
    sourcePaths: resolveCliSharedDepsSourcePaths(rootDir),
    outputPaths: resolveCliBundledSharedDepsOutputPaths(rootDir),
  });
}

type CliSharedDepsHealthReport = Readonly<{
  cliNodeModulesDirExists: boolean;
  sourceFreshnessIgnored: boolean;
  workspaceOutputsPresent: boolean;
  bundledOutputsPresent: boolean;
  protocolExportsHealthy: boolean;
  packages: ReadonlyArray<Readonly<{
    packageName: CliSharedDepPackageName;
    packageDirExists: boolean;
    manifestParity: boolean;
    expectedOutputsPresent: boolean;
    missingExpectedOutputs: readonly string[];
    distParity: boolean;
    runtimeTreeHealthy: boolean;
  }>>;
}>;

function describeCliSharedDepsHealth(
  rootDir: string,
  opts: { skipSourceFreshnessCheck?: boolean } = {},
): CliSharedDepsHealthReport {
  const cliNodeModulesDir = resolve(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev');
  const workspaceOutputPaths = resolveCliSharedDepsOutputPaths(rootDir);
  const bundledOutputPaths = resolveCliBundledSharedDepsOutputPaths(rootDir);
  const packages = CLI_SHARED_DEP_PACKAGE_NAMES.map((packageName) => {
    const packageDir = resolveCliBundledWorkspacePackageDir(rootDir, packageName);
    const packageExists = existsSync(packageDir);
    const expectedOutputPaths = resolveCliBundledWorkspaceExpectedOutputPaths(rootDir, packageName);
    const missingExpectedOutputs = expectedOutputPaths.filter((candidatePath) => !existsSync(candidatePath));
    const packageJsonPath = resolve(packageDir, 'package.json');
    return {
      packageName,
      packageDirExists: packageExists,
      manifestParity: hasCliBundledWorkspaceManifestParity(rootDir, packageName),
      expectedOutputsPresent: missingExpectedOutputs.length === 0,
      missingExpectedOutputs,
      distParity: hasCliBundledWorkspaceDistParity(rootDir, packageName),
      runtimeTreeHealthy: isBundledWorkspaceRuntimeDependencyTreeHealthy(packageJsonPath),
    };
  });

  return {
    cliNodeModulesDirExists: existsSync(cliNodeModulesDir),
    sourceFreshnessIgnored: opts.skipSourceFreshnessCheck ?? false,
    workspaceOutputsPresent: workspaceOutputPaths.every((candidatePath) => existsSync(candidatePath)),
    bundledOutputsPresent: bundledOutputPaths.every((candidatePath) => existsSync(candidatePath)),
    protocolExportsHealthy: hasValidCliSharedDepsProtocolExports(rootDir),
    packages,
  };
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
  // Many provider/E2E harnesses pass a fresh temporary directory; make sure we can always
  // write build logs without requiring callers to pre-create the folder.
  mkdirSync(params.testDir, { recursive: true });
  if (shouldSkipCliSharedDepsBuildForE2e(params.env)) {
    return;
  }

  const rootDir = options.repoRoot ?? repoRootDir();
  const skipSourceFreshnessCheck = options.skipSourceFreshnessCheck ?? false;
  const maxBuildAttempts = Math.max(1, options.maxBuildAttempts ?? 2);
  const existing = ensureSharedPromisesByRepoRoot.get(rootDir);
  if (existing) return await existing;

  if (hasCliSharedDepsOutputs(rootDir, {
    skipSourceFreshnessCheck,
    beforeRepairBundledWorkspaceDistSymlink: options.beforeRepairBundledWorkspaceDistSymlink,
  })) {
    return;
  }

  const promise = (async () => {
    if (hasCliSharedDepsOutputs(rootDir, {
      skipSourceFreshnessCheck,
      beforeRepairBundledWorkspaceDistSymlink: options.beforeRepairBundledWorkspaceDistSymlink,
    })) {
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

      if (hasCliSharedDepsOutputs(rootDir, {
        skipSourceFreshnessCheck,
        beforeRepairBundledWorkspaceDistSymlink: options.beforeRepairBundledWorkspaceDistSymlink,
      })) {
        return;
      }
    }

    if (!hasCliSharedDepsOutputs(rootDir, {
      skipSourceFreshnessCheck,
      beforeRepairBundledWorkspaceDistSymlink: options.beforeRepairBundledWorkspaceDistSymlink,
    })) {
      throw new Error(
        `Shared workspace deps output missing after build: ${resolve(rootDir, 'packages')} | health=${JSON.stringify(describeCliSharedDepsHealth(rootDir, { skipSourceFreshnessCheck }))}`,
      );
    }
  })();

  try {
    ensureSharedPromisesByRepoRoot.set(rootDir, promise);
    return await promise;
  } finally {
    ensureSharedPromisesByRepoRoot.delete(rootDir);
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
  if (!shouldSkipCliSharedDepsBuildForE2e(params.env)) {
    await ensureCliSharedDepsBuilt(params, {
      repoRoot: rootDir,
      runCommand: options.runCommand,
      skipSourceFreshnessCheck: options.skipSourceFreshnessCheck,
      timeoutMs: options.timeoutMs,
      pollIntervalMs: options.pollIntervalMs,
      staleAfterMs: options.staleAfterMs,
    });
  }
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
  const existingEnsure = ensureDistPromisesByRepoRoot.get(rootDir);
  if (existingEnsure) {
    await existingEnsure.catch(() => {});
    ensureDistPromisesByRepoRoot.delete(rootDir);
    const availableEntrypoint = resolveReusableEntrypoint();
    if (availableEntrypoint) return availableEntrypoint;
  }

  const promise = withCliDistBuildLock(async () => {
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

  ensureDistPromisesByRepoRoot.set(rootDir, promise);
  try {
    return await promise;
  } finally {
    ensureDistPromisesByRepoRoot.delete(rootDir);
  }
}

function isHealthyCliDist(dir: string): boolean {
  const entrypoint = resolveCliDistEntrypoint(dir);
  if (!existsSync(entrypoint)) return false;
  return findMissingDistChunkImports(dir).length === 0;
}

function isCliDistSnapshotStale(params: {
  rootDir: string;
  snapshotDir: string;
  snapshotDistDir: string;
}): boolean {
  const canonicalDistDir = resolveCliDistDir(params.rootDir);
  if (!existsSync(resolveCliDistEntrypoint(canonicalDistDir))) {
    return true;
  }
  if (isBuildDirectoryStale({
    sourcePaths: [canonicalDistDir],
    outputDir: params.snapshotDistDir,
    mtimeToleranceMs: CLI_DIST_SNAPSHOT_MTIME_TOLERANCE_MS,
  })) {
    return true;
  }

  return CLI_SHARED_DEP_PACKAGE_NAMES.some((packageName) => {
    const bundledPackageDir = resolveCliBundledWorkspacePackageDir(params.rootDir, packageName);
    const snapshotPackageDir = resolve(params.snapshotDir, 'node_modules', '@happier-dev', packageName);
    if (!existsSync(bundledPackageDir) || !existsSync(snapshotPackageDir)) {
      return true;
    }
    return isBuildDirectoryStale({
      sourcePaths: [bundledPackageDir],
      outputDir: snapshotPackageDir,
      mtimeToleranceMs: CLI_DIST_SNAPSHOT_MTIME_TOLERANCE_MS,
    });
  });
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
  const snapshotLockPath = resolveCliDistSnapshotLockPath({
    rootDir,
    snapshotDir: options.snapshotDir,
    defaultLockPath: distLockPath,
  });
  const snapshotDistDir = resolve(options.snapshotDir, 'dist');
  const snapshotEntrypoint = resolve(snapshotDistDir, 'index.mjs');
  const maxAttempts = 3;
  const snapshotReadyMarkerExists = (dir: string): boolean => {
    return existsSync(resolve(dir, '.cli-dist-snapshot.ready.json'));
  };
  const snapshotHasReadyMarker = (dir: string): boolean => {
    return snapshotReadyMarkerExists(dir)
      && hasCliDistSnapshotNodeModulesHealth(rootDir, dir)
      && hasCliDistSnapshotProtocolRootImportCompatibility(dir);
  };
  const isReadyReusableSnapshot = (dir: string): boolean => {
    const distDir = resolve(dir, 'dist');
    if (!isHealthyCliDist(distDir) || !snapshotHasReadyMarker(dir)) {
      return false;
    }
    if (options.skipSourceFreshnessCheck ?? false) {
      return true;
    }
    return !isCliDistSnapshotStale({
      rootDir,
      snapshotDir: dir,
      snapshotDistDir: distDir,
    });
  };
  const ensureSnapshotScaffolding = (dir: string): void => {
    ensureSnapshotProjectFile(dir, rootDir, 'package.json');
    ensureSnapshotProjectLink(dir, rootDir, 'scripts');
    ensureSnapshotProjectLink(dir, rootDir, 'tools');
    ensureSnapshotProjectLink(dir, rootDir, 'bin');
    ensureSnapshotProjectFile(dir, rootDir, 'tsconfig.json');
  };
  const ensureSnapshotNodeModules = (dir: string): void => {
    const mode = (params.env.HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE ?? '').toString().trim().toLowerCase();
    if (mode === 'symlink') {
      const snapshotNodeModulesDir = resolve(dir, 'node_modules');
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
      snapshotDir: dir,
      snapshotDistDir: resolve(dir, 'dist'),
      rootDir,
    });
  };
  const findReusableReplacementSnapshotEntrypoint = (): string | null => {
    const parentDir = dirname(options.snapshotDir);
    const replacementPrefix = `${basename(options.snapshotDir)}-`;
    let candidates: Array<{ dir: string; mtimeMs: number }> = [];
    try {
      candidates = readdirSync(parentDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith(replacementPrefix))
        .map((entry) => {
          const dir = resolve(parentDir, entry.name);
          let mtimeMs = 0;
          try {
            mtimeMs = statSync(resolve(dir, '.cli-dist-snapshot.ready.json')).mtimeMs;
          } catch {
            mtimeMs = 0;
          }
          return { dir, mtimeMs };
        })
        .filter(({ dir }) => isReadyReusableSnapshot(dir));
    } catch {
      return null;
    }

    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const best = candidates[0]?.dir;
    if (!best) return null;
    ensureSnapshotNodeModules(best);
    ensureSnapshotScaffolding(best);
    return resolve(best, 'dist', 'index.mjs');
  };

  if (options.skipSourceFreshnessCheck ?? false) {
    const replacementEntrypoint = findReusableReplacementSnapshotEntrypoint();
    if (replacementEntrypoint) return replacementEntrypoint;
  }

  if (isReadyReusableSnapshot(options.snapshotDir)) {
    ensureSnapshotNodeModules(options.snapshotDir);
    ensureSnapshotScaffolding(options.snapshotDir);
    return snapshotEntrypoint;
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let retryCleanupSnapshotDir: string | null = null;
    // Ensure dist is available first. We intentionally do this outside the snapshot lock to avoid
    // re-entering the same lock from ensureCliDistBuilt.
    await ensureCliDistBuilt(params, { ...options, repoRoot: rootDir, lockPath: distLockPath });

    try {
      return await withCliDistBuildLock(
        async () => {
          const shouldIgnoreSnapshotFreshness = options.skipSourceFreshnessCheck ?? false;
          const isSnapshotStale = (distDir: string): boolean => {
            if (shouldIgnoreSnapshotFreshness) return false;
            return isCliDistSnapshotStale({
              rootDir,
              snapshotDir: options.snapshotDir,
              snapshotDistDir: distDir,
            });
          };

          const snapshotIsReusable = (dir: string): boolean => {
            const distDir = resolve(dir, 'dist');
            return isHealthyCliDist(distDir) && !isSnapshotStale(distDir);
          };

          const snapshotIsReadyButStale = (dir: string): boolean => {
            const distDir = resolve(dir, 'dist');
            return existsSync(dir)
              && snapshotReadyMarkerExists(dir)
              && isHealthyCliDist(distDir)
              && (
                !hasCliDistSnapshotProtocolExportsHealth(dir)
                || !hasCliDistSnapshotProtocolRootImportCompatibility(dir)
                || isSnapshotStale(distDir)
              );
          };

          const resolveReplacementSnapshotDir = (): string => {
            return `${options.snapshotDir}-${process.pid}-${Date.now()}-${attempt}`;
          };

          const markSnapshotReady = (dir: string): void => {
            if (snapshotHasReadyMarker(dir)) return;
            try {
              writeFileSync(
                resolve(dir, '.cli-dist-snapshot.ready.json'),
                JSON.stringify({ v: 1, createdAt: new Date().toISOString() }),
                'utf8',
              );
            } catch {
              // Best-effort only.
            }
          };

          const resolveSnapshotSourceDistDir = (): string => {
            const distDir = resolveExistingCliDistDir({
              rootDir,
              skipDistIntegrityCheck: options.skipDistIntegrityCheck ?? false,
              skipSourceFreshnessCheck: options.skipSourceFreshnessCheck ?? false,
            });
            if (distDir) {
              return distDir;
            }

            const canonicalDistDir = resolveCliDistDir(rootDir);
            const missing = findMissingDistChunkImports(canonicalDistDir);
            throw new Error(
              missing.length > 0
                ? `Refusing to snapshot an incomplete CLI dist (missing chunk imports): ${missing.join(', ')}`
                : `Refusing to snapshot an incomplete CLI dist (missing index.mjs): ${resolveCliDistEntrypoint(canonicalDistDir)}`,
            );
          };

          const materializeSnapshot = async (targetSnapshotDir: string, distDir: string): Promise<string> => {
            retryCleanupSnapshotDir = targetSnapshotDir;
            const targetSnapshotDistDir = resolve(targetSnapshotDir, 'dist');
            const targetSnapshotEntrypoint = resolve(targetSnapshotDistDir, 'index.mjs');

            mkdirSync(dirname(targetSnapshotDir), { recursive: true });
            // Ensure we never mutate an existing snapshot (which could be in-use by a running daemon).
            if (existsSync(targetSnapshotDir)) {
              rmSync(targetSnapshotDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
            }
            mkdirSync(targetSnapshotDir, { recursive: true });
            await cp(distDir, targetSnapshotDistDir, { recursive: true });
            ensureSnapshotNodeModules(targetSnapshotDir);
            ensureSnapshotScaffolding(targetSnapshotDir);

            if (!(options.skipDistIntegrityCheck ?? false) && !isHealthyCliDist(targetSnapshotDistDir)) {
              const missing = findMissingDistChunkImports(targetSnapshotDistDir);
              throw new Error(
                missing.length > 0
                  ? `CLI dist snapshot missing chunk imports: ${missing.join(', ')}`
                  : `CLI dist snapshot missing entrypoint: ${targetSnapshotEntrypoint}`,
              );
            }
            if (!hasCliDistSnapshotProtocolRootImportCompatibility(targetSnapshotDir)) {
              throw new Error('CLI dist snapshot imports protocol root exports that are not available in the snapshot');
            }

            markSnapshotReady(targetSnapshotDir);
            return targetSnapshotEntrypoint;
          };

          if (snapshotIsReusable(options.snapshotDir) && snapshotHasReadyMarker(options.snapshotDir)) {
            // Fast path: keep daemon startups cheap during slow E2E lanes.
            // Still reconcile runtime deps so stale snapshots self-heal when bundled dependency shapes change.
            ensureSnapshotNodeModules(options.snapshotDir);
            ensureSnapshotScaffolding(options.snapshotDir);
            return snapshotEntrypoint;
          }

          if (snapshotIsReadyButStale(options.snapshotDir)) {
            const replacementEntrypoint = findReusableReplacementSnapshotEntrypoint();
            if (replacementEntrypoint) return replacementEntrypoint;
            const distDir = resolveSnapshotSourceDistDir();
            return await materializeSnapshot(resolveReplacementSnapshotDir(), distDir);
          }

          // If a previous run left a partial snapshot behind, self-heal instead of failing closed.
          if (existsSync(options.snapshotDir) && !snapshotIsReusable(options.snapshotDir)) {
            rmSync(options.snapshotDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
          }

          if (snapshotIsReusable(options.snapshotDir)) {
            ensureSnapshotNodeModules(options.snapshotDir);
            ensureSnapshotScaffolding(options.snapshotDir);
            markSnapshotReady(options.snapshotDir);
            return snapshotEntrypoint;
          }

          const distDir = resolveSnapshotSourceDistDir();
          return await materializeSnapshot(options.snapshotDir, distDir);
        },
        {
          lockPath: snapshotLockPath,
          timeoutMs: options.timeoutMs,
          pollIntervalMs: options.pollIntervalMs,
          staleAfterMs: options.staleAfterMs,
        },
      );
    } catch (error: any) {
      if (error?.code === 'ENOENT' && retryCleanupSnapshotDir && !snapshotHasReadyMarker(retryCleanupSnapshotDir)) {
        rmSync(retryCleanupSnapshotDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      }
      if (error?.code !== 'ENOENT' || attempt === maxAttempts) {
        throw error;
      }
    }
  }

  throw new Error(`Failed to create CLI dist snapshot after ${maxAttempts} attempts: ${snapshotEntrypoint}`);
}
