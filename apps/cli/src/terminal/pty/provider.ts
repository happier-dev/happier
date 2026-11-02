import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { isEmbeddedBunBundlePath } from '@/packagedRuntime/js/isEmbeddedBunBundlePath';
import { resolveLaunchedRuntimeEntrypointsFromArgv, resolveRuntimeRootsFromLaunchedProcess } from '@/packagedRuntime/resolveRuntimeEntrypointArgv';
import { logger } from '@/ui/logger';
import { isBun } from '@/utils/runtime';
import type { ProcessCustodySpawnSpec, resolveProcessCustodyRuntimeExecutable } from '@/subprocess/supervision/processCustody';
import { createNodePtyRelayProvider } from './nodeRelay';
import { createUtf8StreamDecoder } from './decode';
import { createPythonPtyRelayProvider } from './pythonRelay';
import { withWindowsFiniteCustody, withWindowsInteractiveCustody } from './windowsCustody';
import { SpawnFailureError, type SpawnFailureLimitsReader } from '@/processes/spawnFailure/classifySpawnFailure';
import { buildCgroupProcessLaunchSpec, prepareCgroupProcessLaunchScope, type LinuxProcessLaunchScope } from '@/daemon/platform/linux/buildCgroupSelfMigratingHappyCliLaunchSpec';
import { createHappierLinuxScopeName } from '@/daemon/platform/linux/systemdUserResourceGovernor';

export type Disposable = Readonly<{ dispose: () => void }>;

export type PtyExitEvent = Readonly<{
  exitCode: number;
  signal?: number;
}>;

export type PtyForkOptions = Readonly<{
  name?: string;
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: { [key: string]: string | undefined };
  encoding?: string | null;
  handleFlowControl?: boolean;
  flowControlPause?: string;
  flowControlResume?: string;
}>;

export type PtyProcess = Readonly<{
  /**
   * The spawned process id. Used as a daemon-internal correlation input for
   * terminal->port registration. Backends that cannot supply a usable pid surface
   * `0`, and the owner skips registration rather than registering a bogus pid.
   */
  pid: number;
  /** Positive POSIX group custody from forkpty/setsid, never a relay PID guess.
   * Null or missing evidence cannot prove finite tree settlement. */
  ownedProcessGroupId?: number | null;
  /** Private, exact native Job custody; establishment is never inferred from a carrier PID. */
  windowsJobCustody?: ProcessCustodySpawnSpec & Readonly<{ established: Promise<Readonly<{ pid: number }> | null> }>;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: (signal?: string) => void;
  onData: (listener: (data: string) => void) => Disposable;
  onDataBytes?: (listener: (data: Buffer | string) => void) => Disposable;
  onExit: (listener: (e: PtyExitEvent) => void) => Disposable;
}>;

export type PtySpawnParams = Readonly<{
  file: string;
  args: string[] | string;
  options: PtyForkOptions;
  /** Finite launch classification from the incumbent process owner, not a public terminal input. */
  finiteProcess?: true;
}>;

export type PtyProvider = Readonly<{
  spawn: (params: PtySpawnParams) => PtyProcess;
  /** Prepares the native containment context before the synchronous spawn boundary. */
  prepare?: () => Promise<void>;
}>;

type NativePtyProcess = Omit<PtyProcess, 'onData' | 'onDataBytes'> & Readonly<{
  onData: (listener: (data: string | Buffer) => void) => Disposable;
  onDataBytes?: (listener: (data: string | Buffer) => void) => Disposable;
}>;

type ErrorEmitterPtyProcess = NativePtyProcess & {
  on: (event: 'error', listener: (error: unknown) => void) => unknown;
  listeners: (event: 'error') => unknown[];
};

type WindowsPtySocket = {
  on: (event: 'error', listener: (error: unknown) => void) => unknown;
  listeners: (event: 'error') => unknown[];
  destroyed?: boolean;
  closed?: boolean;
  writableEnded?: boolean;
  writableDestroyed?: boolean;
  readyState?: string;
};

