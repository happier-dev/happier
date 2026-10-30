import { resolveSocketRpcSessionAuthorization, SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS, SocketRpcTimeoutMsSchema } from '@happier-dev/protocol/socketRpc';
import { ANSWERING_CLIENT_RPC_PREFIX_V1, SocketRpcAnsweringClientV1Schema, type SocketRpcAnsweringClientV1 } from '@happier-dev/protocol/socketRpc';
import type { SocketRpcAuthorizationContext } from '@happier-dev/protocol/socketRpc';
import { SOCKET_RPC_EVENTS, SessionTransferRoutingV1Schema, SocketRpcSessionActionAuthorizationContextSchema, WorkspaceSyncSourceRoutingV1Schema, WorkspaceSyncTargetRoutingV1Schema, WorkspaceSyncSourceWriterTargetRoutingV1Schema, isSessionActionRpcMethodV1 } from '@happier-dev/protocol/socketRpc';
import type { SessionTransferRoutingV1, SocketRpcRequestPayload, WorkspaceSyncSourceRoutingV1, WorkspaceSyncTargetRoutingV1, WorkspaceSyncSourceWriterTargetRoutingV1 } from '@happier-dev/protocol/socketRpc';
import { socketRpcCodec, type SocketRpcContent } from './socketRpcCodec.js';
import { markRpcRequestDisposition, readRpcRequestDisposition } from './rpcDisposition.js';
import { createSocketRpcAbortError, createSocketRpcRequestId, issueSocketRpcCallWithCancellation, raceSocketIoAckTimeout } from './socketRpcCancellation.js';
import { ExternalActionRequestEnvelopeSchema, type ExternalActionRequestEnvelope } from '@happier-dev/protocol/actions/externalActionApi';
import { isReadOnlyMachineRpcMethod } from '@happier-dev/protocol/actions/actionSpecs';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createRpcCallError, RpcError, RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { readProjectServiceMoveChildEffectV1 } from '@happier-dev/protocol/workspaces/projectServiceRelocationV1';
import { WorkspaceSyncSourceExecutionV1Schema, WorkspaceSyncSeedRoutingV1Schema,
  type WorkspaceSyncSourceExecutionV1, type WorkspaceSyncSeedRoutingV1 } from '@happier-dev/protocol/socketRpc';

export type SocketRpcAckScope = Readonly<{
  emit?(event: string, ...args: unknown[]): unknown;
  emitWithAck?(event: string, ...args: unknown[]): Promise<unknown>;
}>;
export type SocketRpcSocket = SocketRpcAckScope & Readonly<{
  connected?: boolean;
  emit(event: string, ...args: unknown[]): unknown;
  timeout?(timeoutMs: number): SocketRpcAckScope;
  /** Retain a pooled transport independently of its logical caller until native ACK settlement. */
  retain?(): () => void;
}>;

/** Local native observation, distinct from identically worded remote error ACKs. */
class SocketRpcDisconnectedError extends RpcError {
  readonly cause: Error;
  constructor(cause: Error) {
    super(cause.message, RPC_ERROR_CODES.OUTCOME_UNKNOWN);
    this.cause = cause;
  }
}

