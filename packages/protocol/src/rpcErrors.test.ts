import { describe, expect, it } from 'vitest';

import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from './rpc.js';
import {
  createRpcCallError,
  createSocketIoAckTimeoutError,
  isSocketIoAckTimeoutError,
  isRpcError,
  isRpcMethodNotAvailableError,
  isRpcMethodNotFoundError,
  isRpcSessionMachineControlUnavailableError,
  interpretRpcResult,
  PUBLIC_RPC_HANDLER_ERROR_CODES,
  PublicRpcHandlerError,
  RpcError,
  readRpcErrorCode,
  toSocketRpcTargetFailureV1,
} from './rpcErrors.js';

describe('rpcErrors', () => {
  it('interprets the exact safe target failure as a typed RPC error', () => {
    const errorCode = PUBLIC_RPC_HANDLER_ERROR_CODES.STRUCTURED_QUESTION_SUBMISSION_UNCONFIRMED;
    const failure = toSocketRpcTargetFailureV1(new PublicRpcHandlerError(errorCode));

    expect(() => interpretRpcResult(failure)).toThrow(expect.objectContaining({
      name: 'RpcError', rpcErrorCode: errorCode, message: failure.error,
    }));
  });

  it('preserves business results and values outside the safe target failure contract', () => {
    const failure = toSocketRpcTargetFailureV1(new PublicRpcHandlerError(PUBLIC_RPC_HANDLER_ERROR_CODES.STRUCTURED_QUESTION_INVALID));
    for (const result of [
      null, undefined, false, 0, 'value',
      { ok: false, error: 'business failure' },
      { error: failure.error, errorCode: failure.errorCode },
      { ...failure, errorCode: 'unknown_code' },
      { ...failure, error: 'other message' },
      { ...failure, extra: true },
    ]) {
      expect(interpretRpcResult(result)).toBe(result);
    }
  });

  it('recognizes Socket.IO ACK timeouts without classifying other transport failures', () => {
    expect(isSocketIoAckTimeoutError(new Error('operation has timed out'))).toBe(true);
    expect(isSocketIoAckTimeoutError(createSocketIoAckTimeoutError())).toBe(true);
    expect(isSocketIoAckTimeoutError(new Error('socket disconnected'))).toBe(false);
    expect(isSocketIoAckTimeoutError({ message: 'operation has timed out' })).toBe(false);
    expect(isSocketIoAckTimeoutError('operation has timed out')).toBe(false);
    expect(isSocketIoAckTimeoutError(null)).toBe(false);
  });

  it('creates an Error with rpcErrorCode when provided', () => {
    const err = createRpcCallError({
      error: RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE,
      errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
    });

    expect(err).toBeInstanceOf(RpcError);
    expect(err.message).toBe(RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE);
    expect((err as any).rpcErrorCode).toBe(RPC_ERROR_CODES.METHOD_NOT_AVAILABLE);
  });

  it('creates an Error without rpcErrorCode when missing', () => {
    const err = createRpcCallError({ error: 'boom' });
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(RpcError);
    expect((err as any).rpcErrorCode).toBeUndefined();
  });

  it('detects method-not-available errors from rpcErrorCode', () => {
    expect(isRpcMethodNotAvailableError({ rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE })).toBe(true);
  });

  it('does not detect method-not-available errors from message alone', () => {
    expect(isRpcMethodNotAvailableError({ message: RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE })).toBe(false);
    expect(isRpcMethodNotAvailableError({ message: `${RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE}: daemon.bulkTransfer.download.init` })).toBe(false);
    expect(isRpcMethodNotAvailableError({ message: 'rpc METHOD NOT available ' })).toBe(false);
  });

  it('detects method-not-found errors from rpcErrorCode', () => {
    expect(isRpcMethodNotFoundError({ rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND })).toBe(true);
  });

  it('does not detect method-not-found errors from message alone', () => {
    expect(isRpcMethodNotFoundError({ message: RPC_ERROR_MESSAGES.METHOD_NOT_FOUND })).toBe(false);
    expect(isRpcMethodNotFoundError({ message: `${RPC_ERROR_MESSAGES.METHOD_NOT_FOUND}: daemon.bulkTransfer.download.init` })).toBe(false);
    expect(isRpcMethodNotFoundError({ message: 'rpc method not found ' })).toBe(false);
  });

  it('detects unavailable session machine control only from its typed error code', () => {
    expect(isRpcSessionMachineControlUnavailableError({
      rpcErrorCode: RPC_ERROR_CODES.SESSION_MACHINE_CONTROL_UNAVAILABLE,
    })).toBe(true);
    expect(isRpcSessionMachineControlUnavailableError({
      message: RPC_ERROR_MESSAGES.SESSION_MACHINE_CONTROL_UNAVAILABLE,
    })).toBe(false);
  });

  it('detects RpcError instances', () => {
    expect(isRpcError(new RpcError('x', RPC_ERROR_CODES.METHOD_NOT_FOUND))).toBe(true);
    expect(isRpcError(new Error('x'))).toBe(false);
    expect(isRpcError({ rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND, message: 'x' })).toBe(false);
  });

  it('reads rpcErrorCode when available', () => {
    expect(readRpcErrorCode(new RpcError('nope', RPC_ERROR_CODES.METHOD_NOT_FOUND))).toBe(RPC_ERROR_CODES.METHOD_NOT_FOUND);
    expect(readRpcErrorCode({ rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND })).toBe(RPC_ERROR_CODES.METHOD_NOT_FOUND);
    expect(readRpcErrorCode(new Error('x'))).toBeUndefined();
  });
});
