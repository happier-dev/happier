import type { ExecFileSyncOptions } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { compareVersions } from '@happier-dev/cli-common/update';

function packageJsonPathForNodeModules(params: Readonly<{ rootDir: string; packageName: string }>): string | null {
  const name = String(params.packageName ?? '').trim();
  if (!name) return null;
  const parts = name.split('/').filter(Boolean);
  return join(params.rootDir, 'node_modules', ...parts, 'package.json');
}

export function resolveRuntimeEntrypointPath(params: Readonly<{ homeDir: string; packageName: string }>): string {
  const packageName = String(params.packageName ?? '').trim();
  if (!packageName) {
    throw new Error('packageName is required');
  }
  const parts = packageName.split('/').filter(Boolean);
  return join(params.homeDir, 'runtime', 'node_modules', ...parts, 'dist', 'index.mjs');
}

export function maybeReexecToRuntime(params: Readonly<{
  cliRootDir: string;
  homeDir: string;
  packageName: string;
  argv: string[];
  env: NodeJS.ProcessEnv;
  exec?: typeof execFileSync;
  exists?: (path: string) => boolean;
  readVersion?: (packageJsonPath: string) => string | null;
}>): void {
  const env = params.env;
  if (String(env.HAPPIER_CLI_RUNTIME_DISABLE ?? '').trim() === '1') return;
  if (String(env.HAPPIER_CLI_RUNTIME_REEXEC ?? '').trim() === '1') return;

  const runtimeEntrypoint = resolveRuntimeEntrypointPath({ homeDir: params.homeDir, packageName: params.packageName });
  const existsImpl = params.exists ?? existsSync;
  if (!existsImpl(runtimeEntrypoint)) return;

  const readVersion = params.readVersion ?? ((packageJsonPath: string) => {
    try {
      const raw = readFileSync(packageJsonPath, 'utf-8');
      const parsed = JSON.parse(raw);
      const v = String(parsed?.version ?? '').trim();
      return v || null;
    } catch {
      return null;
    }
  });
  const runtimePkgJson = packageJsonPathForNodeModules({ rootDir: join(params.homeDir, 'runtime'), packageName: params.packageName });
  const localPkgJson = join(params.cliRootDir, 'package.json');
  const runtimeVersion = runtimePkgJson ? readVersion(runtimePkgJson) : null;
  const localVersion = readVersion(localPkgJson);
  if (!runtimeVersion || !localVersion) return;
  if (compareVersions(runtimeVersion, localVersion) <= 0) return;

  const execImpl = params.exec ?? execFileSync;
  const childEnv = { ...env, HAPPIER_CLI_RUNTIME_REEXEC: '1' };
  const opts: ExecFileSyncOptions = { stdio: 'inherit', env: childEnv };
  let exitCode = 0;
  try {
    execImpl(process.execPath, [runtimeEntrypoint, ...params.argv], opts);
  } catch (err: unknown) {
    const e = err as { status?: unknown; exitCode?: unknown };
    const status = typeof e?.status === 'number' ? e.status : typeof e?.exitCode === 'number' ? e.exitCode : null;
    exitCode = status ?? 1;
  }

  process.exit(exitCode);
}
