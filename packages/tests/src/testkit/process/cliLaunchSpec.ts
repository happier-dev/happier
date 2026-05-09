import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { repoRootDir } from '../paths';
import { ensureCliDistSnapshotEntrypoint, ensureCliSharedDepsBuilt } from './cliDist';
import { ensureCliDistSnapshotNodeModules } from './cliDistSnapshotNodeModules';
import { resolveTsxImportHookSpecifier } from './tsxImportHook';

export type CliTestLaunchSpec = Readonly<{
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}>;

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
  const entrypoint = resolve(snapshotDir, 'dist', 'index.mjs');
  const readyMarker = resolve(snapshotDir, '.cli-dist-snapshot.ready.json');
  const nodeModulesDir = resolve(snapshotDir, 'node_modules');
  if (!existsSync(readyMarker) || !existsSync(entrypoint) || !existsSync(nodeModulesDir)) {
    throw new Error(`Expected an already-prepared CLI dist snapshot at ${snapshotDir}`);
  }
  return entrypoint;
}

function ensureCliSourceSnapshot(
  snapshotDir: string,
  rootDir: string,
  env: NodeJS.ProcessEnv,
): void {
  mkdirSync(snapshotDir, { recursive: true });

  const linkTargets = ['src', 'scripts', 'tools', 'bin'];
  for (const relPath of linkTargets) {
    const target = resolve(rootDir, 'apps', 'cli', relPath);
    if (!existsSync(target)) continue;
    const dest = resolve(snapshotDir, relPath);
    if (existsSync(dest)) continue;
    symlinkSync(target, dest, process.platform === 'win32' ? 'junction' : 'dir');
  }

  const snapshotNodeModulesModeRaw = (
    env.HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE ?? ''
  ).toString().trim().toLowerCase();
  const snapshotNodeModulesMode =
    snapshotNodeModulesModeRaw === 'symlink' || snapshotNodeModulesModeRaw === 'copy'
      ? snapshotNodeModulesModeRaw
      : snapshotNodeModulesModeRaw
        ? 'copy'
        : 'auto';

  const snapshotNodeModulesDir = resolve(snapshotDir, 'node_modules');
  const ensureSymlinkNodeModules = (): void => {
    if (existsSync(snapshotNodeModulesDir)) {
      try {
        const stat = lstatSync(snapshotNodeModulesDir);
        if (snapshotNodeModulesMode !== 'symlink' || stat.isSymbolicLink()) {
          return;
        }
        rmSync(snapshotNodeModulesDir, { recursive: true, force: true });
      } catch {
        return;
      }
    }
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

  if (!snapshotNodeModulesIsSymlink && snapshotNodeModulesMode !== 'symlink') {
    ensureCliDistSnapshotNodeModules({
      snapshotDir,
      snapshotDistDir: resolve(snapshotDir, 'dist'),
      rootDir,
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

async function resolveCliSourceLaunchSpec(
  params: Readonly<{ testDir: string; env: NodeJS.ProcessEnv }>,
  rootDir: string,
  options: CliLaunchOptions,
): Promise<CliTestLaunchSpec> {
  if (!shouldSkipCliSharedDepsBuild(params.env)) {
    await ensureCliSharedDepsBuilt(params, {
      repoRoot: rootDir,
      runCommand: options.runCommand,
      skipSourceFreshnessCheck: options.skipSourceFreshnessCheck,
      timeoutMs: options.timeoutMs,
      pollIntervalMs: options.pollIntervalMs,
      staleAfterMs: options.staleAfterMs,
      buildTimeoutMs: options.buildTimeoutMs,
    });
  }
  const snapshotDir = options.snapshotDir;
  ensureCliSourceSnapshot(snapshotDir, rootDir, params.env);
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
  };
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

export function shouldSkipCliSharedDepsBuild(env: NodeJS.ProcessEnv): boolean {
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
