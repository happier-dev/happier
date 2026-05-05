import type { ExecFileSyncOptions } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { compareVersions } from '@happier-dev/cli-common/update';
import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';
import { resolvePublicReleaseRingLabelForId } from '@happier-dev/release-runtime/releaseRings';
import { ensureJavaScriptRuntimeExecutable } from '@/packagedRuntime/js/ensureJavaScriptRuntimeExecutable';
import { isBun } from '../../../utils/runtime';

function packageJsonPathForNodeModules(params: Readonly<{ rootDir: string; packageName: string }>): string | null {
  const name = String(params.packageName ?? '').trim();
  if (!name) return null;
  const parts = name.split('/').filter(Boolean);
  return join(params.rootDir, 'node_modules', ...parts, 'package.json');
}

function resolveScopedRuntimeDir(params: Readonly<{ homeDir: string; publicReleaseRing: PublicReleaseRingId }>): string {
  const suffix = resolvePublicReleaseRingLabelForId(params.publicReleaseRing);
  return suffix === 'stable' ? join(params.homeDir, 'runtime') : join(params.homeDir, `runtime.${suffix}`);
}

function shouldSkipRuntimeReexecForDaemonAttach(argv: readonly string[]): boolean {
  const startedByIndex = argv.indexOf('--started-by');
  if (startedByIndex < 0) return false;

  const startedByValue = String(argv[startedByIndex + 1] ?? '').trim();
  if (startedByValue !== 'daemon') return false;

  const existingSessionIndex = argv.indexOf('--existing-session');
  if (existingSessionIndex < 0) return false;

  const existingSessionValue = String(argv[existingSessionIndex + 1] ?? '').trim();
  return existingSessionValue.length > 0;
}

function shouldSkipRuntimeReexecForDaemonServiceInstall(argv: readonly string[]): boolean {
  const positionals = argv.filter((arg) => arg && !arg.startsWith('-'));
  return positionals[0] === 'service' && positionals[1] === 'install';
}

export function resolveRuntimeEntrypointPath(params: Readonly<{ homeDir: string; packageName: string; publicReleaseRing?: PublicReleaseRingId }>): string {
  const packageName = String(params.packageName ?? '').trim();
  if (!packageName) {
    throw new Error('packageName is required');
  }
  const parts = packageName.split('/').filter(Boolean);
  const publicReleaseRing = params.publicReleaseRing ?? 'stable';
  return join(resolveScopedRuntimeDir({ homeDir: params.homeDir, publicReleaseRing }), 'node_modules', ...parts, 'dist', 'index.mjs');
}

export async function maybeReexecToRuntime(params: Readonly<{
  cliRootDir: string;
  homeDir: string;
  packageName: string;
  publicReleaseRing?: PublicReleaseRingId;
  argv: string[];
  env: NodeJS.ProcessEnv;
  exec?: typeof execFileSync;
  exit?: typeof process.exit;
  isBunRuntime?: boolean;
  exists?: (path: string) => boolean;
  readVersion?: (packageJsonPath: string) => string | null;
  ensureRuntimeExecutable?: typeof ensureJavaScriptRuntimeExecutable;
}>): Promise<void> {
  const env = params.env;
  const publicReleaseRing = params.publicReleaseRing ?? 'stable';
  if (String(env.HAPPIER_CLI_RUNTIME_DISABLE ?? '').trim() === '1') return;
  if (String(env.HAPPIER_CLI_RUNTIME_REEXEC ?? '').trim() === '1') return;
  if (shouldSkipRuntimeReexecForDaemonAttach(params.argv)) return;
  if (publicReleaseRing === 'stable' && shouldSkipRuntimeReexecForDaemonServiceInstall(params.argv)) return;

  const runtimeDir = resolveScopedRuntimeDir({ homeDir: params.homeDir, publicReleaseRing });
  const runtimeEntrypoint = resolveRuntimeEntrypointPath({
    homeDir: params.homeDir,
    packageName: params.packageName,
    publicReleaseRing,
  });
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
  const runtimePkgJson = packageJsonPathForNodeModules({ rootDir: runtimeDir, packageName: params.packageName });
  const localPkgJson = join(params.cliRootDir, 'package.json');
  const runtimeVersion = runtimePkgJson ? readVersion(runtimePkgJson) : null;
  const localVersion = readVersion(localPkgJson);
  if (!runtimeVersion || !localVersion) return;
  if (compareVersions(runtimeVersion, localVersion) <= 0) return;

  const execImpl = params.exec ?? execFileSync;
  const ensureRuntimeExecutable = params.ensureRuntimeExecutable ?? ensureJavaScriptRuntimeExecutable;
  const runtimeExecutable = await ensureRuntimeExecutable({ isBunRuntime: params.isBunRuntime ?? isBun() });
  if (!runtimeExecutable) return;
  const childEnv: NodeJS.ProcessEnv = { ...env, HAPPIER_CLI_RUNTIME_REEXEC: '1' };
  if (!String(childEnv.HAPPIER_PUBLIC_RELEASE_CHANNEL ?? '').trim()) {
    childEnv.HAPPIER_PUBLIC_RELEASE_CHANNEL = resolvePublicReleaseRingLabelForId(publicReleaseRing);
  }
  const opts: ExecFileSyncOptions = { stdio: 'inherit', env: childEnv };
  const exitImpl = params.exit ?? process.exit;
  let exitCode = 0;
  try {
    execImpl(runtimeExecutable, [runtimeEntrypoint, ...params.argv], opts);
  } catch (err: unknown) {
    const e = err as { status?: unknown; exitCode?: unknown };
    const status = typeof e?.status === 'number' ? e.status : typeof e?.exitCode === 'number' ? e.exitCode : null;
    exitCode = status ?? 1;
  }

  exitImpl(exitCode);
}
