import { createRequire } from 'node:module';

import { isEmbeddedBunBundlePath } from '@/runtime/js/isEmbeddedBunBundlePath';
import { logger } from '@/ui/logger';
import { createPythonPtyRelayProvider } from './pythonPtyRelayProvider';

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
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: (signal?: string) => void;
  onData: (listener: (data: string) => void) => Disposable;
  onExit: (listener: (e: PtyExitEvent) => void) => Disposable;
}>;

export type PtySpawnParams = Readonly<{
  file: string;
  args: string[] | string;
  options: PtyForkOptions;
}>;

export type PtyProvider = Readonly<{
  spawn: (params: PtySpawnParams) => PtyProcess;
}>;

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
}>): string {
  const importMetaUrl = String(params?.importMetaUrl ?? import.meta.url ?? '').trim();
  const currentExecPath = String(params?.currentExecPath ?? process.execPath ?? '').trim();
  const importMetaPath = parseImportMetaPath(importMetaUrl);
  if (importMetaPath && isEmbeddedBunBundlePath(importMetaPath) && currentExecPath) {
    return currentExecPath;
  }
  return importMetaUrl || currentExecPath;
}

export function createNodePtyProvider(params?: Readonly<{
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  fallbackProvider?: PtyProvider | null;
  fallbackBackendName?: string | null;
}>): PtyProvider {
  const requireBase = resolvePtyProviderRequireBase();
  const require = createRequire(requireBase);
  const fallbackProvider =
    params?.fallbackProvider
    ?? createPythonPtyRelayProvider({
      env: params?.env ?? process.env,
      platform: params?.platform ?? process.platform,
    });
  const fallbackBackendName =
    params?.fallbackBackendName
    ?? (fallbackProvider ? 'python-relay' : null);

  const tryResolveModule = (moduleId: string): { id: string; module: typeof import('node-pty') } | null => {
    try {
      return { id: moduleId, module: require(moduleId) as typeof import('node-pty') };
    } catch {
      return null;
    }
  };

  const preferred =
    tryResolveModule('node-pty')
    ?? tryResolveModule('@homebridge/node-pty-prebuilt-multiarch');

  const fallback = preferred?.id === '@homebridge/node-pty-prebuilt-multiarch'
    ? null
    : tryResolveModule('@homebridge/node-pty-prebuilt-multiarch');

  logger.debug('[terminal-pty] backend resolution', {
    platform: params?.platform ?? process.platform,
    requireBase,
    preferredBackend: preferred?.id ?? null,
    secondaryBackend: fallback?.id ?? null,
    fallbackBackend: fallbackProvider ? fallbackBackendName : null,
  });

  let loggedNativeMissingFallback = false;
  let loggedNativeFailureFallback = false;
  let loggedSecondaryNativeFallback = false;

  return {
    spawn: (params) => {
      let lastError: unknown = null;
      if (!preferred) {
        if (fallbackProvider) {
          if (!loggedNativeMissingFallback) {
            logger.debug('[terminal-pty] falling back to external PTY backend because native providers are unavailable', {
              fallbackBackend: fallbackBackendName,
            });
            loggedNativeMissingFallback = true;
          }
          return fallbackProvider.spawn(params);
        }
        throw new Error('terminal_pty_provider_missing');
      }
      try {
        return preferred.module.spawn(params.file, params.args, params.options);
      } catch (e) {
        lastError = e;
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
            return fallback.module.spawn(params.file, params.args, params.options);
          } catch (fallbackError) {
            lastError = fallbackError;
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
          return fallbackProvider.spawn(params);
        }
        throw lastError;
      }
    },
  };
}
