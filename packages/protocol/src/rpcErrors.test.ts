import { describe, expect, it } from 'vitest';

import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from './rpc.js';
import {
  createRpcCallError,
  isRpcMethodNotAvailableError,
  isRpcMethodNotFoundError,
  readRpcErrorCode,
} from './rpcErrors.js';

describe('rpcErrors', () => {
  it('creates an Error with rpcErrorCode when provided', () => {
    const err = createRpcCallError({
      error: RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE,
      errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
    });

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe(RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE);
    expect((err as any).rpcErrorCode).toBe(RPC_ERROR_CODES.METHOD_NOT_AVAILABLE);
  });

  it('creates an Error without rpcErrorCode when missing', () => {
    const err = createRpcCallError({ error: 'boom' });
    expect((err as any).rpcErrorCode).toBeUndefined();
  });

  it('detects method-not-available errors from rpcErrorCode', () => {
    expect(isRpcMethodNotAvailableError({ rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE })).toBe(true);
  });

  it('detects method-not-available errors from message', () => {
    expect(isRpcMethodNotAvailableError({ message: RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE })).toBe(true);
    expect(isRpcMethodNotAvailableError({ message: 'rpc METHOD NOT available ' })).toBe(true);
  });

  it('detects method-not-found errors from rpcErrorCode', () => {
    expect(isRpcMethodNotFoundError({ rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND })).toBe(true);
  });

  it('detects method-not-found errors from message', () => {
    expect(isRpcMethodNotFoundError({ message: RPC_ERROR_MESSAGES.METHOD_NOT_FOUND })).toBe(true);
    expect(isRpcMethodNotFoundError({ message: 'rpc method not found ' })).toBe(true);
  });

  it('reads rpcErrorCode when available', () => {
    const err: any = new Error('nope');
    err.rpcErrorCode = RPC_ERROR_CODES.METHOD_NOT_FOUND;
    expect(readRpcErrorCode(err)).toBe(RPC_ERROR_CODES.METHOD_NOT_FOUND);
    expect(readRpcErrorCode(new Error('x'))).toBeUndefined();
  });
});

