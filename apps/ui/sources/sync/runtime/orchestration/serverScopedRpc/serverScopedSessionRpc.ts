import {
  callSocketRpc,
  createSocketRpcAbortError,
  markRpcRequestDisposition,
  readRpcRequestDisposition,
} from '@happier-dev/sync-client';
import { getRandomBytes } from '@/platform/cryptoRandom';
import {
  RPC_ERROR_CODES,
  resolveSocketRpcSessionAuthorization,
} from '@happier-dev/protocol/rpc';

import { createRpcCallError } from '@/sync/runtime/rpcErrors';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { createEphemeralServerSocketClient } from '@/sync/runtime/orchestration/serverScopedRpc/createEphemeralServerSocketClient';
import { createScopedSocketConnectParams } from '@/sync/runtime/orchestration/serverScopedRpc/createScopedSocketConnectParams';
import {
  initializeScopedSessionReader,
  resolveScopedSessionCryptoContext,
} from '@/sync/runtime/orchestration/serverScopedRpc/resolveScopedSessionDataKey';
import { resolveServerAccountRequestContext } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerAccountRequestContext';
import type { ResolvedServerAccountRequestContext } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerAccountRequestContext';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { userRequestLeaseOwner } from '@/sync/runtime/connectivity/userRequestLease';
import type { SessionTransferRoutingV1 } from '@happier-dev/protocol/socketRpc';
import {
  areServerAccountScopesEqual,
  createServerAccountScope,
  type ServerAccountScope,
} from '@/sync/domains/scope/serverAccountScope';

function normalizeId(raw: unknown): string {
  return String(raw ?? '').trim();
}

