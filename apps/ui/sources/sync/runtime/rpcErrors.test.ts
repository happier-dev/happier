import { describe, it, expect } from 'vitest';
import { createRpcCallError, isRpcMethodNotAvailableError, isRpcMethodNotFoundError, RpcError } from './rpcErrors';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';

describe('rpcErrors', () => {
  it('creates an Error with rpcErrorCode when provided', () => {
    const err = createRpcCallError({ error: 'RPC method not available', errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE });
    expect(err).toBeInstanceOf(RpcError);
    expect(err.message).toBe('RPC method not available');
    expect((err as any).rpcErrorCode).toBe('RPC_METHOD_NOT_AVAILABLE');
  });

  it('creates an Error without rpcErrorCode when missing', () => {
    const err = createRpcCallError({ error: 'boom' });
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(RpcError);
    expect(err.message).toBe('boom');
    expect((err as any).rpcErrorCode).toBeUndefined();
  });

  it('detects RPC method unavailable by explicit errorCode', () => {
    expect(isRpcMethodNotAvailableError({ rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE, message: 'anything' })).toBe(true);
  });

  it('does not detect RPC method unavailable by legacy message', () => {
    expect(isRpcMethodNotAvailableError({ message: 'RPC method not available' })).toBe(false);
    expect(isRpcMethodNotAvailableError({ message: 'rpc METHOD NOT available ' })).toBe(false);
  });

  it('detects RPC method not found by explicit errorCode', () => {
    expect(isRpcMethodNotFoundError({ rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND, message: 'anything' })).toBe(true);
  });

  it('does not detect RPC method not found by legacy message', () => {
    expect(isRpcMethodNotFoundError({ message: 'Method not found' })).toBe(false);
    expect(isRpcMethodNotFoundError({ message: 'rpc method not found ' })).toBe(false);
  });
});