type WindowsNativePtyProcess = ErrorEmitterPtyProcess & {
  _agent?: {
    inSocket?: unknown;
    outSocket?: unknown;
    exitCode?: unknown;
  };
  _close?: () => void;
  emit?: (event: 'exit', exitCode: number, signal?: number) => boolean;
};

function normalizeByteHookChunk(chunk: string | Buffer): string | Buffer {
  return typeof chunk === 'string' ? chunk : Buffer.from(chunk);
}

function parseImportMetaPath(importMetaUrl: string | null | undefined): string | null {
  const trimmed = String(importMetaUrl ?? '').trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed).pathname;
  } catch {
    return trimmed;
  }
}

export function resolvePtyProviderRequireBase(params?: Readonly<{
  importMetaUrl?: string | null;
  currentExecPath?: string | null;
  argv?: readonly string[] | null;
}>): string {
  const importMetaUrl = String(params?.importMetaUrl ?? import.meta.url ?? '').trim();
  const currentExecPath = String(params?.currentExecPath ?? process.execPath ?? '').trim();
  const importMetaPath = parseImportMetaPath(importMetaUrl);
  if (importMetaPath && isEmbeddedBunBundlePath(importMetaPath)) {
    const runtimeEntrypoint = resolveLaunchedRuntimeEntrypointsFromArgv(params?.argv ?? process.argv)[0];
    if (runtimeEntrypoint) {
      return runtimeEntrypoint;
    }
    if (currentExecPath) {
      return currentExecPath;
    }
  }
  if (!importMetaUrl && currentExecPath) {
    return currentExecPath;
  }
  return importMetaUrl || currentExecPath;
}

export function resolvePtyProviderModuleIds(
  moduleId: string,
  params?: Readonly<{
    argv?: readonly string[] | null;
    currentExecPath?: string | null;
  }>,
): string[] {
  const ids = [moduleId];
  for (const root of resolveRuntimeRootsFromLaunchedProcess({
    argv: params?.argv,
    currentExecPath: params?.currentExecPath,
  })) {
    const packageDir = join(root, 'node_modules', moduleId);
    ids.push(packageDir);
    const packageMain = resolvePackageMainEntrypoint(packageDir);
    if (packageMain) {
      ids.push(packageMain);
    }
    ids.push(join(packageDir, 'lib', 'index.js'));
  }
  return [...new Set(ids)];
}

function resolvePackageMainEntrypoint(packageDir: string): string | null {
  try {
    const packageJson = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
      main?: unknown;
    };
    const main = typeof packageJson.main === 'string' && packageJson.main.trim()
      ? packageJson.main.trim()
      : 'index.js';
    return join(packageDir, main);
  } catch {
    return null;
  }
}

function isErrorEmitterPtyProcess(pty: NativePtyProcess): pty is ErrorEmitterPtyProcess {
  const candidate = pty as Partial<ErrorEmitterPtyProcess>;
  return typeof candidate.on === 'function' && typeof candidate.listeners === 'function';
}

function isWindowsPtySocket(value: unknown): value is WindowsPtySocket {
  const candidate = value as Partial<WindowsPtySocket>;
  return typeof candidate?.on === 'function' && typeof candidate.listeners === 'function';
}

function resolveWindowsNativeInputSocket(pty: NativePtyProcess): WindowsPtySocket | null {
  const candidate = pty as Partial<WindowsNativePtyProcess>;
  return isWindowsPtySocket(candidate._agent?.inSocket) ? candidate._agent.inSocket : null;
}

function isWindowsPtyInputSocketClosed(socket: WindowsPtySocket): boolean {
  if (socket.destroyed === true) return true;
  if (socket.closed === true) return true;
  if (socket.writableEnded === true) return true;
  if (socket.writableDestroyed === true) return true;
  const readyState = typeof socket.readyState === 'string'
    ? socket.readyState.toLowerCase()
    : '';
  return readyState === 'closed' || readyState === 'closing';
}

