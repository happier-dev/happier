import { createRpcCallError } from '@happier-dev/protocol/rpcErrors';
import { isMachineRpcTimeoutError, RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { markRpcRequestDisposition } from './rpcDisposition.js';

export type SocketRpcContent =
  | Readonly<{ mode: 'plain' }>
  | Readonly<{ mode: 'e2ee'; cipher: Readonly<{
      encryptRaw(value: unknown): Promise<string>;
      decryptRaw(ciphertext: string): Promise<unknown | null>;
    }> }>;

export type SocketRpcRequestBinding = Readonly<{ method: string; callId: string }>;
export type DecodedSocketRpcRequest = Readonly<{ params: unknown; callId: string | null }>;

function acknowledgementError(error: string, errorCode?: string, failureCause?: unknown) {
  const failure = createRpcCallError({ error, errorCode, failureCause });
  // Reserved refusal codes in an actual error acknowledgement prove the call
  // did not reach handler execution. Local response-decoding errors do not.
  const refusedBeforeExecution = errorCode !== RPC_ERROR_CODES.OUTCOME_UNKNOWN
    && Object.values(RPC_ERROR_CODES).some(code => code === errorCode);
  return refusedBeforeExecution ? markRpcRequestDisposition(failure, 'notSent') : failure;
}
function updateRequired(): Error {
  return createRpcCallError({ error: 'Encrypted RPC binding is unavailable or invalid; update all Happier components', errorCode: RPC_ERROR_CODES.UPDATE_REQUIRED });
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function isCallId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
}
async function open(content: Extract<SocketRpcContent, { mode: 'e2ee' }>, value: unknown): Promise<Record<string, unknown>> {
  if (typeof value !== 'string') throw updateRequired();
  let opened: unknown;
  try { opened = await content.cipher.decryptRaw(value); } catch (error) {
    // The cipher adapter may also enforce the caller's lifetime. Its timeout or
    // cancellation says nothing about the authenticity/version of the ciphertext.
    if (isMachineRpcTimeoutError(error) || error instanceof Error && error.name === 'AbortError') throw error;
    throw updateRequired();
  }
  if (!isRecord(opened) || opened.v !== 2 || !isCallId(opened.c)) throw updateRequired();
  return opened;
}
async function encodeParams(content: SocketRpcContent, value: unknown, binding: SocketRpcRequestBinding): Promise<unknown> {
  if (content.mode === 'plain') return value;
  if (!isCallId(binding.callId)) throw updateRequired();
  return content.cipher.encryptRaw({ v: 2, k: 'req', m: binding.method, c: binding.callId, p: value });
}
async function decodeRequestParams(content: SocketRpcContent, value: unknown, method: string): Promise<DecodedSocketRpcRequest> {
  if (content.mode === 'plain') return { params: value, callId: null };
  const opened = await open(content, value);
  if (opened.k !== 'req' || opened.m !== method || Object.keys(opened).some(key => !['v', 'k', 'm', 'c', 'p'].includes(key))) throw updateRequired();
  return { params: opened.p, callId: opened.c as string };
}
async function encodeResponse(content: SocketRpcContent, value: unknown, callId: string | null): Promise<unknown> {
  if (content.mode === 'plain') return value;
  // Before a request can be authenticated, only a typed refusal can be returned.
  // The relay can already refuse delivery; this carrier never establishes success.
  if (callId === null && isRecord(value) && typeof value.error === 'string' && typeof value.errorCode === 'string') return value;
  if (!isCallId(callId)) throw updateRequired();
  return content.cipher.encryptRaw({ v: 2, k: 'res', c: callId, r: value });
}
async function decodeResult(content: SocketRpcContent, acknowledgement: unknown, callId: string): Promise<unknown> {
  if (!acknowledgement || typeof acknowledgement !== 'object') throw createRpcCallError({ error: 'Invalid RPC acknowledgement' });
  const ack = acknowledgement as { ok?: unknown; result?: unknown; error?: unknown; errorCode?: unknown; failureCause?: unknown };
  if (ack.ok === true) {
    if (content.mode === 'plain') return ack.result;
    if (isRecord(ack.result) && typeof ack.result.error === 'string' && typeof ack.result.errorCode === 'string') {
      throw acknowledgementError(ack.result.error, ack.result.errorCode, ack.result.failureCause);
    }
    const opened = await open(content, ack.result);
    if (opened.k !== 'res' || opened.c !== callId || Object.keys(opened).some(key => !['v', 'k', 'c', 'r'].includes(key))) throw updateRequired();
    return opened.r;
  }
  throw acknowledgementError(
    typeof ack.error === 'string' ? ack.error : 'RPC call failed',
    typeof ack.errorCode === 'string' ? ack.errorCode : undefined,
    ack.failureCause,
  );
}
/** Responders encode their raw result; the relay owns the outer acknowledgement. */
export const socketRpcCodec = Object.freeze({ encodeParams, decodeResult, decodeRequestParams, encodeResponse });
