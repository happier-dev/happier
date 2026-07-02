import {
  hasBuiltInAcpConfig,
  isAgentId,
  type AcpForkSessionRequestV1,
  type AcpForkSessionResultV1,
  type AcpLoadSessionRequestV1,
  type AcpLoadSessionResultV1,
  type AcpSessionOperationsV1,
} from '@happier-dev/agents';

import type { AgentFactoryOptions } from '@/agent/core';
import { requireCatalogEntry, type CatalogAgentLookupId } from '@/backends/catalog';
import type { CatalogAcpBackendCreateResult, CatalogAcpBackendFactory } from '@/backends/types';
import type { CatalogAcpBackend } from './runtime/acpRuntimeBackendContract';
import { loadBuiltInRuntimeOwners } from './catalog/builtIn/runtimeOwners';
import { createAcpBackendFactoryFromRuntimeDefinitionBridge } from './runtime/definition/factory';

const cachedFactoryPromises = new Map<CatalogAgentLookupId, Promise<CatalogAcpBackendFactory>>();

async function loadCatalogAcpFactory(agentId: CatalogAgentLookupId): Promise<CatalogAcpBackendFactory> {
  if (isAgentId(agentId) && hasBuiltInAcpConfig(agentId)) {
    const runtimeOwners = await loadBuiltInRuntimeOwners(agentId);
    return (opts) => ({ backend: runtimeOwners.createRuntime(opts) });
  }

  const entry = requireCatalogEntry(agentId);
  if (entry.getAcpRuntimeDefinitionBridge) {
    const bridge = await entry.getAcpRuntimeDefinitionBridge();
    if (bridge) {
      return createAcpBackendFactoryFromRuntimeDefinitionBridge(bridge);
    }
  }
  if (!entry.getAcpBackendFactory) {
    throw new Error(`Agent '${agentId}' does not support ACP backends`);
  }
  return await entry.getAcpBackendFactory();
}

async function getCatalogAcpFactory(agentId: CatalogAgentLookupId): Promise<CatalogAcpBackendFactory> {
  const existing = cachedFactoryPromises.get(agentId);
  if (existing) return await existing;

  const promise = loadCatalogAcpFactory(agentId);
  cachedFactoryPromises.set(agentId, promise);
  try {
    return await promise;
  } catch (error) {
    if (cachedFactoryPromises.get(agentId) === promise) {
      cachedFactoryPromises.delete(agentId);
    }
    throw error;
  }
}

export async function createCatalogAcpBackend<
  TOptions extends AgentFactoryOptions,
  TResult extends CatalogAcpBackendCreateResult = CatalogAcpBackendCreateResult,
>(
  agentId: CatalogAgentLookupId,
  opts: TOptions,
): Promise<TResult> {
  const factory = await getCatalogAcpFactory(agentId);
  return await factory(opts) as TResult;
}

