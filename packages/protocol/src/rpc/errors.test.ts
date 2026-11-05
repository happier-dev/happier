import { describe, expect, it } from 'vitest';

import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from './index.js';
import {
  createRpcCallError,
  isRpcError,
  isRpcMethodNotAvailableError,
  isRpcMethodNotFoundError,
  isRpcMethodNotFoundResult,
  isRpcSessionMachineControlUnavailableError,
  RpcError,
  readRpcErrorCode,
} from './errors.js';

describe('rpcErrors', () => {
  it.each([RPC_ERROR_CODES.OUTCOME_UNKNOWN, undefined])('keeps typed diagnostics separate from native Error.cause (%s)', errorCode => {
    const failureCause = { phase: 'rpc.relay', errorClass: 'TypeError', errorCode: 'ECONNRESET', httpStatus: null };
    const error = createRpcCallError({ error: 'Relay failed', errorCode, failureCause });
    expect(error).toMatchObject({ failureCause });
    expect(error.cause).toBeUndefined();
  });

  it('allows a transport subclass to retain the underlying Error alongside the diagnostic carrier', () => {
    const failureCause = { phase: 'rpc.relay', errorClass: 'Error', errorCode: 'ECONNRESET', httpStatus: null } as const;
    class DisconnectedError extends RpcError {
      constructor(readonly cause: Error) {
        super(cause.message, RPC_ERROR_CODES.OUTCOME_UNKNOWN, failureCause);
      }
    }
    const native = new Error('Connection closed');
    const error = new DisconnectedError(native);
    expect(error.cause).toBe(native);
    expect(error).toMatchObject({ failureCause });
  });

  it('uses the typed missing-method result before the legacy message', () => {
    expect(isRpcMethodNotFoundResult({ errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE, error: RPC_ERROR_MESSAGES.METHOD_NOT_FOUND })).toBe(false);
    expect(isRpcMethodNotFoundResult({ errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND, error: 'Unavailable' })).toBe(true);
    expect(isRpcMethodNotFoundResult({ error: RPC_ERROR_MESSAGES.METHOD_NOT_FOUND })).toBe(true);
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
	    expect(isRpcMethodNotAvailableError({ message: `${RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE}: daemon.transfer.download.init` })).toBe(false);
	    expect(isRpcMethodNotAvailableError({ message: 'rpc METHOD NOT available ' })).toBe(false);
	  });

  it('detects method-not-found errors from rpcErrorCode', () => {
    expect(isRpcMethodNotFoundError({ rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND })).toBe(true);
  });

	  it('does not detect method-not-found errors from message alone', () => {
	    expect(isRpcMethodNotFoundError({ message: RPC_ERROR_MESSAGES.METHOD_NOT_FOUND })).toBe(false);
	    expect(isRpcMethodNotFoundError({ message: `${RPC_ERROR_MESSAGES.METHOD_NOT_FOUND}: daemon.transfer.download.init` })).toBe(false);
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
    expect(readRpcErrorCode({ rpcErrorCode: RPC_ERROR_CODES.FORBIDDEN, code: 'EACCES' })).toBe(RPC_ERROR_CODES.FORBIDDEN);
    expect(readRpcErrorCode(Object.assign(new Error('permission denied'), { code: 'EACCES' }))).toBeUndefined();
    expect(readRpcErrorCode(new Error('x'))).toBeUndefined();
  });
});
