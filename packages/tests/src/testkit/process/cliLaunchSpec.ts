import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import {
  resolveWorkspaceBundleLockPath,
  withWorkspaceBundleLock,
} from '@happier-dev/cli-common/workspaceBundleLock';

import { repoRootDir } from '../paths';
import {
  ensureCliBundledPluginProjectionsCurrent,
  ensureCliDistSnapshotEntrypoint,
  ensureCliSharedDepsBuilt,
  ensureCliSourceDevSharedDepsCurrent,
  shouldSkipCliSharedDepsBuild,
} from './cliDist';
import {
  ensureCliDistSnapshotNodeModules,
  hasCliDistSnapshotFirstPartyCopyClosure,
} from './cliDistSnapshotNodeModules';
import { resolveTsxImportHookSpecifier } from './tsxImportHook';
import { resolveCliWorkspacePackageDir } from './workspacePackageResolution';

export type CliTestLaunchSpec = Readonly<{
  command: string;
  args: string[];
  cwd?: string;
  env?: Readonly<Record<string, string | undefined>>;
  cleanup?: () => void | Promise<void>;
}>;

export async function resolveCliTestLaunchSpecOrOverride(
  explicit: CliTestLaunchSpec | undefined,
  resolveDefault: () => Promise<CliTestLaunchSpec>,
): Promise<CliTestLaunchSpec> {
  return explicit ?? await resolveDefault();
}

type CliLaunchOptions = Parameters<typeof ensureCliDistSnapshotEntrypoint>[1] & {
  preferSourceEntrypoint?: boolean;
  preparedDistSnapshotOnly?: boolean;
};

function resolveCliSourceEntrypoint(rootDir: string): string {
  return resolve(rootDir, 'apps', 'cli', 'src', 'index.ts');
}

function resolveCliSnapshotSourceEntrypoint(snapshotDir: string): string {
  return resolve(snapshotDir, 'src', 'index.ts');
}

function resolveCliTsconfigPath(snapshotDir: string): string {
  return resolve(snapshotDir, 'tsconfig.json');
}

function resolvePreparedDistSnapshotEntrypoint(snapshotDir: string): string {
  const packageEntrypoint = resolve(snapshotDir, 'dist', 'index.mjs');
  const releaseEntrypoint = resolve(snapshotDir, 'package-dist', 'index.mjs');
  const entrypoint = existsSync(packageEntrypoint) ? packageEntrypoint : releaseEntrypoint;
  const readyMarker = resolve(snapshotDir, '.cli-dist-snapshot.ready.json');
  const nodeModulesDir = resolve(snapshotDir, 'node_modules');
  if (!existsSync(readyMarker) || !existsSync(entrypoint) || !existsSync(nodeModulesDir)) {
    throw new Error(`Expected an already-prepared CLI dist snapshot at ${snapshotDir}`);
  }
  return entrypoint;
}

type CliSnapshotNodeModulesMode = 'auto' | 'copy' | 'symlink';

let sourceSnapshotGeneration = 0;

function resolveCliSnapshotNodeModulesMode(env: NodeJS.ProcessEnv): CliSnapshotNodeModulesMode {
  const raw = (env.HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE ?? '')
    .toString()
    .trim()
    .toLowerCase();
  if (raw === 'copy' || raw === 'symlink') return raw;
  return raw ? 'copy' : 'auto';
}