function readTrimmedString(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readOperationDirectory(directory: string | undefined): string {
  const normalized = readTrimmedString(directory);
  return normalized.length > 0 ? normalized : process.cwd();
}

function readStartedProviderSessionId(result: Readonly<{ sessionId?: string }>): string {
  return readTrimmedString(result.sessionId);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

function mapAcpOperationError(error: unknown): AcpLoadSessionResultV1 | AcpForkSessionResultV1 {
  if (isAbortError(error)) {
    return {
      ok: false,
      code: 'cancelled',
      retryable: false,
      message: readErrorMessage(error),
    };
  }
  const message = readErrorMessage(error);
  if (/does not support ACP (?:session\/fork|backends)/i.test(message)) {
    return {
      ok: false,
      code: 'unsupported',
      retryable: false,
      message,
    };
  }
  return {
    ok: false,
    code: 'provider_error',
    retryable: false,
    message,
  };
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function createAcpOperationAbortError(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason;
  const message = reason instanceof Error && reason.message ? reason.message : 'Operation cancelled';
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

async function disposeAcpBackend(backend: CatalogAcpBackend): Promise<void> {
  try {
    await backend.dispose();
  } catch {
    // Best-effort disposal must not mask the operation result.
  }
}

function createAcpBackendDisposer(backend: CatalogAcpBackend): () => Promise<void> {
  let disposed = false;
  return async () => {
    if (disposed) return;
    disposed = true;
    await disposeAcpBackend(backend);
  };
}

async function runAcpBackendOperationWithAbort<T>(params: Readonly<{
  signal?: AbortSignal;
  disposeBackend: () => Promise<void>;
  operation: () => Promise<T>;
}>): Promise<T> {
  if (!params.signal) {
    return await params.operation();
  }
  if (params.signal.aborted) {
    throw createAcpOperationAbortError(params.signal);
  }

  let abortListener: (() => void) | null = null;
  let abortError: Error | null = null;
  let abortDisposal: Promise<void> | null = null;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    abortListener = () => {
      abortError = createAcpOperationAbortError(params.signal);
      abortDisposal = params.disposeBackend();
      void abortDisposal.then(
        () => reject(abortError!),
        () => reject(abortError!),
      );
    };
    params.signal!.addEventListener('abort', abortListener, { once: true });
  });
  const operationPromise = params.operation().then(
    async (value) => {
      if (abortError) {
        await abortDisposal;
        throw abortError;
      }
      return value;
    },
    async (error) => {
      if (abortError) {
        await abortDisposal;
        throw abortError;
      }
      throw error;
    },
  );

  try {
    return await Promise.race([
      operationPromise,
      abortPromise,
    ]);
  } finally {
    if (abortListener) {
      params.signal.removeEventListener('abort', abortListener);
    }
  }
}

async function createAcpBackendForSessionOperation(
  request: Readonly<{ backendId: string; directory?: string }>,
): Promise<CatalogAcpBackend> {
  const backendId = readTrimmedString(request.backendId);
  if (!backendId) {
    throw new Error('ACP backend id is required');
  }
  const result = await createCatalogAcpBackend(backendId as CatalogAgentLookupId, {
    cwd: readOperationDirectory(request.directory),
  });
  return result.backend;
}

async function loadAcpSessionOperation(
  request: AcpLoadSessionRequestV1,
): Promise<AcpLoadSessionResultV1> {
  const providerSessionId = readTrimmedString(request.providerSessionId);
  if (!providerSessionId) {
    return {
      ok: false,
      code: 'invalid_request',
      retryable: false,
      message: 'Provider session id is required',
    };
  }
  if (isSignalAborted(request.signal)) {
    return {
      ok: false,
      code: 'cancelled',
      retryable: false,
      message: 'Operation cancelled',
    };
  }

  let backend: CatalogAcpBackend | null = null;
  let disposeBackend: (() => Promise<void>) | null = null;
  try {
    backend = await createAcpBackendForSessionOperation(request);
    disposeBackend = createAcpBackendDisposer(backend);
    if (typeof backend.loadSession !== 'function') {
      return {
        ok: false,
        code: 'unsupported',
        retryable: false,
        message: 'ACP backend does not support session load',
      };
    }
    const result = await runAcpBackendOperationWithAbort({
      signal: request.signal,
      disposeBackend,
      operation: async () => await backend!.loadSession!(providerSessionId),
    });
    const loadedProviderSessionId = readStartedProviderSessionId(result);
    if (!loadedProviderSessionId) {
      return {
        ok: false,
        code: 'provider_error',
        retryable: false,
        message: 'ACP session load did not return a provider session id',
      };
    }
    return {
      ok: true,
      value: { providerSessionId: loadedProviderSessionId },
    };
  } catch (error) {
    return mapAcpOperationError(error) as AcpLoadSessionResultV1;
  } finally {
    if (disposeBackend) {
      await disposeBackend();
    }
  }
}

async function forkAcpSessionOperation(
  request: AcpForkSessionRequestV1,
): Promise<AcpForkSessionResultV1> {
  const sourceProviderSessionId = readTrimmedString(request.sourceProviderSessionId);
  if (!sourceProviderSessionId) {
    return {
      ok: false,
      code: 'invalid_request',
      retryable: false,
      message: 'Source provider session id is required',
    };
  }
  if (isSignalAborted(request.signal)) {
    return {
      ok: false,
      code: 'cancelled',
      retryable: false,
      message: 'Operation cancelled',
    };
  }

  let backend: CatalogAcpBackend | null = null;
  let disposeBackend: (() => Promise<void>) | null = null;
  try {
    backend = await createAcpBackendForSessionOperation(request);
    disposeBackend = createAcpBackendDisposer(backend);
    if (typeof backend.loadSession !== 'function' || typeof backend.forkSession !== 'function') {
      return {
        ok: false,
        code: 'unsupported',
        retryable: false,
        message: 'ACP backend does not support session load/fork',
      };
    }
    await runAcpBackendOperationWithAbort({
      signal: request.signal,
      disposeBackend,
      operation: async () => await backend!.loadSession!(sourceProviderSessionId),
    });
    const result = await runAcpBackendOperationWithAbort({
      signal: request.signal,
      disposeBackend,
      operation: async () => await backend!.forkSession!({
        sessionId: sourceProviderSessionId,
        ...(readTrimmedString(request.directory) ? { cwd: readTrimmedString(request.directory) } : {}),
      }),
    });
    const forkedProviderSessionId = readStartedProviderSessionId(result);
    if (!forkedProviderSessionId) {
      return {
        ok: false,
        code: 'provider_error',
        retryable: false,
        message: 'ACP session fork did not return a provider session id',
      };
    }
    return {
      ok: true,
      value: { providerSessionId: forkedProviderSessionId },
    };
  } catch (error) {
    return mapAcpOperationError(error) as AcpForkSessionResultV1;
  } finally {
    if (disposeBackend) {
      await disposeBackend();
    }
  }
}

export function createAcpSessionOperations(): AcpSessionOperationsV1 {
  return Object.freeze({
    loadSession: loadAcpSessionOperation,
    forkSession: forkAcpSessionOperation,
  });
}
