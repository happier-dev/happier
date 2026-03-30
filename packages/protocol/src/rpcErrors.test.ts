import { describe, expect, it } from 'vitest';

import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from './rpc.js';
import {
  createRpcCallError,
  isRpcError,
  isRpcMethodNotAvailableError,
  isRpcMethodNotFoundError,
  RpcError,
  readRpcErrorCode,
} from './rpcErrors.js';

describe('rpcErrors', () => {
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