function shouldRetryWithScopedSessionContext(error: unknown): boolean {
  if (readRpcErrorCode(error) === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /session encryption not found/i.test(message);
}

function requiresActivePersistentHomeSocket(method: string): boolean {
  return resolveSocketRpcSessionAuthorization(method)?.serverMintedContext
    === 'session.presentation.origin';
}

function createActiveHomeRequiredError(): Error {
  return createRpcCallError({
    error: 'Current-Session presentation requires the active persistent Home connection',
    errorCode: 'current_session_presentation_active_home_required',
  });
}

async function callScopedSessionRpc<R, A>(params: Readonly<{
  sessionId: string;
  method: string;
  payload: A;
  context: Extract<ResolvedServerAccountRequestContext, { scope: 'scoped' }>;
  operationTimeoutMs: number | null;
  networkMode?: 'background-task';
  onIssued?: () => void;
  signal?: AbortSignal;
  transferRouting?: SessionTransferRoutingV1;
}>): Promise<R> {
  const releaseRequestLease = params.networkMode === 'background-task'
    ? () => {}
    : userRequestLeaseOwner.acquire();
  let carrierCustodyTransferred = false;
  let socketForCleanup: Awaited<ReturnType<typeof createEphemeralServerSocketClient>> | null = null;
  try {
    if (params.signal?.aborted) throw createSocketRpcAbortError();
    if (requiresActivePersistentHomeSocket(params.method)) {
      throw createActiveHomeRequiredError();
    }
    const cryptoContext = await resolveScopedSessionCryptoContext({
      serverId: params.context.targetServerId,
      serverUrl: params.context.targetServerUrl,
      ...(params.context.runtimeOrigin ? { runtimeOrigin: params.context.runtimeOrigin } : {}),
      ...(params.context.homeCarrier ? { homeCarrier: params.context.homeCarrier } : {}),
      token: params.context.token,
      ...(params.context.credentials ? { credentials: params.context.credentials } : {}),
      sessionId: params.sessionId,
      timeoutMs: params.context.timeoutMs,
      readTransport: params.context.readTransport,
      ...(params.networkMode === 'background-task' ? { explicitRetry: true } : {}),
      signal: params.signal,
      ...(params.context.encryption
        ? {
            decryptEncryptionKey: (value: string) =>
              params.context.encryption!.decryptEncryptionKey(value, {
                serverId: params.context.targetServerId, workClass: 'interactive',
              }),
          }
        : {}),
    });
    if (params.signal?.aborted) throw createSocketRpcAbortError();

    const socket = await createEphemeralServerSocketClient(
      {
        ...createScopedSocketConnectParams(params.context, () => {
          carrierCustodyTransferred = true;
          return params.context.release;
        }),
        ...(params.networkMode ? { networkMode: params.networkMode } : {}),
        signal: params.signal,
      },
    );
    socketForCleanup = socket;
    if (params.signal?.aborted) throw createSocketRpcAbortError();
    if (cryptoContext.encryptionMode === 'plain') {
      return await callSocketRpc<R>({
        randomBytes: getRandomBytes,
        socket,
        target: { kind: 'session', id: params.sessionId },
        method: params.method,
        params: params.payload,
        content: { mode: 'plain' },
        timeoutMs: params.operationTimeoutMs,
        onIssued: params.onIssued,
        signal: params.signal,
        transferRouting: params.transferRouting,
      });
    }

    if (cryptoContext.encryptionMode !== 'e2ee' && cryptoContext.encryptionMode !== 'legacy_fallback') {
      throw createRpcCallError({
        error: 'Unable to resolve session encryption for scoped RPC',
        errorCode: 'scoped_session_encryption_unavailable',
      });
    }

    if (!params.context.encryption) {
      throw createRpcCallError({
        error: 'Session encryption material is unavailable for scoped E2EE RPC',
        errorCode: 'scoped_session_encryption_unavailable',
      });
    }
    await initializeScopedSessionReader({
      sessionId: params.sessionId,
      serverId: params.context.targetServerId,
      context: cryptoContext,
      encryption: params.context.encryption,
    });
    const sessionEncryption = params.context.encryption.getSessionEncryption(params.sessionId);
    if (!sessionEncryption) {
      throw createRpcCallError({
        error: `Session encryption not found for ${params.sessionId}`,
        errorCode: 'session_encryption_not_found',
      });
    }

    return await callSocketRpc<R>({
      randomBytes: getRandomBytes,
      socket,
      target: { kind: 'session', id: params.sessionId },
      method: params.method,
      params: params.payload,
      content: { mode: 'e2ee', cipher: sessionEncryption },
      timeoutMs: params.operationTimeoutMs,
      onIssued: params.onIssued,
      signal: params.signal,
      transferRouting: params.transferRouting,
    });
  } catch (error) {
    throw readRpcRequestDisposition(error) === null ? markRpcRequestDisposition(error, 'notSent') : error;
  } finally {
    try {
      socketForCleanup?.disconnect();
      if (!carrierCustodyTransferred) await params.context.release?.();
    } finally {
      releaseRequestLease();
    }
  }
}

export async function sessionRpcWithServerScope<R, A>(params: Readonly<{
  sessionId: string;
  serverId?: string | null;
  method: string;
  payload: A;
  timeoutMs?: number | null;
  onIssued?: () => void;
  signal?: AbortSignal;
  transferRouting?: SessionTransferRoutingV1;
}>): Promise<R> {
  if (params.signal?.aborted) throw markRpcRequestDisposition(createSocketRpcAbortError(), 'notSent');
  const sessionId = normalizeId(params.sessionId);
  const context = await resolveServerAccountRequestContext({
    serverId: params.serverId,
    ...(typeof params.timeoutMs === 'number' ? { timeoutMs: params.timeoutMs } : {}),
  }).catch((error: unknown) => { throw markRpcRequestDisposition(error, 'notSent'); });
  // Setup has its own connection budget. Only an explicitly supplied operation
  // deadline may cut off work whose completion belongs to the remote owner.
  const operationTimeoutMs = typeof params.timeoutMs === 'number' ? context.timeoutMs : null;
  let exactIssuanceAttempted = false;
  const onIssued = () => {
    exactIssuanceAttempted = true;
    params.onIssued?.();
  };

  if (context.scope === 'active') {
    try {
      return await apiSocket.sessionRPC<R, A>(sessionId, params.method, params.payload, {
        timeoutMs: operationTimeoutMs,
        onIssued,
        signal: params.signal,
        transferRouting: params.transferRouting,
      });
    } catch (error) {
      const callError = readRpcRequestDisposition(error) === null
        ? markRpcRequestDisposition(error, exactIssuanceAttempted ? 'outcomeUnknown' : 'notSent')
        : error;
      if (apiSocket.getSessionScopedTarget()) throw callError;
      if (exactIssuanceAttempted) throw callError;
      if (params.signal?.aborted) throw markRpcRequestDisposition(createSocketRpcAbortError(), 'notSent');
      if (requiresActivePersistentHomeSocket(params.method)) throw callError;
      if (!shouldRetryWithScopedSessionContext(error)) throw callError;
      const retryContext = await resolveServerAccountRequestContext({
        serverId: params.serverId,
        ...(typeof params.timeoutMs === 'number' ? { timeoutMs: params.timeoutMs } : {}),
        preferScoped: true,
      }).catch((error: unknown) => { throw markRpcRequestDisposition(error, 'notSent'); });
      if (retryContext.scope !== 'scoped') throw callError;
      return await callScopedSessionRpc({
        sessionId,
        method: params.method,
        payload: params.payload,
        context: retryContext,
        operationTimeoutMs,
        onIssued,
        signal: params.signal,
        transferRouting: params.transferRouting,
      });
    }
  }
  return await callScopedSessionRpc({
    sessionId,
    method: params.method,
    payload: params.payload,
    context,
    operationTimeoutMs,
    onIssued,
    signal: params.signal,
    transferRouting: params.transferRouting,
  });
}

export async function sessionRpcWithServerAccountScope<R, A>(params: Readonly<{
  sessionId: string;
  scope: ServerAccountScope;
  method: string;
  payload: A;
  timeoutMs?: number | null;
  onIssued?: () => void;
  signal?: AbortSignal;
  networkMode?: 'background-task';
  transferRouting?: SessionTransferRoutingV1;
}>): Promise<R> {
  if (params.signal?.aborted) throw markRpcRequestDisposition(createSocketRpcAbortError(), 'notSent');
  const context = await resolveServerAccountRequestContext({
    serverId: params.scope.serverId,
    ...(typeof params.timeoutMs === 'number' ? { timeoutMs: params.timeoutMs } : {}),
    preferScoped: true,
    signal: params.signal,
    networkMode: params.networkMode,
  }).catch((error: unknown) => { throw markRpcRequestDisposition(error, 'notSent'); });
  if (context.scope !== 'scoped') {
    throw markRpcRequestDisposition(new Error('Exact pending dispatch scope did not resolve to scoped credentials'), 'notSent');
  }
  const resolvedScope = createServerAccountScope(context.targetServerId, context.targetAccountId);
  if (!areServerAccountScopesEqual(resolvedScope, params.scope)) {
    try {
      await context.release?.();
    } catch (error) {
      throw markRpcRequestDisposition(error, 'notSent');
    }
    throw markRpcRequestDisposition(new Error('Exact pending dispatch authenticated account does not match persisted scope'), 'notSent');
  }
  return await callScopedSessionRpc({
    sessionId: normalizeId(params.sessionId),
    method: params.method,
    payload: params.payload,
    context,
    operationTimeoutMs: typeof params.timeoutMs === 'number' ? context.timeoutMs : null,
    onIssued: params.onIssued,
    signal: params.signal,
    networkMode: params.networkMode,
    transferRouting: params.transferRouting,
  });
}