function prepareSocketRpcEmission(socket: SocketRpcSocket, nativeTimeout: number | undefined) {
  // Socket.IO 4.8.3: timeout() returns the physical socket even through the
  // scoped pool; undefined clears the per-emit override without adding a timer.
  // sendBuffer is public, but acks is private. Keep that boundary here: emit
  // buffers synchronously, and invoking its ACK wrapper also clears its timer.
  type BufferedSocket = SocketRpcAckScope & {
    sendBuffer?: { id?: number; data?: unknown[] }[];
    acks?: Record<number, ((error: Error) => void) | undefined>;
  };
  const scope: BufferedSocket = socket.timeout ? Reflect.apply(socket.timeout, socket, [nativeTimeout]) : socket;
  // Non-Socket.IO adapters retain their raw callback convention for unbounded
  // deadlines; only a native socket needs its physical scope for buffer custody.
  const emission = nativeTimeout !== undefined || Array.isArray(scope.sendBuffer) ? scope : socket;
  const bufferStart = scope.sendBuffer?.length ?? 0;
  return {
    emission,
    rejectBuffered: (event: string, payload: unknown): boolean => {
      const buffer = scope.sendBuffer;
      const index = buffer?.findIndex((packet, index) => index >= bufferStart && packet.data?.[0] === event && packet.data[1] === payload) ?? -1;
      if (!buffer || index < 0) return false;
      const [packet] = buffer.splice(index, 1);
      if (packet.id !== undefined && scope.acks) {
        const ack = scope.acks[packet.id];
        delete scope.acks[packet.id];
        ack?.(createRpcCallError({ error: 'Socket did not dispatch RPC', errorCode: RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE }));
      }
      return true;
    },
  };
}
export async function emitWithAckCancellable<T>(params: Readonly<{
  socket: SocketRpcSocket; event: string; payload: unknown;
  timeoutMs?: number | null; signal?: AbortSignal; requestId?: string; onIssued?: () => void;
  waitForResultOnCancel?: boolean;
}>): Promise<T> {
  let issued = false;
  try {
    if (params.signal?.aborted) throw createSocketRpcAbortError();
    if (params.socket.connected === false) throw createRpcCallError({
      error: 'Socket not connected', errorCode: RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE,
    });
    const timeout = typeof params.timeoutMs === 'number' && params.timeoutMs > 0 ? params.timeoutMs : undefined;
    // Socket.IO's native timer overflows above this platform boundary; the
    // existing acknowledgement race owns those longer authored deadlines.
    const nativeTimeout = timeout !== undefined && timeout <= 2_147_483_647 ? timeout : undefined;
    const { emission, rejectBuffered } = prepareSocketRpcEmission(params.socket, nativeTimeout);
    const emit = emission.emit;
    const emitWithAck = emission.emitWithAck;
    if (!emitWithAck && !emit) throw new Error('Socket acknowledgement scope cannot emit');
    return await issueSocketRpcCallWithCancellation<T>({
      signal: params.signal, requestId: params.requestId, onIssued: params.onIssued,
      waitForResultOnCancel: params.waitForResultOnCancel,
      emitCancel: (requestId) => { params.socket.emit(SOCKET_RPC_EVENTS.CANCEL, { requestId }); },
      issue: () => {
        const release = params.socket.retain?.();
        let result: Promise<unknown>;
        try {
          result = emitWithAck
            ? emitWithAck.call(emission, params.event, params.payload)
            : new Promise<unknown>((resolve, reject) => {
                emit!.call(emission, params.event, params.payload, (...args: unknown[]) => {
                  if (nativeTimeout !== undefined && params.socket.timeout) {
                    if (args[0]) reject(args[0]); else resolve(args[1]);
                  } else resolve(args[0]);
                });
              });
        } catch (error) {
          release?.();
          throw error;
        }
        // Local cancellation or a portable deadline may settle the caller first.
        // Keep the entry alive until the native ACK itself resolves or rejects.
        if (release) result = result.finally(release);
        if (rejectBuffered(params.event, params.payload)) {
          // Its native ACK was rejected during cleanup. Consume that promise;
          // this synchronous refusal must never acquire issued/cancel custody.
          void result.catch(() => {});
          throw createRpcCallError({ error: 'Socket did not dispatch RPC', errorCode: RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE });
        }
        issued = true;
        return raceSocketIoAckTimeout(result as Promise<T>, timeout, params.waitForResultOnCancel ? undefined : params.signal);
      },
    });
  } catch (error) {
    // Socket.IO 4.8 clears issued ACKs with this untyped error on disconnect.
    // Preserve uncertainty in the public code as well as the local disposition:
    // callers that serialize the failure must not lose the recovery contract.
    const failure = issued && error instanceof Error && error.message === 'socket has been disconnected'
      ? new SocketRpcDisconnectedError(error)
      : error;
    throw markRpcRequestDisposition(failure, issued ? 'outcomeUnknown' : 'notSent');
  }
}
export async function callSocketRpc<R>(params: Readonly<{
  socket: SocketRpcSocket; target: Readonly<{ kind: 'session' | 'machine'; id: string }>;
  method: string; params: unknown; content: SocketRpcContent;
  authorization?: SocketRpcAuthorizationContext; timeoutMs?: number | null;
  answeringClient?: SocketRpcAnsweringClientV1;
  transferRouting?: SessionTransferRoutingV1;
  workspaceSyncSourceRouting?: WorkspaceSyncSourceRoutingV1;
  workspaceSyncTargetRouting?: WorkspaceSyncTargetRoutingV1;
  workspaceSyncSourceWriterTargetRouting?: WorkspaceSyncSourceWriterTargetRoutingV1;
  workspaceSyncSourceExecution?: WorkspaceSyncSourceExecutionV1;
  workspaceSyncSeedRouting?: WorkspaceSyncSeedRoutingV1;
  originalActionEnvelope?: ExternalActionRequestEnvelope;
  signal?: AbortSignal; onIssued?: () => void; requestId?: string;
  /** Send cooperative cancellation while retaining this call's result custody. */
  waitForResultOnCancel?: boolean;
  /** Records the transport reply before asynchronous result admission/decoding. */
  onResponse?: (response: unknown) => void;
  randomBytes?: (length: number) => Uint8Array;
  transportResponseEnvelopeVersion?: SocketRpcRequestPayload['transportResponseEnvelopeVersion'];
  createExternalActionExecution?: (request: Readonly<{ method: string; requestId: string; params: unknown }>) => SocketRpcRequestPayload['externalActionExecution'];
}>): Promise<R> {
  let acknowledged = false;
  try {
    if (params.signal?.aborted) throw createSocketRpcAbortError();
    const timeoutMs = SocketRpcTimeoutMsSchema.parse(params.timeoutMs);
    const answeringClient = params.answeringClient === undefined ? undefined
      : SocketRpcAnsweringClientV1Schema.parse(params.answeringClient);
    if (answeringClient && params.target.kind !== 'machine') throw new Error('Answering-client routing requires a Machine continuation');
    const sessionActionAuthorization = params.authorization?.kind === SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_ACTION
      ? SocketRpcSessionActionAuthorizationContextSchema.parse(params.authorization) : undefined;
    if (sessionActionAuthorization && (params.target.kind !== 'session'
      || sessionActionAuthorization.sessionId !== params.target.id || !isSessionActionRpcMethodV1(params.method))) {
      throw new Error('Session Action authorization does not match the RPC target');
    }
    const transferRouting = params.transferRouting === undefined ? undefined : SessionTransferRoutingV1Schema.parse(params.transferRouting);
    const workspaceSyncSourceRouting = params.workspaceSyncSourceRouting === undefined
      ? undefined : WorkspaceSyncSourceRoutingV1Schema.parse(params.workspaceSyncSourceRouting);
    const workspaceSyncTargetRouting = params.workspaceSyncTargetRouting === undefined
      ? undefined : WorkspaceSyncTargetRoutingV1Schema.parse(params.workspaceSyncTargetRouting);
    const workspaceSyncSourceWriterTargetRouting = params.workspaceSyncSourceWriterTargetRouting === undefined
      ? undefined : WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse(params.workspaceSyncSourceWriterTargetRouting);
    const originalActionEnvelope = params.originalActionEnvelope === undefined
      ? undefined : ExternalActionRequestEnvelopeSchema.parse(params.originalActionEnvelope);
    const workspaceSyncSourceExecution = params.workspaceSyncSourceExecution === undefined
      ? undefined : WorkspaceSyncSourceExecutionV1Schema.parse(params.workspaceSyncSourceExecution);
    const workspaceSyncSeedRouting = params.workspaceSyncSeedRouting === undefined
      ? undefined : WorkspaceSyncSeedRoutingV1Schema.parse(params.workspaceSyncSeedRouting);
    if (workspaceSyncSeedRouting && (params.target.kind !== 'machine' || params.method !== RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE
      || !params.createExternalActionExecution || !workspaceSyncSourceExecution || workspaceSyncSourceRouting
      || workspaceSyncTargetRouting || workspaceSyncSourceWriterTargetRouting || originalActionEnvelope || transferRouting)) {
      throw new Error('Seed routing does not match its installed Project export carrier');
    }
    if (originalActionEnvelope && (params.target.kind !== 'machine'
      || params.method !== RPC_METHODS.PROJECTS_OPEN && !readProjectServiceMoveChildEffectV1(params.method)
      || !params.createExternalActionExecution)) throw new Error('Original Project envelope does not match its signed carrier');
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
    if (originalActionEnvelope && params.method !== RPC_METHODS.PROJECTS_OPEN
      && (externalActionExecution?.authorization.binding.actionId !== 'projects.service.relocate'
        || externalActionExecution.effectActionId !== readProjectServiceMoveChildEffectV1(params.method))) {
      throw new Error('Original Project envelope does not match its signed carrier');
    }
    const payload: SocketRpcRequestPayload = {
      method: answeringClient ? `${params.target.id}:${ANSWERING_CLIENT_RPC_PREFIX_V1}${params.method}` : method,
      params: encoded,
      ...(answeringClient ? { answeringClient } : {}),
      ...(transferRouting ? { transferRouting } : {}),
      ...(workspaceSyncSourceRouting ? { workspaceSyncSourceRouting } : {}),
      ...(workspaceSyncTargetRouting ? { workspaceSyncTargetRouting } : {}),
      ...(workspaceSyncSourceWriterTargetRouting ? { workspaceSyncSourceWriterTargetRouting } : {}),
      ...(workspaceSyncSourceExecution ? { workspaceSyncSourceExecution } : {}),
      ...(workspaceSyncSeedRouting ? { workspaceSyncSeedRouting } : {}),
      ...(originalActionEnvelope ? { originalActionEnvelope } : {}),
      // requestId also opts into cancellation custody. Ordinary calls need an
      // observational identity without changing their disconnect semantics.
      ...(requestId ? { requestId } : { traceId: createSocketRpcRequestId() }),
      ...(params.waitForResultOnCancel ? { waitForResultOnCancel: true } : {}),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(authorization ? { authorization } : {}),
      ...(externalActionExecution ? { externalActionExecution } : {}),
      ...(params.transportResponseEnvelopeVersion === undefined ? {} : { transportResponseEnvelopeVersion: params.transportResponseEnvelopeVersion }),
    };
    const ack = await emitWithAckCancellable({ ...params, event: SOCKET_RPC_EVENTS.CALL, payload, requestId });
    acknowledged = true;
    params.onResponse?.(ack);
    const result = await socketRpcCodec.decodeResult(params.content, ack, callId);
    // Pending-call cancellation is settled by the ACK owner. A valid decoded
    // acknowledgement remains authoritative even if cancellation arrives later.
    return result as R;
  } catch (error) {
    // A local socket loss interrupts a declared read, not a potentially applied
    // mutation. Preserve issued disposition; unavailable never means notSent.
    // A relay's uncertain ACK or a post-ACK decoding error is not this fact.
    if (!acknowledged && error instanceof SocketRpcDisconnectedError && isReadOnlyMachineRpcMethod(params.method)) {
      throw markRpcRequestDisposition(Object.assign(createRpcCallError({
        error: 'Socket disconnected before the read completed', errorCode: RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE,
      }), { cause: error }), 'outcomeUnknown');
    }
    throw readRpcRequestDisposition(error) === null ? markRpcRequestDisposition(error, acknowledged ? 'outcomeUnknown' : 'notSent') : error;
  }
}
