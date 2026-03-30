import type { RpcErrorCode } from './rpc.js';
import { RPC_ERROR_CODES } from './rpc.js';

export type RpcErrorCarrier = {
  rpcErrorCode?: RpcErrorCode | string;
  message?: string;
};

export class RpcError extends Error {
  readonly rpcErrorCode: RpcErrorCode | string;

  constructor(message: string, rpcErrorCode: RpcErrorCode | string) {
    super(message);
    this.name = 'RpcError';
    this.rpcErrorCode = rpcErrorCode;
  }
}

export function isRpcError(error: unknown): error is RpcError {
  if (!error || typeof error !== 'object') return false;
  if (error instanceof RpcError) return true;
  if (!(error instanceof Error)) return false;

  const carrier = error as { name?: unknown; rpcErrorCode?: unknown };
  return carrier.name === 'RpcError' && typeof carrier.rpcErrorCode === 'string' && carrier.rpcErrorCode.trim().length > 0;
}

export function createRpcCallError(opts: { error: string; errorCode?: string | null | undefined }): Error {
  if (typeof opts.errorCode === 'string' && opts.errorCode.length > 0) {
    return new RpcError(opts.error, opts.errorCode);
  }
  return new Error(opts.error);
}

export function readRpcErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const carrier = error as { rpcErrorCode?: unknown };
  return typeof carrier.rpcErrorCode === 'string' ? carrier.rpcErrorCode : undefined;
}

export function isRpcMethodNotAvailableError(error: unknown): boolean {
  const code = readRpcErrorCode(error);
  return code === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE;
}

export function isRpcMethodNotFoundError(error: unknown): boolean {
  const code = readRpcErrorCode(error);
  return code === RPC_ERROR_CODES.METHOD_NOT_FOUND;
}