function materializeCliSourceSnapshot(
  snapshotDir: string,
  rootDir: string,
  snapshotNodeModulesMode: CliSnapshotNodeModulesMode,
): void {
  mkdirSync(snapshotDir, { recursive: true });

  const linkTargets = ['src', 'scripts', 'tools', 'bin'];
  for (const relPath of linkTargets) {
    const target = resolve(rootDir, 'apps', 'cli', relPath);
    if (!existsSync(target)) continue;
    const dest = resolve(snapshotDir, relPath);
    if (existsSync(dest)) continue;
    if (snapshotNodeModulesMode === 'copy') {
      cpSync(target, dest, {
        recursive: true,
        dereference: true,
        preserveTimestamps: true,
      });
      continue;
    }
    symlinkSync(target, dest, process.platform === 'win32' ? 'junction' : 'dir');
  }

  const snapshotNodeModulesDir = resolve(snapshotDir, 'node_modules');
  let snapshotNodeModulesUsesSymlinkOverlay = false;

  const symlinkNodeModule = (source: string, dest: string): void => {
    if (existsSync(dest)) return;
    try {
      const stat = lstatSync(source);
      const type = stat.isDirectory()
        ? process.platform === 'win32'
          ? 'junction'
          : 'dir'
        : 'file';
      symlinkSync(source, dest, type);
    } catch {
      // Best-effort only.
    }
  };

  const linkNodeModulesOverlayEntries = (sourceDir: string): void => {
    if (!existsSync(sourceDir)) return;
    for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
      const source = resolve(sourceDir, entry.name);
      const dest = resolve(snapshotNodeModulesDir, entry.name);
      if (entry.name.startsWith('@') && entry.isDirectory()) {
        mkdirSync(dest, { recursive: true });
        for (const scopedEntry of readdirSync(source, { withFileTypes: true })) {
          symlinkNodeModule(resolve(source, scopedEntry.name), resolve(dest, scopedEntry.name));
        }
        continue;
      }
      symlinkNodeModule(source, dest);
    }
  };

  const ensureSymlinkNodeModules = (): void => {
    if (existsSync(snapshotNodeModulesDir)) {
      try {
        const stat = lstatSync(snapshotNodeModulesDir);
        if (snapshotNodeModulesMode !== 'symlink') {
          return;
        }
        if (stat.isSymbolicLink() || stat.isDirectory()) {
          rmSync(snapshotNodeModulesDir, { recursive: true, force: true });
        }
      } catch {
        return;
      }
    }
    const rootNodeModulesDir = resolve(rootDir, 'node_modules');
    const cliNodeModulesDir = resolve(rootDir, 'apps', 'cli', 'node_modules');
    const sourceDirs = [cliNodeModulesDir, rootNodeModulesDir].filter((sourceDir) => existsSync(sourceDir));
    if (sourceDirs.length === 0) return;

    mkdirSync(dirname(snapshotNodeModulesDir), { recursive: true });
    try {
      mkdirSync(snapshotNodeModulesDir, { recursive: true });
      for (const sourceDir of sourceDirs) {
        linkNodeModulesOverlayEntries(sourceDir);
      }
      snapshotNodeModulesUsesSymlinkOverlay = true;
    } catch {
      // Best-effort only.
    }
  };

  if (snapshotNodeModulesMode !== 'copy') {
    ensureSymlinkNodeModules();
  }

  const snapshotNodeModulesIsSymlink = (() => {
    if (!existsSync(snapshotNodeModulesDir)) return false;
    try {
      return lstatSync(snapshotNodeModulesDir).isSymbolicLink();
    } catch {
      return false;
    }
  })();

  if (!snapshotNodeModulesUsesSymlinkOverlay && !snapshotNodeModulesIsSymlink && snapshotNodeModulesMode !== 'symlink') {
    ensureCliDistSnapshotNodeModules({
      snapshotDir,
      snapshotDistDir: resolve(snapshotDir, 'dist'),
      rootDir,
      firstPartyClosureMode: snapshotNodeModulesMode === 'copy' ? 'bundled-only' : 'workspace-overlay',
    });
  }

  for (const relPath of ['package.json', 'tsconfig.json']) {
    const target = resolve(rootDir, 'apps', 'cli', relPath);
    if (!existsSync(target)) continue;
    const dest = resolve(snapshotDir, relPath);
    if (existsSync(dest)) continue;
    writeFileSync(dest, readFileSync(target));
  }
}

type CliSourceSnapshotOutputSignature = Readonly<{
  path: string;
  size: number;
  mtimeMs: number;
}>;

type CliSourceSnapshotPackageAdmission = Readonly<{
  dependencies: readonly string[];
  outputs: readonly CliSourceSnapshotOutputSignature[];
  dist: Readonly<{
    fileCount: number;
    totalBytes: number;
  }>;
}>;

function normalizeSnapshotRelativePath(path: string): string {
  return path.replaceAll('\\', '/');
}

