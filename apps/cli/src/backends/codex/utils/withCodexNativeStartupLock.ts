import { userInfo } from 'node:os';
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { logger } from '@/ui/logger';
import { withJsonOwnerFileLock } from '@/utils/fs/jsonOwnerFileLock';
import { writeGeneratedTextAtomicallyIfChanged } from '@/utils/fs/writeGeneratedTextAtomicallyIfChanged';
import { resolveConfiguredCodexHome } from './resolveConfiguredCodexHome';
import { parseCodexVersionInfo } from '../mcp/version';

type StartupConfiguration = Readonly<{
  processEnv: NodeJS.ProcessEnv;
  cwd?: string;
  configOverrides?: readonly string[];
  versionOutput: string;
}>;

/** Probe the same resolved executable (including its JS entrypoint) used for launch. */
export async function readCodexNativeStartupVersion(
  invocation: Readonly<{ command: string; args: readonly string[] }>,
  processEnv: NodeJS.ProcessEnv,
  cwd?: string,
  signal?: AbortSignal,
): Promise<string> {
  if (!processEnv.CODEX_SQLITE_HOME || process.platform !== 'linux') return '';
  const appServerIndex = invocation.args.indexOf('app-server');
  if (appServerIndex < 0) return '';
  return await new Promise<string>((resolveVersion) => {
    const child = execFile(invocation.command, [...invocation.args.slice(0, appServerIndex), '--version'], {
      env: processEnv, cwd, signal, encoding: 'utf8', windowsHide: true,
    }, (error, stdout) => { resolveVersion(error ? '' : stdout); });
    child.stdin?.end();
  });
}

async function mayExist(path: string): Promise<boolean> {
  try { await stat(path); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ENOENT'; }
}

async function resolveStartupRoot(configuration: StartupConfiguration, sqliteHome: string): Promise<string | null> {
  if (process.platform !== 'linux') return null;
  const home = resolveConfiguredCodexHome(configuration.processEnv);
  // Native 0.162.1 managed requirements override even -c. Uninspected config
  // can select keyring auth and enable cloud requirements without auth.json.
  // Preserve the global fallback instead of duplicating native layered config.
  const paths = [
    '/etc/codex/requirements.toml', '/etc/codex/managed_config.toml', '/etc/codex/config.toml',
    join(home, 'auth.json'), join(home, 'cloud-config-bundle-cache.json'), join(home, 'config.toml'),
  ];
  for (let cwd = resolve(configuration.cwd ?? process.cwd());;) {
    paths.push(join(cwd, '.codex', 'config.toml'));
    const parent = dirname(cwd);
    if (parent === cwd) break;
    cwd = parent;
  }
  if (configuration.configOverrides?.some(value => /^\s*cli_auth_credentials_store\s*=/u.test(value))) return null;
  if ((await Promise.all(paths.map(mayExist))).some(Boolean)) return null;
  await mkdir(sqliteHome, { recursive: true });
  return await realpath(sqliteHome);
}

async function isWarm(root: string, markerPath: string, version: string): Promise<boolean> {
  if (await readFile(markerPath, 'utf8').catch(() => null) !== `${version}\n`) return false;
  for (const name of await readdir(root)) {
    if (!/^state_\d+\.sqlite$/u.test(name)) continue;
    const file = await stat(join(root, name)).catch(() => null);
    if (file?.isFile() && file.size > 0) return true;
  }
  return false;
}

/** Exclude first native initialization/migration while leaving warm starts independent. */
export async function withCodexNativeStartupLock<TResult>(
  timeoutMs: number,
  initialize: (configOverrides: readonly string[]) => Promise<TResult>,
  signal?: AbortSignal,
  configuration?: StartupConfiguration,
): Promise<TResult> {
  signal?.throwIfAborted();
  const parsed = configuration ? parseCodexVersionInfo(configuration.versionOutput) : null;
  const version = parsed?.parsed && !parsed.prereleaseTag && /^codex(?:-cli)?\s+v?\d+\.\d+\.\d+\s*$/iu.test(configuration?.versionOutput.trim() ?? '')
    ? `${parsed.major}.${parsed.minor}.${parsed.patch}` : null;
  const sqliteHome = configuration?.processEnv.CODEX_SQLITE_HOME;
  const callerSelectedSqliteHome = configuration?.configOverrides?.some(value => /^\s*sqlite_home\s*=/u.test(value));
  const requestedRoot = sqliteHome && isAbsolute(sqliteHome) && !callerSelectedSqliteHome ? sqliteHome : null;
  const root = configuration && version && requestedRoot ? await resolveStartupRoot(configuration, requestedRoot) : null;
  // Auth/config uncertainty retains global exclusion, but the materializer's
  // projection must still beat copied relative sqlite_home configuration.
  // Managed native requirements can override this pin, so it is not root proof.
  const launchRoot = root ?? requestedRoot;
  const overrides = [...(configuration?.configOverrides ?? []), ...(launchRoot ? [`sqlite_home=${JSON.stringify(launchRoot)}`] : [])];
  // Unresolved native config can select any SQLite root; cold/migrating starts
  // therefore share the OS-user lock. Resolved warm starts still skip admission.
  const lockPath = join(userInfo().homedir, '.happier-codex-native-startup.lock');
  const markerPath = join(root ?? userInfo().homedir, '.happier-codex-native-startup.version');
  if (root && version && await isWarm(root, markerPath, version)) {
    signal?.throwIfAborted();
    return await initialize(overrides);
  }
  return await withJsonOwnerFileLock({
    lockPath,
    // Native initialization retains its owning RPC budget; queued startup must
    // not impose a shorter competing timeout on another valid startup.
    timeoutMs: Number.POSITIVE_INFINITY,
    staleAfterMs: timeoutMs,
    errorCode: 'codex_native_startup_lock_timeout',
    signal,
    onWait: (info) => logger.infoFile('[CodexNativeStartupLock] Waiting for native startup lock', info),
  }, async () => {
    const result = await initialize(overrides);
    if (root && version) {
      await writeGeneratedTextAtomicallyIfChanged({ path: markerPath, contents: `${version}\n`, mode: 0o600 })
        .catch(() => { logger.infoFile('[CodexNativeStartupLock] Could not record successful native startup version'); });
    }
    return result;
  });
}
