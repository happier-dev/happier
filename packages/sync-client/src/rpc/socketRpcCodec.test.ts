import { isPluginError } from '@happier-dev/protocol/plugins/errors';
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

it.each(['plain', 'e2ee'] as const)('retains Home availability details from a refused socket call in %s mode', async mode => {
  const details = { reason: 'machine_offline', requiredFact: 'machine_online', remedy: 'reconnect_machine' };
  const content: SocketRpcContent = mode === 'plain' ? { mode } : { mode, cipher: {
    encryptRaw: async () => 'ciphertext', decryptRaw: async () => { throw new Error('Refusal must not be opened'); },
  } };
  // Home's negative ACK is the transport boundary; request disposition stays with the real call owner.
  const socket = { emit() {}, timeout: () => ({ emitWithAck: async () => ({ ok: false,
    error: 'Target unavailable', errorCode: 'target_unavailable', details }) }) };
  await expect(callSocketRpc({ socket, target: { kind: 'machine', id: 'guest' }, method: 'actionOperation.list.v2',
    params: {}, content, timeoutMs: 30_000 })).rejects.toMatchObject({ rpcErrorCode: 'target_unavailable', details });
});

it.each([
  { errorCode: 'target_unavailable', details: undefined },
  { errorCode: 'target_unavailable', details: { reason: 'machine_offline', requiredFact: 'machine_online',
    remedy: 'reconnect_machine', privateField: 'PRIVATE_DETAILS' } },
  { errorCode: RPC_ERROR_CODES.FORBIDDEN, details: { reason: 'machine_offline', requiredFact: 'machine_online', remedy: 'reconnect_machine' } },
])('does not invent or disclose invalid availability facts for $errorCode', async ({ errorCode, details }) => {
  const socket = { emit() {}, timeout: () => ({ emitWithAck: async () => ({ ok: false,
    error: 'Target refused', errorCode, details }) }) };
  let failure: unknown;
  try {
    await callSocketRpc({ socket, target: { kind: 'machine', id: 'guest' }, method: 'actionOperation.list.v2',
      params: {}, content: { mode: 'plain' }, timeoutMs: 30_000 });
  } catch (error) { failure = error; }
  expect(failure).toMatchObject({ rpcErrorCode: errorCode });
  expect(failure).not.toHaveProperty('details');
  expect(JSON.stringify(failure)).not.toContain('PRIVATE_DETAILS');
});

it('retains Home availability details on an E2EE pre-open refusal', async () => {
  const details = { reason: 'machine_replaced', requiredFact: 'current_machine', remedy: 'select_current_machine' };
  const socket = { emit() {}, timeout: () => ({ emitWithAck: async () => ({ ok: true,
    result: { error: 'Target unavailable', errorCode: 'target_unavailable', details } }) }) };
  await expect(callSocketRpc({ socket, target: { kind: 'machine', id: 'guest' }, method: 'actionOperation.list.v2',
    params: {}, content: { mode: 'e2ee', cipher: { encryptRaw: async () => 'ciphertext',
      decryptRaw: async () => { throw new Error('Refusal must not be opened'); } } }, timeoutMs: 30_000 }))
    .rejects.toMatchObject({ rpcErrorCode: 'target_unavailable', details });
});

it('retains canonical error identity while dropping malformed diagnostic metadata', async () => {
  const data = { name: 'PluginError', code: 'author_failure', message: 'An authored failure', retryable: true,
    failureCause: { privateField: 'PRIVATE_DIAGNOSTIC' }, details: { privateField: 'PRIVATE_DETAILS' } };
  const failure = await socketRpcCodec.decodeResult({ mode: 'plain' }, { ok: true, result: data }, 'a'.repeat(32))
    .catch((error: unknown) => error);
  expect(isPluginError(failure)).toBe(true);
  expect(failure).toMatchObject({ code: data.code, message: data.message });
  expect(failure).not.toHaveProperty('failureCause');
  expect(JSON.stringify(failure)).not.toContain('PRIVATE_DIAGNOSTIC');
  expect(JSON.stringify(failure)).not.toContain('PRIVATE_DETAILS');
  expect(isPluginError(data)).toBe(false);
});
