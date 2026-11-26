import { userInfo } from 'node:os';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { withExclusiveFileLock, writeAtomicTextFile } from '@happier-dev/plugin-sdk/fs';
import type { LoggerService } from '@happier-dev/plugin-sdk';
import { parseCodexCliStableVersion } from '../../cli/detect.js';
import { resolveCodexRuntimeStore, type CodexRuntimeStore } from '../../auth/services/state/sharing/files.js';

type StartupConfiguration = Readonly<{
  processEnv: Readonly<Record<string, string | undefined>>;
  versionOutput?: string;
  readVersion?: () => Promise<string>;
  configOverrides?: readonly string[];
  cwd?: string;
  separateNativeIdentity?: boolean;
  runtimeStore?: CodexRuntimeStore;
  /** Exec calls admission after preparation, immediately before native spawn. */
  deferUntilSpawn?: boolean;
}>;

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
  initialize: (configOverrides: readonly string[], admit: (signal?: AbortSignal) => Promise<void>, store: CodexRuntimeStore | null) => Promise<TResult>,
  signal?: AbortSignal,
  logger?: Pick<LoggerService, 'debug'>,
  configuration?: StartupConfiguration,
  onWaiting?: (waiting: boolean) => void,
): Promise<TResult> {
  signal?.throwIfAborted();
  // The native launch shim owns the separated user's environment and store.
  const store = configuration && !configuration.separateNativeIdentity
    ? configuration.runtimeStore ?? await resolveCodexRuntimeStore({ env: configuration.processEnv,
        cwd: configuration.cwd ?? process.cwd(), configOverrides: configuration.configOverrides }).catch(() => null)
    : null;
  const candidateRoot = process.platform === 'linux' && store?.sqliteHome
    ? await realpath(store.sqliteHome).catch(() => store.sqliteHome) : null;
  const versionOutput = candidateRoot && configuration
    ? configuration.versionOutput ?? await configuration.readVersion?.() ?? '' : '';
  const version = parseCodexCliStableVersion(versionOutput)?.value;
  const root = version ? candidateRoot : null;
  const overrides = [
    ...(configuration?.configOverrides ?? []),
    ...(store?.sqliteHomeOverride ? [store.sqliteHomeOverride] : []),
  ];
  // Unresolved starts may open any of these roots. Share their predecessor
  // lock for first initialization/version changes; warm resolved starts skip it.
  const lockPath = join(userInfo().homedir, '.happier-codex-native-startup.lock');
  const markerPath = join(root ?? userInfo().homedir, '.happier-codex-native-startup.version');
  if (root && version && await isWarm(root, markerPath, version)) {
    signal?.throwIfAborted();
    return await initialize(overrides, async () => {}, store);
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
    const result = await initialize(overrides, admit, store);
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