function isSafeSnapshotWorkspaceName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

function listPackageOutputSignatures(packageDir: string): CliSourceSnapshotOutputSignature[] {
  const outputPaths = new Set<string>(['package.json']);

  let packageJson: Record<string, unknown> = {};
  try {
    packageJson = JSON.parse(readFileSync(resolve(packageDir, 'package.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    // The closure validator below will reject a missing or malformed manifest.
  }
  const collectDeclaredOutputTargets = (value: unknown): void => {
    if (typeof value === 'string') {
      if (value.startsWith('./') && !value.includes('*')) {
        outputPaths.add(normalizeSnapshotRelativePath(value.slice(2)));
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) collectDeclaredOutputTargets(item);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const nested of Object.values(value)) collectDeclaredOutputTargets(nested);
  };
  collectDeclaredOutputTargets(packageJson.main);
  collectDeclaredOutputTargets(packageJson.module);
  collectDeclaredOutputTargets(packageJson.types);
  collectDeclaredOutputTargets(packageJson.exports);

  return [...outputPaths]
    .sort()
    .map((relativePath) => {
      const stats = statSync(resolve(packageDir, ...relativePath.split('/')));
      if (!stats.isFile()) {
        throw new Error(`CLI source snapshot package output is not a file: ${relativePath}`);
      }
      return {
        path: relativePath,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
      };
    });
}

function readPackageDistAggregate(packageDir: string): { fileCount: number; totalBytes: number } {
  let fileCount = 0;
  let totalBytes = 0;
  const visit = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolutePath = resolve(dir, entry.name);
      const stats = lstatSync(absolutePath);
      if (stats.isSymbolicLink()) {
        throw new Error(`CLI source snapshot package dist contains a symlink: ${absolutePath}`);
      }
      if (stats.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      if (!stats.isFile()) continue;
      fileCount += 1;
      totalBytes += stats.size;
    }
  };
  visit(resolve(packageDir, 'dist'));
  return { fileCount, totalBytes };
}

function readInternalWorkspaceDependencies(packageJsonPath: string): string[] {
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    dependencies?: Record<string, unknown>;
    optionalDependencies?: Record<string, unknown>;
  };
  const dependencies = new Set<string>();
  for (const dependencyMap of [packageJson.dependencies, packageJson.optionalDependencies]) {
    if (!dependencyMap || typeof dependencyMap !== 'object') continue;
    for (const dependencyName of Object.keys(dependencyMap)) {
      if (!dependencyName.startsWith('@happier-dev/')) continue;
      const workspaceName = dependencyName.slice('@happier-dev/'.length).trim();
      if (!isSafeSnapshotWorkspaceName(workspaceName)) {
        throw new Error(`CLI source snapshot has an invalid workspace dependency name: ${dependencyName}`);
      }
      dependencies.add(workspaceName);
    }
  }
  return [...dependencies].sort();
}

function hasNoSymlinkEntries(rootPath: string): boolean {
  if (!existsSync(rootPath)) return true;
  if (lstatSync(rootPath).isSymbolicLink()) return false;
  if (!lstatSync(rootPath).isDirectory()) return true;
  return readdirSync(rootPath, { withFileTypes: true }).every((entry) =>
    hasNoSymlinkEntries(resolve(rootPath, entry.name)));
}

function publishCliSourceSnapshotAdmission(snapshotDir: string, rootDir: string): void {
  for (const relativePath of ['src', 'scripts', 'tools', 'bin', 'package.json', 'tsconfig.json']) {
    const candidatePath = resolve(snapshotDir, relativePath);
    if (!hasNoSymlinkEntries(candidatePath)) {
      throw new Error(`CLI source copy snapshot aliases live source/config: ${candidatePath}`);
    }
  }

  const packages: Record<string, CliSourceSnapshotPackageAdmission> = {};
  const scopeDir = resolve(snapshotDir, 'node_modules', '@happier-dev');
  for (const entry of readdirSync(scopeDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (!isSafeSnapshotWorkspaceName(entry.name)) {
      throw new Error(`CLI source snapshot has an invalid workspace package name: ${entry.name}`);
    }
    const packageDir = resolve(scopeDir, entry.name);
    if (lstatSync(packageDir).isSymbolicLink()) {
      throw new Error(`CLI source snapshot package aliases live node_modules: ${packageDir}`);
    }
    const packageJsonPath = resolve(packageDir, 'package.json');
    const workspacePackageJsonPath = resolve(
      resolveCliWorkspacePackageDir(rootDir, entry.name),
      'package.json',
    );
    packages[entry.name] = {
      dependencies: readInternalWorkspaceDependencies(
        existsSync(workspacePackageJsonPath)
          ? workspacePackageJsonPath
          : packageJsonPath,
      ),
      outputs: listPackageOutputSignatures(packageDir),
      dist: readPackageDistAggregate(packageDir),
    };
  }
  for (const [workspaceName, packageAdmission] of Object.entries(packages)) {
    for (const dependencyWorkspaceName of packageAdmission.dependencies) {
      if (packages[dependencyWorkspaceName]) continue;
      throw new Error(
        `CLI source snapshot workspace closure is missing ${dependencyWorkspaceName}, required by ${workspaceName}`,
      );
    }
  }

  writeFileSync(
    resolve(snapshotDir, '.cli-source-snapshot-admission.json'),
    `${JSON.stringify({ version: 1, packages })}\n`,
    'utf8',
  );
}

function publishCliSourceCopySnapshot(
  snapshotDir: string,
  rootDir: string,
): Readonly<{ snapshotDir: string; cleanup: () => Promise<void> }> {
  sourceSnapshotGeneration += 1;
  const generationSuffix = `${process.pid}-${Date.now()}-${sourceSnapshotGeneration}`;
  const snapshotParentDir = dirname(snapshotDir);
  const publishedSnapshotDir = resolve(
    snapshotParentDir,
    `cli-source-snapshot-source-${generationSuffix}`,
  );
  const stagingSnapshotDir = `${publishedSnapshotDir}.source-snapshot-tmp.${generationSuffix}`;

  mkdirSync(snapshotParentDir, { recursive: true });
  rmSync(stagingSnapshotDir, { recursive: true, force: true });
  try {
    materializeCliSourceSnapshot(stagingSnapshotDir, rootDir, 'copy');
    if (!hasCliDistSnapshotFirstPartyCopyClosure({ snapshotDir: stagingSnapshotDir, rootDir })) {
      throw new Error(
        `CLI source snapshot first-party dependency closure is incomplete or aliases live node_modules: ${stagingSnapshotDir}`,
      );
    }
    publishCliSourceSnapshotAdmission(stagingSnapshotDir, rootDir);
    renameSync(stagingSnapshotDir, publishedSnapshotDir);
    return {
      snapshotDir: publishedSnapshotDir,
      cleanup: async () => await rm(publishedSnapshotDir, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(stagingSnapshotDir, { recursive: true, force: true });
    throw error;
  }
}

async function resolveCliSourceLaunchSpec(
  params: Readonly<{ testDir: string; env: NodeJS.ProcessEnv }>,
  rootDir: string,
  options: CliLaunchOptions,
): Promise<CliTestLaunchSpec> {
  const snapshotNodeModulesMode = resolveCliSnapshotNodeModulesMode(params.env);
  const skipSharedDepsBuild = shouldSkipCliSharedDepsBuild(params.env);
  const ensureSharedDeps = async (env: NodeJS.ProcessEnv): Promise<void> => {
    await ensureCliSharedDepsBuilt(
      { ...params, env },
      {
        repoRoot: rootDir,
        runCommand: options.runCommand,
        skipSourceFreshnessCheck: options.skipSourceFreshnessCheck,
        timeoutMs: options.timeoutMs,
        pollIntervalMs: options.pollIntervalMs,
        staleAfterMs: options.staleAfterMs,
        buildTimeoutMs: options.buildTimeoutMs,
      },
    );
  };

  let snapshotDir: string;
  let cleanup: (() => Promise<void>) | undefined;
  if (snapshotNodeModulesMode === 'copy') {
    const publishedSnapshot = await withWorkspaceBundleLock(
      async ({ heldLockValue }) => {
        const lockedEnv = {
          ...params.env,
          HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: heldLockValue,
        };
        await ensureSharedDeps(lockedEnv);
        if (skipSharedDepsBuild || options.skipSourceFreshnessCheck === true) {
          await ensureCliSourceDevSharedDepsCurrent(
            { ...params, env: lockedEnv },
            {
              repoRoot: rootDir,
              runCommand: options.runCommand,
              buildTimeoutMs: options.buildTimeoutMs,
            },
          );
        }
        await ensureCliBundledPluginProjectionsCurrent(
          { ...params, env: lockedEnv },
          {
            repoRoot: rootDir,
            runCommand: options.runCommand,
            buildTimeoutMs: options.buildTimeoutMs,
          },
        );
        return publishCliSourceCopySnapshot(options.snapshotDir, rootDir);
      },
      {
        lockPath: resolveWorkspaceBundleLockPath(rootDir),
        heldLockValue: params.env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD,
        timeoutMs: options.timeoutMs,
        pollIntervalMs: options.pollIntervalMs,
        staleAfterMs: options.staleAfterMs,
        errorLabel: 'CLI source snapshot dependency-closure lock',
      },
    );
    snapshotDir = publishedSnapshot.snapshotDir;
    cleanup = publishedSnapshot.cleanup;
  } else {
    await ensureSharedDeps(params.env);
    snapshotDir = options.snapshotDir;
    materializeCliSourceSnapshot(snapshotDir, rootDir, snapshotNodeModulesMode);
  }

  try {
    const sourceEntrypoint = resolveCliSnapshotSourceEntrypoint(snapshotDir);
    if (!existsSync(sourceEntrypoint)) {
      throw new Error(`CLI source entrypoint missing for test launch: ${sourceEntrypoint}`);
    }

    const tsxHookSpecifier = resolveTsxImportHookSpecifier();
    if (!tsxHookSpecifier) {
      throw new Error('tsx import hook is required for CLI source entrypoint mode but could not be resolved');
    }

    return {
      command: process.execPath,
      args: ['--preserve-symlinks', '--preserve-symlinks-main', '--import', tsxHookSpecifier, sourceEntrypoint],
      cwd: snapshotDir,
      env: {
        TSX_TSCONFIG_PATH: resolveCliTsconfigPath(snapshotDir),
      },
      ...(cleanup ? { cleanup } : {}),
    };
  } catch (error) {
    try {
      await cleanup?.();
    } catch (cleanupError) {
      const primary = error instanceof Error ? error : new Error(String(error));
      const cleanupFailure = cleanupError instanceof Error
        ? cleanupError
        : new Error(String(cleanupError));
      throw new AggregateError(
        [primary, cleanupFailure],
        'CLI source launch-spec publication and cleanup failed',
      );
    }
    throw error;
  }
}

export function shouldUseCliSourceEntrypoint(env: NodeJS.ProcessEnv): boolean {
  const raw = (
    env.HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT ??
    env.HAPPY_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT ??
    ''
  )
    .toString()
    .trim()
    .toLowerCase();

  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'y';
}

export async function resolveCliTestLaunchSpec(
  params: Readonly<{ testDir: string; env: NodeJS.ProcessEnv }>,
  options: CliLaunchOptions,
): Promise<CliTestLaunchSpec> {
  const rootDir = options.repoRoot ?? repoRootDir();

  if (options.preparedDistSnapshotOnly) {
    return {
      command: process.execPath,
      args: ['--preserve-symlinks', resolvePreparedDistSnapshotEntrypoint(options.snapshotDir)],
    };
  }

  if (options.preferSourceEntrypoint || shouldUseCliSourceEntrypoint(params.env)) {
    return await resolveCliSourceLaunchSpec(params, rootDir, options);
  }

  let snapshotEntrypoint: string;
  try {
    snapshotEntrypoint = await ensureCliDistSnapshotEntrypoint(params, options);
  } catch (error) {
    if (!existsSync(resolveCliSourceEntrypoint(rootDir))) {
      throw error;
    }
    return resolveCliSourceLaunchSpec(params, rootDir, options);
  }

  return {
    command: process.execPath,
    args: ['--preserve-symlinks', snapshotEntrypoint],
  };
}
