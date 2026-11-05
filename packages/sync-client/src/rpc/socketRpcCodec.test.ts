import { expect, it } from 'vitest';
import { MACHINE_RPC_TIMEOUT_ERROR_CODE, RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { socketRpcCodec, type SocketRpcContent } from './socketRpcCodec.js';
import { callSocketRpc } from './callSocketRpc.js';
import { readRpcRequestDisposition } from './rpcDisposition.js';

it.each([
  Object.assign(new Error('Machine RPC timed out'), { code: MACHINE_RPC_TIMEOUT_ERROR_CODE }),
  Object.assign(new Error('Caller cancelled'), { name: 'AbortError' }),
])('preserves a reply-opening lifecycle failure instead of claiming incompatible encryption: $message', async failure => {
  const content: SocketRpcContent = { mode: 'e2ee', cipher: {
    encryptRaw: async () => 'unused',
    decryptRaw: async () => { throw failure; },
  } };
  let acknowledged = false;
  // Socket delivery and the cipher are boundaries; real request/reply admission
  // must preserve the received ACK's uncertain outcome when opening times out.
  const socket = { emit() {}, timeout: () => ({ emitWithAck: async () => ({ ok: true, result: 'ciphertext' }) }) };
  await expect(callSocketRpc({ socket, target: { kind: 'machine', id: 'guest' }, method: 'actionOperation.list.v2',
    params: {}, content, onResponse: () => { acknowledged = true; }, timeoutMs: 30_000 })).rejects.toBe(failure);
  expect(acknowledged).toBe(true);
  expect(readRpcRequestDisposition(failure)).toBe('outcomeUnknown');
});

it('still refuses corrupt content and wrong reply correlation', async () => {
  for (const opened of [null, { v: 2, k: 'res', c: 'b'.repeat(32), r: {} }]) {
    const content: SocketRpcContent = { mode: 'e2ee', cipher: {
      encryptRaw: async () => 'unused', decryptRaw: async () => opened,
    } };
    await expect(socketRpcCodec.decodeResult(content, { ok: true, result: 'ciphertext' }, 'a'.repeat(32)))
      .rejects.toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.UPDATE_REQUIRED });
  }
});

it.each(['plain', 'e2ee'] as const)('retains the relay failure diagnostic without changing uncertain settlement in %s mode', async mode => {
  const failureCause = { phase: 'rpc.relay', errorClass: 'TypeError', errorCode: 'ECONNRESET', httpStatus: null };
  const content: SocketRpcContent = mode === 'plain' ? { mode } : { mode, cipher: {
    encryptRaw: async () => 'ciphertext', decryptRaw: async () => { throw new Error('Refusal must not be opened'); },
  } };
  // The transport supplies a real negative ACK; the codec and call owner stay real.
  const socket = { emit() {}, timeout: () => ({ emitWithAck: async () => ({ ok: false,
    error: 'Relay request failed', errorCode: RPC_ERROR_CODES.OUTCOME_UNKNOWN, failureCause }) }) };
  let failure: unknown;
  try {
    await callSocketRpc({ socket, target: { kind: 'machine', id: 'guest' }, method: 'actionOperation.list.v2',
      params: {}, content, timeoutMs: 30_000 });
  } catch (error) { failure = error; }
  expect(failure).toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.OUTCOME_UNKNOWN, failureCause });
  expect(readRpcRequestDisposition(failure)).toBe('outcomeUnknown');
});
