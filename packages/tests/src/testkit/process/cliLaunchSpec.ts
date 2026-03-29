import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { repoRootDir } from '../paths';
import { ensureCliDistSnapshotEntrypoint, ensureCliSharedDepsBuilt } from './cliDist';
import { ensureCliDistSnapshotNodeModules } from './cliDistSnapshotNodeModules';
import { resolveTsxImportHookPath } from './tsxImportHook';

export type CliTestLaunchSpec = Readonly<{
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}>;

type CliLaunchOptions = Parameters<typeof ensureCliDistSnapshotEntrypoint>[1] & {
  preferSourceEntrypoint?: boolean;
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

function ensureCliSourceSnapshot(snapshotDir: string, rootDir: string): void {
    mkdirSync(snapshotDir, { recursive: true });

  const linkTargets = ['src', 'scripts', 'tools', 'bin'];
  for (const relPath of linkTargets) {
    const target = resolve(rootDir, 'apps', 'cli', relPath);
    if (!existsSync(target)) continue;
    const dest = resolve(snapshotDir, relPath);
    if (existsSync(dest)) continue;
    symlinkSync(target, dest, process.platform === 'win32' ? 'junction' : 'dir');
  }

  ensureCliDistSnapshotNodeModules({
    snapshotDir,
    snapshotDistDir: resolve(snapshotDir, 'dist'),
    rootDir,
  });

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
  ensureCliSourceSnapshot(snapshotDir, rootDir);
  const sourceEntrypoint = resolveCliSnapshotSourceEntrypoint(snapshotDir);
  if (!existsSync(sourceEntrypoint)) {
    throw new Error(`CLI source entrypoint missing for test launch: ${sourceEntrypoint}`);
  }

  const tsxHookPath = resolveTsxImportHookPath();
  if (!tsxHookPath) {
    throw new Error('tsx import hook is required for CLI source entrypoint mode but could not be resolved');
  }

  return {
    command: process.execPath,
    args: ['--preserve-symlinks', '--preserve-symlinks-main', '--import', tsxHookPath, sourceEntrypoint],
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
