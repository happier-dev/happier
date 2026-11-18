import { createUserScopedSocketConnection } from '@/api/session/sockets';
import { markRpcRequestDisposition, readRpcRequestDisposition } from '@happier-dev/sync-client';
import { readActionErrorCodeV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { isRecord } from '@happier-dev/protocol/common/records';
import { RpcError } from '@happier-dev/protocol/rpcErrors';
import { createManagedConnectionSupervisor, DEFAULT_MANAGED_CONNECTION_POLICY } from '@happier-dev/connection-supervisor';
import { classifyTransportErrorToProbeResult } from '@/api/connection/classifyTransportErrorToProbeResult';
import { createAuthenticationHttpStatusError, readHttpStatus } from '@/api/client/httpStatusError';

type RpcSocket = ReturnType<typeof createUserScopedSocketConnection>['socket'];

export type RpcObservationOptions = Readonly<{
  readRequest?: () => unknown;
  /** False observes the next owner change on the same connection. */
  onResult?: (result: unknown) => boolean | Promise<boolean>;
}>;

/** Shared passive response pump for Session and exact-Machine RPC adapters. */
export async function readRpcObservation(params: Readonly<{
  request: unknown;
  signal?: AbortSignal;
  observation?: RpcObservationOptions;
  read: (request: unknown) => Promise<unknown>;
}>): Promise<unknown> {
  const withinCallerLifetime = async <T>(pending: Promise<T>): Promise<T> => {
    const signal = params.signal;
    if (!signal) return await pending;
    signal.throwIfAborted();
    let onAbort = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try { return await Promise.race([pending, cancelled]); }
    finally { signal.removeEventListener('abort', onAbort); }
  };
  for (;;) {
    params.signal?.throwIfAborted();
    const request = await withinCallerLifetime(Promise.resolve(params.observation?.readRequest?.() ?? params.request));
    params.signal?.throwIfAborted();
    // The RPC transport owns issued/not-sent cancellation evidence. Race only
    // output backpressure, not its in-flight read, against the caller lifetime.
    const result = await params.read(request);
    // A one-shot call can be a write: do not discard its decoded receipt.
    // Passive observation/backpressure retains cancellation withdrawal below.
    if (!params.observation) return result;
    params.signal?.throwIfAborted();
    if (!params.observation?.onResult
      || await withinCallerLifetime(Promise.resolve(params.observation.onResult(result)))) return result;
  }
}

/** CLI-owned RPC lifetime; read-only observations use the shared reconnect owner. */
export async function withUserScopedRpcSocket<R>(
  params: Readonly<{
    token: string;
    authorityCeiling?: 'account_automation';
    serverUrl?: string;
    connectTimeoutMs: number;
    signal?: AbortSignal;
    /** Read-only observation only: reattach through the existing reconnect owner. */
    reattachOnReconnect?: true;
  }>,
  run: (socket: RpcSocket, connect: () => Promise<void>, signal?: AbortSignal) => Promise<R>,
): Promise<R> {
  params.signal?.throwIfAborted();
  const connectionOptions = { ...params, clientPurpose: 'scoped-rpc' };
  if (params.reattachOnReconnect) {
    let current: Readonly<{ socket: RpcSocket; signal: AbortController }> | null = null;
    const abortCurrent = () => { current?.signal.abort(); };
    let resolveResult!: (result: R) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<R>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    const onAbort = () => rejectResult(params.signal?.reason ?? new DOMException('RPC observation cancelled', 'AbortError'));
    const supervisor = createManagedConnectionSupervisor({
      ...DEFAULT_MANAGED_CONNECTION_POLICY,
      createTransport: () => {
        const connection = createUserScopedSocketConnection(connectionOptions);
        const signal = new AbortController();
        current = { socket: connection.socket, signal };
        return { ...connection.transport, destroy: async () => {
          signal.abort();
          await connection.transport.destroy();
          connection.socket.close();
        } };
      },
      probeReadiness: async () => ({ status: 'ready' }),
      classifyTransportErrorToProbeResult,
      onDisconnected: abortCurrent,
      onConnected: () => {
        const attempt = current;
        if (!attempt) return;
        // A disconnected occurrence cannot settle the resumed observation with
        // a late acknowledgement. Reconnect reads the same owner's retained result.
        void run(attempt.socket, async () => { attempt.signal.signal.throwIfAborted(); }, attempt.signal.signal)
          .then((value) => { if (!attempt.signal.signal.aborted) resolveResult(value); }, (error: unknown) => {
            if (!attempt.signal.signal.aborted) rejectResult(error);
          });
      },
      onAuthFailed: ({ probe }) => rejectResult(createAuthenticationHttpStatusError(
        probe.statusCode === 403 ? 403 : 401, 'RPC observation authentication failed',
      )),
    });
    params.signal?.addEventListener('abort', onAbort, { once: true });
    if (params.signal?.aborted) onAbort();
    else void supervisor.start().catch(rejectResult);
    try { return await result; }
    finally {
      params.signal?.removeEventListener('abort', onAbort);
      abortCurrent();
      await supervisor.stop();
    }
  }
  const connection = createUserScopedSocketConnection(connectionOptions);
  const connect = async () => {
    params.signal?.throwIfAborted();
    let onAbort = () => {};
    const stopped = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(params.signal?.reason ?? Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
      params.signal?.addEventListener('abort', onAbort, { once: true });
    });
    try {
      // The adapter settles a connection that closes during the attempt.
      // The RPC emission owner checks a socket that closes after it connected.
      await Promise.race([stopped, connection.transport.connect()]);
      params.signal?.throwIfAborted();
    } catch (error) {
      if (!(error instanceof Error && 'data' in error && isRecord(error.data))) throw error;
      const code = readActionErrorCodeV1({ code: error.data.error });
      if (!code) throw error;
      const httpStatus = readHttpStatus(error);
      throw Object.assign(new RpcError(`Home refused the RPC connection: ${code}`, code, {
        phase: 'rpc.connect', errorClass: 'RpcError', errorCode: code, httpStatus,
      }), { data: { statusCode: httpStatus } });
    } finally {
      params.signal?.removeEventListener('abort', onAbort);
    }
  };
  try {
    return await run(connection.socket, connect, params.signal);
  } catch (error) {
    throw readRpcRequestDisposition(error) === null ? markRpcRequestDisposition(error, 'notSent') : error;
  } finally {
    try { await connection.transport.destroy(); } catch { /* Preserve the RPC result. */ }
    try { connection.socket.close(); } catch { /* Preserve the RPC result. */ }
  }
}
