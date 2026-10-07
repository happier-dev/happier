import { resolveSocketRpcSessionAuthorization, SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS } from '@happier-dev/protocol/socketRpc';
import type { SocketRpcAuthorizationContext } from '@happier-dev/protocol/socketRpc';
import { SOCKET_RPC_EVENTS, SessionTransferRoutingV1Schema, SocketRpcSessionActionAuthorizationContextSchema, isSessionActionRpcMethodV1 } from '@happier-dev/protocol/socketRpc';
import type { SessionTransferRoutingV1, SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { socketRpcCodec, type SocketRpcContent } from './socketRpcCodec.js';
import { markRpcRequestDisposition, readRpcRequestDisposition } from './rpcDisposition.js';
import { createSocketRpcAbortError, createSocketRpcRequestId, issueSocketRpcCallWithCancellation, raceSocketIoAckTimeout } from './socketRpcCancellation.js';

export type SocketRpcAckScope = Readonly<{
  emit?(event: string, ...args: unknown[]): unknown;
  emitWithAck?(event: string, ...args: unknown[]): Promise<unknown>;
}>;
export type SocketRpcSocket = SocketRpcAckScope & Readonly<{
  connected?: boolean;
  emit(event: string, ...args: unknown[]): unknown;
  timeout?(timeoutMs: number): SocketRpcAckScope;
}>;
export async function emitWithAckCancellable<T>(params: Readonly<{
  socket: SocketRpcSocket; event: string; payload: unknown;
  timeoutMs?: number | null; signal?: AbortSignal; requestId?: string; onIssued?: () => void;
}>): Promise<T> {
  let issued = false;
  try {
    if (params.signal?.aborted) throw createSocketRpcAbortError();
    if (params.socket.connected === false) throw new Error('Socket not connected');
    const timeout = typeof params.timeoutMs === 'number' && params.timeoutMs > 0 ? params.timeoutMs : undefined;
    // Socket.IO's native timer overflows above this platform boundary; the
    // existing acknowledgement race owns those longer authored deadlines.
    const nativeTimeout = timeout !== undefined && timeout <= 2_147_483_647 ? timeout : undefined;
    const emission = nativeTimeout !== undefined && params.socket.timeout ? params.socket.timeout(nativeTimeout) : params.socket;
    const emit = emission.emit;
    const emitWithAck = emission.emitWithAck;
    if (!emitWithAck && !emit) throw new Error('Socket acknowledgement scope cannot emit');
    return await issueSocketRpcCallWithCancellation<T>({
      signal: params.signal, requestId: params.requestId, onIssued: params.onIssued,
      emitCancel: (requestId) => { params.socket.emit(SOCKET_RPC_EVENTS.CANCEL, { requestId }); },
      issue: () => {
        issued = true;
        const result = emitWithAck
          ? emitWithAck.call(emission, params.event, params.payload)
          : new Promise<unknown>((resolve, reject) => {
              emit!.call(emission, params.event, params.payload, (...args: unknown[]) => {
                if (nativeTimeout !== undefined && params.socket.timeout) {
                  if (args[0]) reject(args[0]); else resolve(args[1]);
                } else resolve(args[0]);
              });
            });
        return raceSocketIoAckTimeout(result as Promise<T>, timeout, params.signal);
      },
    });
  } catch (error) { throw markRpcRequestDisposition(error, issued ? 'outcomeUnknown' : 'notSent'); }
}
export async function callSocketRpc<R>(params: Readonly<{
  socket: SocketRpcSocket; target: Readonly<{ kind: 'session' | 'machine'; id: string }>;
  method: string; params: unknown; content: SocketRpcContent;
  authorization?: SocketRpcAuthorizationContext; timeoutMs?: number | null;
  transferRouting?: SessionTransferRoutingV1;
  signal?: AbortSignal; onIssued?: () => void; requestId?: string;
  randomBytes?: (length: number) => Uint8Array;
  transportResponseEnvelopeVersion?: SocketRpcRequestPayload['transportResponseEnvelopeVersion'];
  createExternalActionExecution?: (request: Readonly<{ method: string; requestId: string; params: unknown }>) => SocketRpcRequestPayload['externalActionExecution'];
}>): Promise<R> {
  let acknowledged = false;
  try {
    if (params.signal?.aborted) throw createSocketRpcAbortError();
    const sessionActionAuthorization = params.authorization?.kind === SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_ACTION
      ? SocketRpcSessionActionAuthorizationContextSchema.parse(params.authorization) : undefined;
    if (sessionActionAuthorization && (params.target.kind !== 'session'
      || sessionActionAuthorization.sessionId !== params.target.id || !isSessionActionRpcMethodV1(params.method))) {
      throw new Error('Session Action authorization does not match the RPC target');
    }
    const transferRouting = params.transferRouting === undefined ? undefined : SessionTransferRoutingV1Schema.parse(params.transferRouting);
    if (transferRouting && (params.target.kind !== 'session'
      || transferRouting.sessionId !== params.target.id || transferRouting.method !== params.method)) {
      throw new Error('Session transfer routing does not match the RPC target');
    }
    const callId = Array.from(params.randomBytes ? params.randomBytes(16) : globalThis.crypto.getRandomValues(new Uint8Array(16)),
      byte => byte.toString(16).padStart(2, '0')).join('');
    const method = `${params.target.id}:${params.method}`;
    const encoded = await socketRpcCodec.encodeParams(params.content, params.params, { method, callId });
    if (params.signal?.aborted) throw createSocketRpcAbortError();
    const requestId = params.requestId ?? (params.signal || params.createExternalActionExecution ? createSocketRpcRequestId() : undefined);
    const authorization = sessionActionAuthorization ?? (params.target.kind === 'session'
      ? resolveSocketRpcSessionAuthorization(params.method)
        ? { kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE, sessionId: params.target.id } as const
        : undefined
      : params.authorization);
    const externalActionExecution = params.createExternalActionExecution && requestId ? params.createExternalActionExecution({ method, requestId, params: encoded }) : undefined;
    const payload: SocketRpcRequestPayload = {
      method, params: encoded,
      ...(transferRouting ? { transferRouting } : {}),
      ...(requestId ? { requestId } : {}),
      ...(typeof params.timeoutMs === 'number' && params.timeoutMs > 0 ? { timeoutMs: params.timeoutMs } : {}),
      ...(authorization ? { authorization } : {}),
      ...(externalActionExecution ? { externalActionExecution } : {}),
      ...(params.transportResponseEnvelopeVersion === undefined ? {} : { transportResponseEnvelopeVersion: params.transportResponseEnvelopeVersion }),
    };
    const ack = await emitWithAckCancellable({ ...params, event: SOCKET_RPC_EVENTS.CALL, payload, requestId });
    acknowledged = true;
    const result = await socketRpcCodec.decodeResult(params.content, ack, callId);
    if (params.signal?.aborted) throw markRpcRequestDisposition(createSocketRpcAbortError(), 'outcomeUnknown');
    return result as R;
  } catch (error) {
    throw readRpcRequestDisposition(error) === null ? markRpcRequestDisposition(error, acknowledged ? 'outcomeUnknown' : 'notSent') : error;
  }
}
