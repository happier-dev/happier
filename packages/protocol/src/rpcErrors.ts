import type { RpcErrorCode } from './rpc.js';
import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from './rpc.js';

export type RpcErrorCarrier = {
  rpcErrorCode?: RpcErrorCode | string;
  message?: string;
};

export function createRpcCallError(opts: { error: string; errorCode?: string | null | undefined }): Error {
  const err = new Error(opts.error);
  if (typeof opts.errorCode === 'string' && opts.errorCode.length > 0) {
    (err as Error & { rpcErrorCode?: string }).rpcErrorCode = opts.errorCode;
  }
  return err;
}

export function readRpcErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const carrier = error as { rpcErrorCode?: unknown };
  return typeof carrier.rpcErrorCode === 'string' ? carrier.rpcErrorCode : undefined;
}

export function isRpcMethodNotAvailableError(error: RpcErrorCarrier): boolean {
  if (readRpcErrorCode(error) === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE) {
    return true;
  }
  const msg = typeof error.message === 'string' ? error.message.trim().toLowerCase() : '';
  return msg === RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE.trim().toLowerCase();
}

export function isRpcMethodNotFoundError(error: RpcErrorCarrier): boolean {
  if (readRpcErrorCode(error) === RPC_ERROR_CODES.METHOD_NOT_FOUND) {
    return true;
  }
  const msg = typeof error.message === 'string' ? error.message.trim().toLowerCase() : '';
  return (
    msg === RPC_ERROR_MESSAGES.METHOD_NOT_FOUND.trim().toLowerCase()
    || msg === 'rpc method not found'
  );
}

