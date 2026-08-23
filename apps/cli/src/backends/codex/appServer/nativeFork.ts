import { logger as defaultLogger } from '@/utils/logger';

import { isCodexAppServerDefinitiveMethodNotFoundError } from './appServerCompatibility';
import { createCodexAppServerClient, type DisposableCodexAppServerClient } from './client/createCodexAppServerClient';
import { sanitizeCodexAppServerRpcDiagnosticString } from './client/codexAppServerRpcLogSanitizer';

type CodexAppServerThreadResponse = Readonly<{
  threadId?: unknown;
  id?: unknown;
  thread?: Readonly<{ id?: unknown; threadId?: unknown }> | null;
}>;

function readThreadId(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const response = value as CodexAppServerThreadResponse;
  const candidates = [response.threadId, response.id, response.thread?.threadId, response.thread?.id];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return null;
}

type CodexAppServerNativeForkDiagnosticsLogger = Pick<typeof defaultLogger, 'debug'>;

function readErrorDiagnostic(error: unknown, redactedValues: readonly string[]): Readonly<{
  errorName: string;
  errorMessage: string;
  errorCode?: string | number;
}> {
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : null;
  const rawErrorCode = record && (typeof record.code === 'string' || typeof record.code === 'number')
    ? record.code
    : undefined;
  const errorCode = typeof rawErrorCode === 'string'
    ? sanitizeCodexAppServerRpcDiagnosticString(rawErrorCode, { redactedValues })
    : rawErrorCode;
  if (error instanceof Error) {
    return {
      errorName: error.name || 'Error',
      errorMessage: sanitizeCodexAppServerRpcDiagnosticString(error.message, { redactedValues }),
      ...(errorCode !== undefined ? { errorCode } : {}),
    };
  }
  return {
    errorName: typeof error,
    errorMessage: sanitizeCodexAppServerRpcDiagnosticString(String(error), { redactedValues }),
    ...(errorCode !== undefined ? { errorCode } : {}),
  };
}

function readResponseDiagnostic(value: unknown): Readonly<{
  responseType: string;
  responseKeys?: string[];
}> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { responseType: value === null ? 'null' : typeof value };
  }
  return {
    responseType: 'object',
    responseKeys: Object.keys(value as Record<string, unknown>).slice(0, 12).sort(),
  };
}

function logNativeForkDiagnostic(
  logger: CodexAppServerNativeForkDiagnosticsLogger,
  message: string,
  details: Record<string, unknown>,
): void {
  try {
    logger.debug(message, details);
  } catch {
    // Diagnostics must never affect fork behavior.
  }
}

function buildBaseNativeForkDiagnostic(parentCodexSessionId: string): Readonly<{
  hasParentCodexSessionId: boolean;
}> {
  return {
    hasParentCodexSessionId: parentCodexSessionId.trim().length > 0,
  };
}

export type CodexAppServerNativeForkDeps = Readonly<{
  createClient?: typeof createCodexAppServerClient;
  logger?: CodexAppServerNativeForkDiagnosticsLogger;
}>;

export type CodexAppServerNativeForkOutcome =
  | Readonly<{ type: 'success'; vendorSessionId: string }>
  | Readonly<{ type: 'unsupported' }>
  | Readonly<{ type: 'failed_before_dispatch'; error: Error }>
  | Readonly<{ type: 'indeterminate_after_dispatch'; error: Error }>;

function toOutcomeError(error: unknown, fallbackMessage: string): Error {
  return error instanceof Error ? error : new Error(fallbackMessage);
}