function isBenignWindowsPtyClosedSocketError(
  error: unknown,
  socket?: WindowsPtySocket | null,
): boolean {
  if (socket && isWindowsPtyInputSocketClosed(socket)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return message === 'Socket is closed' || message === 'terminal_pty_input_socket_closed';
}

function installWindowsNativePtyErrorGuard(
  pty: NativePtyProcess,
  params: Readonly<{
    platform: NodeJS.Platform;
    backendName: string;
  }>,
): NativePtyProcess {
  if (params.platform !== 'win32' || !isErrorEmitterPtyProcess(pty)) return pty;

  const nativePty = pty as WindowsNativePtyProcess;
  let closedBySocketFailure = false;
  let logged = false;
  const logSuppressedError = (error: unknown, source: 'pty' | 'input_socket' | 'output_socket') => {
    if (logged) return;
    logger.debug('[terminal-pty] native Windows PTY socket error suppressed', {
      backend: params.backendName,
      source,
      error: error instanceof Error ? error.message : String(error),
    });
    logged = true;
  };
  const closeAfterSocketFailure = (error: unknown, source: 'input_socket' | 'output_socket') => {
    logSuppressedError(error, source);
    if (closedBySocketFailure) return;
    closedBySocketFailure = true;
    const exitCode = typeof nativePty._agent?.exitCode === 'number'
      ? nativePty._agent.exitCode
      : 1;
    try {
      nativePty.emit?.('exit', exitCode);
    } catch {
      // best-effort synthetic liveness signal
    }
    try {
      nativePty._close?.();
    } catch {
      // best-effort terminal cleanup
    }
  };

  if (pty.listeners('error').length < 1) {
    pty.on('error', (error) => {
      if (isBenignWindowsPtyClosedSocketError(error)) {
        logSuppressedError(error, 'pty');
        return;
      }
      throw error;
    });
  }

  const inSocket = isWindowsPtySocket(nativePty._agent?.inSocket)
    ? nativePty._agent.inSocket
    : null;
  const outSocket = isWindowsPtySocket(nativePty._agent?.outSocket)
    ? nativePty._agent.outSocket
    : null;
  inSocket?.on('error', (error) => {
    if (isBenignWindowsPtyClosedSocketError(error, inSocket)) {
      closeAfterSocketFailure(error, 'input_socket');
      return;
    }
    throw error;
  });
  outSocket?.on('error', (error) => {
    if (isBenignWindowsPtyClosedSocketError(error, outSocket)) {
      closeAfterSocketFailure(error, 'output_socket');
      return;
    }
    throw error;
  });

  const originalWrite = pty.write.bind(pty);
  (pty as { write: NativePtyProcess['write'] }).write = (data) => {
    const currentInSocket = resolveWindowsNativeInputSocket(pty);
    if (currentInSocket && isWindowsPtyInputSocketClosed(currentInSocket)) {
      const error = new Error('terminal_pty_input_socket_closed');
      closeAfterSocketFailure(error, 'input_socket');
      throw error;
    }
    try {
      originalWrite(data);
    } catch (error) {
      if (isBenignWindowsPtyClosedSocketError(error, currentInSocket)) {
        closeAfterSocketFailure(error, 'input_socket');
      }
      throw error;
    }
  };
  return pty;
}

function wrapPtyProcess(process: NativePtyProcess, platform: NodeJS.Platform): PtyProcess {
  const write = process.write.bind(process);
  const resize = process.resize.bind(process);
  const kill = process.kill.bind(process);
  const onExit = process.onExit.bind(process);
  const onData = process.onData.bind(process);
  const onDataBytes = process.onDataBytes?.bind(process);

  return {
    pid: typeof process.pid === 'number' && Number.isInteger(process.pid) && process.pid > 0 ? process.pid : 0,
    // Native POSIX backends use forkpty or POSIX_SPAWN_SETSID. Windows finite
    // launches obtain their distinct Job witness at the shared launch adapter.
    ownedProcessGroupId: platform !== 'win32' && Number.isInteger(process.pid)
      && process.pid > 1 && process.pid <= 2_147_483_647 ? process.pid : null,
    write,
    resize,
    kill,
    onExit,
    onData: (listener) => {
      const decoder = createUtf8StreamDecoder();
      return onData((chunk) => {
        const decoded = decoder.decode(chunk);
        if (decoded) {
          listener(decoded);
        }
      });
    },
    onDataBytes: (listener) => {
      if (onDataBytes) {
        return onDataBytes((chunk) => listener(normalizeByteHookChunk(chunk)));
      }
      return onData((chunk) => {
        listener(normalizeByteHookChunk(chunk));
      });
    },
  };
}

export function createNodePtyProvider(params?: Readonly<{
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  fallbackProvider?: PtyProvider | null;
  fallbackBackendName?: string | null;
  argv?: readonly string[];
  currentExecPath?: string;
  resolveProcessCustodyRuntimeExecutable?: typeof resolveProcessCustodyRuntimeExecutable;
  readSpawnFailureLimits?: SpawnFailureLimitsReader;
}>): PtyProvider {
  const platform = params?.platform ?? process.platform;
  const readSpawnFailureLimits = params?.readSpawnFailureLimits;
  const currentExecPath = params?.currentExecPath ?? process.execPath;
  const argv = params?.argv;
  const requireBase = resolvePtyProviderRequireBase({
    argv,
    currentExecPath,
  });
  const require = createRequire(requireBase);
  const hasFallbackProviderOverride = Object.prototype.hasOwnProperty.call(params ?? {}, 'fallbackProvider');
  const defaultNodeRelayProvider = hasFallbackProviderOverride
    ? null
    : createNodePtyRelayProvider({
      env: params?.env ?? process.env,
      platform,
      currentExecPath,
    });
  const defaultFallbackProvider = defaultNodeRelayProvider
    ?? (hasFallbackProviderOverride
      ? null
      : createPythonPtyRelayProvider({
        env: params?.env ?? process.env,
        platform,
      }));
  const fallbackProvider = hasFallbackProviderOverride
    ? (params?.fallbackProvider ?? null)
    : defaultFallbackProvider;
  const fallbackBackendName =
    params?.fallbackBackendName
    ?? (fallbackProvider ? (defaultNodeRelayProvider ? 'node-relay' : 'python-relay') : null);
  // Both POSIX backends use tty.ReadStream for the nonblocking PTY master.
  // Bun can return a successful spawn while silently losing input/output
  // (oven-sh/bun#25822). Use the existing external relay until the bundled
  // Bun runtime passes interactive PTY input/output and cleanup validation.
  const useNativePty = platform === 'win32' || !isBun();

  let loggedNativeMissingFallback = false;
  let loggedNativeFailureFallback = false;
  let loggedSecondaryNativeFallback = false;
  let linuxScope: LinuxProcessLaunchScope | null = null;
  let preparation: Promise<void> | null = null;
  const prepare = (): Promise<void> => preparation ??= platform === 'linux'
    ? prepareCgroupProcessLaunchScope({ environment: params?.env ?? process.env }).then(scope => { linuxScope = scope; })
    : Promise.resolve();

  const provider = withWindowsFiniteCustody({
    spawn: (spawnParams) => {
      const unit = createHappierLinuxScopeName(spawnParams.options.env?.HAPPIER_PROCESS_OWNER);
      const scoped = linuxScope && unit && Array.isArray(spawnParams.args)
        ? buildCgroupProcessLaunchSpec({ scope: linuxScope, unit, launchSpec: {
          filePath: spawnParams.file, args: spawnParams.args,
          env: Object.fromEntries(Object.entries(spawnParams.options.env ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
        } }) : null;
      const params = scoped ? { ...spawnParams, file: scoped.filePath, args: scoped.args,
        options: { ...spawnParams.options, env: scoped.env } } : spawnParams;
      const nativeLoadErrors: Array<{ id: string; message: string }> = [];
      const tryResolveModule = (moduleId: string): { id: string; module: typeof import('node-pty') } | null => {
        for (const candidateId of resolvePtyProviderModuleIds(moduleId, {
          argv,
          currentExecPath,
        })) {
          try {
            return { id: moduleId, module: require(candidateId) as typeof import('node-pty') };
          } catch (error) {
            nativeLoadErrors.push({
              id: candidateId,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
        return null;
      };
      const preferred = useNativePty
        ? tryResolveModule('node-pty') ?? tryResolveModule('@homebridge/node-pty-prebuilt-multiarch')
        : null;
      logger.debug('[terminal-pty] backend resolution', {
        platform,
        requireBase,
        preferredBackend: preferred?.id ?? null,
        fallbackBackend: fallbackProvider ? fallbackBackendName : null,
        nativeLoadErrors,
      });
      let lastError: unknown = null;
      if (!preferred) {
        if (fallbackProvider) {
          if (!loggedNativeMissingFallback) {
            logger.debug('[terminal-pty] falling back to external PTY backend because native providers are unavailable', {
              fallbackBackend: fallbackBackendName,
            });
            loggedNativeMissingFallback = true;
          }
          try { return fallbackProvider.spawn(params); }
          catch (error) { throw new SpawnFailureError(error, { platform, syscall: 'spawn', limits: readSpawnFailureLimits?.() }); }
        }
        throw new Error('terminal_pty_provider_missing');
      }
      try {
        return wrapPtyProcess(installWindowsNativePtyErrorGuard(
          preferred.module.spawn(params.file, params.args, params.options) as unknown as NativePtyProcess,
          { platform, backendName: preferred.id },
        ), platform);
      } catch (e) {
        lastError = new SpawnFailureError(e, { platform, ...(platform !== 'win32' ? { syscall: platform === 'darwin' ? 'posix_spawn' as const : 'forkpty' as const } : {}), limits: readSpawnFailureLimits?.() });
        const fallback = preferred.id === 'node-pty'
          ? tryResolveModule('@homebridge/node-pty-prebuilt-multiarch') : null;
        if (preferred.id === 'node-pty') {
          logger.debug('[terminal-pty] backend resolution', {
            platform,
            requireBase,
            preferredBackend: preferred.id,
            secondaryBackend: fallback?.id ?? null,
            fallbackBackend: fallbackProvider ? fallbackBackendName : null,
            nativeLoadErrors,
          });
        }
        if (fallback) {
          if (!loggedSecondaryNativeFallback) {
            logger.debug('[terminal-pty] preferred PTY backend failed, trying secondary native backend', {
              failedBackend: preferred.id,
              secondaryBackend: fallback.id,
              error: e instanceof Error ? e.message : String(e),
            });
            loggedSecondaryNativeFallback = true;
          }
          try {
            return wrapPtyProcess(installWindowsNativePtyErrorGuard(
              fallback.module.spawn(params.file, params.args, params.options) as unknown as NativePtyProcess,
              { platform, backendName: fallback.id },
            ), platform);
          } catch (fallbackError) {
            lastError = new SpawnFailureError(fallbackError, { platform, ...(platform !== 'win32' ? { syscall: platform === 'darwin' ? 'posix_spawn' as const : 'forkpty' as const } : {}), limits: readSpawnFailureLimits?.() });
          }
        }
        if (fallbackProvider) {
          if (!loggedNativeFailureFallback) {
            logger.debug('[terminal-pty] native PTY backend failed, falling back to external backend', {
              failedBackend: preferred.id,
              fallbackBackend: fallbackBackendName,
              error: lastError instanceof Error ? lastError.message : String(lastError),
            });
            loggedNativeFailureFallback = true;
          }
          try { return fallbackProvider.spawn(params); }
          catch (error) { throw new SpawnFailureError(error, { platform, syscall: 'spawn', limits: readSpawnFailureLimits?.() }); }
        }
        throw lastError;
      }
    },
  }, { platform, resolveProcessCustodyRuntimeExecutable: params?.resolveProcessCustodyRuntimeExecutable });
  const resolveWindowsCustody = params?.resolveProcessCustodyRuntimeExecutable;
  const interactiveProvider = withWindowsInteractiveCustody(provider, { platform,
    ...(resolveWindowsCustody ? {
      resolveExecutable: () => resolveWindowsCustody('win32'),
    } : {}),
  });
  return { ...interactiveProvider, prepare };
}
