import { userInfo } from 'node:os';
import { mkdir, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { withExclusiveFileLock, writeAtomicTextFile } from '@happier-dev/plugin-sdk/fs';
import type { LoggerService } from '@happier-dev/plugin-sdk';
import { resolveCodexHome } from '../../mcp/configServers.js';
import { parseCodexCliStableVersion } from '../../cli/detect.js';

type StartupConfiguration = Readonly<{
  processEnv: Readonly<Record<string, string | undefined>>;
  versionOutput?: string;
  readVersion?: () => Promise<string>;
  configOverrides?: readonly string[];
  cwd?: string;
  /** Exec calls admission after preparation, immediately before native spawn. */
  deferUntilSpawn?: boolean;
}>;

async function mayExist(path: string): Promise<boolean> {
  try { await stat(path); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ENOENT'; }
}

async function resolveStartupRoot(configuration: StartupConfiguration, sqliteHome: string): Promise<string | null> {
  // Pin the explicit materializer projection instead of reimplementing native
  // config precedence. Native 0.162.1 managed requirements can override even -c.
  // Cloud requirements depend on disk/keyring auth; unresolved starts retain
  // the predecessor OS-user lock, without publishing a warm marker.
  if (process.platform !== 'linux') return null;
  const home = resolveCodexHome(configuration.processEnv);
  // Any uninspected config layer could select keyring auth, enabling a cloud
  // exact requirement even without auth.json. Do not guess its effective value.
  const configPaths = [join(home, 'config.toml'), '/etc/codex/config.toml'];
  if (configuration.configOverrides?.some(value => /^\s*(?:cli_auth_credentials_store|project_root_markers)\s*=/u.test(value))) return null;
  if ((await Promise.all([
    '/etc/codex/requirements.toml', '/etc/codex/managed_config.toml',
    join(home, 'auth.json'), join(home, 'cloud-config-bundle-cache.json'),
    ...configPaths,
  ].map(mayExist))).some(Boolean)) return null;

  // Native 0.162.1 chooses project markers from those earlier layers and CLI
  // overrides. With all absent, its default is the nearest .git marker, or cwd
  // when none exists. A .git directory only qualifies with a stat-able HEAD.
  const cwd = resolve(configuration.cwd ?? process.cwd());
  let projectRoot = cwd;
  for (let directory = cwd;;) {
    const marker = join(directory, '.git');
    const metadata = await stat(marker).catch(() => null);
    if (metadata && (!metadata.isDirectory() || await stat(join(marker, 'HEAD')).then(() => true, () => false))) {
      projectRoot = directory;
      break;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  const absoluteHome = resolve(home);
  const canonicalHome = await realpath(absoluteHome).catch(() => absoluteHome);
  for (let directory = cwd;; directory = dirname(directory)) {
    const configDirectory = join(directory, '.codex');
    // Native excludes CODEX_HOME itself (including symlink aliases) from the
    // project layers; its user config was checked separately above.
    if (configDirectory !== absoluteHome
      && await realpath(configDirectory).catch(() => configDirectory) !== canonicalHome
      && await mayExist(join(configDirectory, 'config.toml'))) return null;
    if (directory === projectRoot) break;
  }
  await mkdir(sqliteHome, { recursive: true });
  return await realpath(sqliteHome);
}

async function isWarm(root: string, markerPath: string, version: string): Promise<boolean> {
  if (await readFile(markerPath, 'utf8').catch(() => null) !== `${version}\n`) return false;
  const files = await readdir(root);
  for (const file of files) {
    if (!/^state_\d+\.sqlite$/u.test(file)) continue;
    const fileState = await stat(join(root, file)).catch(() => null);
    if (fileState?.isFile() && fileState.size > 0) return true;
  }
  return false;
}

/** Exclude first initialization/migration, leaving warm starts independent. */
export async function withCodexNativeStartupLock<TResult>(
  initialize: (configOverrides: readonly string[], admit: (signal?: AbortSignal) => Promise<void>) => Promise<TResult>,
  signal?: AbortSignal,
  logger?: Pick<LoggerService, 'debug'>,
  configuration?: StartupConfiguration,
  onWaiting?: (waiting: boolean) => void,
): Promise<TResult> {
  signal?.throwIfAborted();
  const projectedRoot = configuration?.processEnv.CODEX_SQLITE_HOME;
  const requestedRoot = projectedRoot && isAbsolute(projectedRoot)
    && !configuration?.configOverrides?.some(value => /^\s*sqlite_home\s*=/u.test(value))
    ? projectedRoot : null;
  const candidateRoot = configuration && requestedRoot ? await resolveStartupRoot(configuration, requestedRoot) : null;
  const versionOutput = candidateRoot && configuration
    ? configuration.versionOutput ?? await configuration.readVersion?.() ?? '' : '';
  const version = parseCodexCliStableVersion(versionOutput)?.value;
  const root = version ? candidateRoot : null;
  const launchRoot = root ?? requestedRoot;
  const overrides = [
    ...(configuration?.configOverrides ?? []),
    ...(launchRoot ? [`sqlite_home=${JSON.stringify(launchRoot)}`] : []),
  ];
  // Unresolved starts may open any of these roots. Share their predecessor
  // lock for first initialization/version changes; warm resolved starts skip it.
  const lockPath = join(userInfo().homedir, '.happier-codex-native-startup.lock');
  const markerPath = join(root ?? userInfo().homedir, '.happier-codex-native-startup.version');
  if (root && version && await isWarm(root, markerPath, version)) {
    signal?.throwIfAborted();
    return await initialize(overrides, async () => {});
  }
  let settle!: () => void;
  const settled = new Promise<void>(resolve => { settle = resolve; });
  let admitted!: () => void;
  let refuse!: (error: unknown) => void;
  const admission = new Promise<void>((resolve, reject) => { admitted = resolve; refuse = reject; });
  // Observe acquisition failure even if preparation fails before awaiting it.
  void admission.catch(() => undefined);
  let holding: Promise<void> | undefined;
  let completed = false;
  const admit = (spawnSignal?: AbortSignal) => {
    const acquisitionSignal = signal && spawnSignal ? AbortSignal.any([signal, spawnSignal]) : signal ?? spawnSignal;
    holding ??= withExclusiveFileLock({
      lockPath,
      timeoutMs: Number.POSITIVE_INFINITY,
      ...(acquisitionSignal ? { signal: acquisitionSignal } : {}),
      onWait: info => {
        onWaiting?.(true);
        logger?.debug('Codex native startup is waiting for another start', info);
      },
    }, async () => {
      onWaiting?.(false);
      admitted();
      await settled;
      if (completed && root && version) {
        // Publish readiness while still excluding another cold migrator.
        await writeAtomicTextFile({ path: markerPath, contents: `${version}\n`, mode: 0o600 })
          .catch(() => {
            try { logger?.debug('Codex native startup version could not be recorded'); }
            catch { /* Diagnostics must not fail a ready native client. */ }
          });
      }
    });
    void holding.catch(refuse);
    return admission;
  };
  try {
    if (!configuration?.deferUntilSpawn) await admit();
    const result = await initialize(overrides, admit);
    completed = true;
    return result;
  } finally {
    settle();
    try {
      // Acquisition failure already flowed through Exec's typed startup result.
      // Joining its task must not replace that result with a raw lock error.
      await holding?.catch(error => { if (completed) throw error; });
    }
    finally { onWaiting?.(false); }
  }
}