export async function forkCodexAppServerConversationNative(
  params: Readonly<{
    directory: string;
    parentCodexSessionId: string;
    processEnv?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
  }>,
  deps: CodexAppServerNativeForkDeps = {},
): Promise<CodexAppServerNativeForkOutcome> {
  const parentCodexSessionId = typeof params.parentCodexSessionId === 'string'
    ? params.parentCodexSessionId.trim()
    : '';
  if (!parentCodexSessionId) return { type: 'unsupported' };

  const createClient = deps.createClient ?? createCodexAppServerClient;
  const diagnosticsLogger = deps.logger ?? defaultLogger;
  const baseDiagnostic = buildBaseNativeForkDiagnostic(parentCodexSessionId);
  let client: DisposableCodexAppServerClient | null = null;

  try {
    logNativeForkDiagnostic(diagnosticsLogger, '[CodexAppServerNativeFork] creating app-server client', {
      ...baseDiagnostic,
      hasProcessEnv: Boolean(params.processEnv),
      hasCodexHome: typeof params.processEnv?.CODEX_HOME === 'string' && params.processEnv.CODEX_HOME.trim().length > 0,
    });
    try {
      client = await createClient({
        cwd: params.directory,
        processEnv: params.processEnv,
        initializeRequestOptions: {
          timeoutMs: null,
          ...(params.signal ? { signal: params.signal } : {}),
        },
      });
    } catch (error) {
      if (params.signal?.aborted && error instanceof Error && error.name === 'AbortError') {
        throw error;
      }
      logNativeForkDiagnostic(diagnosticsLogger, '[CodexAppServerNativeFork] failed to create app-server client', {
        ...baseDiagnostic,
        ...readErrorDiagnostic(error, [parentCodexSessionId]),
        fallbackResult: 'failed_before_dispatch',
      });
      return {
        type: 'failed_before_dispatch',
        error: toOutcomeError(error, 'Failed to initialize Codex app-server for native fork'),
      };
    }

    for (const method of ['thread/fork', 'conversation/fork'] as const) {
      logNativeForkDiagnostic(diagnosticsLogger, '[CodexAppServerNativeFork] attempting method', {
        ...baseDiagnostic,
        method,
      });
      let response: unknown;
      try {
        response = await client.request(method, {
          threadId: parentCodexSessionId,
          persistExtendedHistory: true,
        }, {
          timeoutMs: null,
          ...(params.signal ? { signal: params.signal } : {}),
        });
      } catch (error) {
        if (params.signal?.aborted && error instanceof Error && error.name === 'AbortError') {
          throw error;
        }
        const methodUnavailable = isCodexAppServerDefinitiveMethodNotFoundError(error, method);
        const canTryAlias = method === 'thread/fork' && methodUnavailable;
        logNativeForkDiagnostic(diagnosticsLogger, '[CodexAppServerNativeFork] method failed', {
          ...baseDiagnostic,
          method,
          ...readErrorDiagnostic(error, [parentCodexSessionId]),
          fallbackResult: canTryAlias
            ? 'try_alias_after_unsupported'
            : methodUnavailable
              ? 'native_fork_unsupported'
              : 'indeterminate_after_dispatch',
        });
        if (canTryAlias) continue;
        if (methodUnavailable) return { type: 'unsupported' };

        // client.request has already settled, but this error cannot prove the
        // provider did not receive the mutation. Do not attempt either alias
        // or replay from this path.
        return {
          type: 'indeterminate_after_dispatch',
          error: toOutcomeError(error, 'Codex app-server native fork request failed after dispatch'),
        };
      }

      const vendorSessionId = readThreadId(response);
      if (vendorSessionId) {
        logNativeForkDiagnostic(diagnosticsLogger, '[CodexAppServerNativeFork] method succeeded', {
          ...baseDiagnostic,
          method,
          hasForkedVendorSessionId: true,
          fallbackResult: 'native_fork_succeeded',
        });
        return { type: 'success', vendorSessionId };
      }
      logNativeForkDiagnostic(diagnosticsLogger, '[CodexAppServerNativeFork] method returned no forked thread id', {
        ...baseDiagnostic,
        method,
        ...readResponseDiagnostic(response),
        fallbackResult: 'indeterminate_after_dispatch',
      });
      return {
        type: 'indeterminate_after_dispatch',
        error: new Error(`Codex app-server ${method} returned no forked thread id`),
      };
    }
    logNativeForkDiagnostic(diagnosticsLogger, '[CodexAppServerNativeFork] exhausted native fork methods', {
      ...baseDiagnostic,
      fallbackResult: 'native_fork_unsupported',
    });
    return { type: 'unsupported' };
  } finally {
    await client?.dispose().catch((error) => {
      logNativeForkDiagnostic(diagnosticsLogger, '[CodexAppServerNativeFork] failed to dispose app-server client', {
        ...baseDiagnostic,
        ...readErrorDiagnostic(error, [parentCodexSessionId]),
      });
    });
  }
}
