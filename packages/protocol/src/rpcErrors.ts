import type { RpcErrorCode } from './rpc.js';
import { RPC_ERROR_CODES } from './rpc.js';
import type { SocketRpcTargetFailureV1 } from './socketRpc.js';

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

export const PUBLIC_RPC_HANDLER_ERROR_CODES = {
  STRUCTURED_QUESTION_INVALID: 'STRUCTURED_QUESTION_INVALID',
  STRUCTURED_QUESTION_LEGACY_INVALID: 'STRUCTURED_QUESTION_LEGACY_INVALID',
  STRUCTURED_QUESTION_LEGACY_AMBIGUOUS: 'STRUCTURED_QUESTION_LEGACY_AMBIGUOUS',
  STRUCTURED_QUESTION_RECEIVER_NOT_OWNER: 'STRUCTURED_QUESTION_RECEIVER_NOT_OWNER',
} as const;

export type PublicRpcHandlerErrorCode =
  (typeof PUBLIC_RPC_HANDLER_ERROR_CODES)[keyof typeof PUBLIC_RPC_HANDLER_ERROR_CODES];

const PUBLIC_RPC_HANDLER_ERROR_GUIDANCE =
  'This answer could not be handled safely. Update or reconnect Happier, then try again.';

const PUBLIC_RPC_HANDLER_ERROR_CODE_SET = new Set<string>(Object.values(PUBLIC_RPC_HANDLER_ERROR_CODES));

export class PublicRpcHandlerError extends RpcError {
  readonly publicErrorCode: PublicRpcHandlerErrorCode;

  constructor(publicErrorCode: PublicRpcHandlerErrorCode, privateMessage = PUBLIC_RPC_HANDLER_ERROR_GUIDANCE) {
    super(privateMessage, publicErrorCode);
    this.name = 'PublicRpcHandlerError';
    this.publicErrorCode = publicErrorCode;
  }
}

export function isPublicRpcHandlerError(error: unknown): error is PublicRpcHandlerError {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { name?: unknown; publicErrorCode?: unknown };
  return candidate.name === 'PublicRpcHandlerError'
    && typeof candidate.publicErrorCode === 'string'
    && PUBLIC_RPC_HANDLER_ERROR_CODE_SET.has(candidate.publicErrorCode);
}

export function toSocketRpcTargetFailureV1(error: PublicRpcHandlerError): SocketRpcTargetFailureV1 {
  return Object.freeze({
    type: 'socket-rpc-target-failure-v1',
    errorCode: error.publicErrorCode,
    error: PUBLIC_RPC_HANDLER_ERROR_GUIDANCE,
  });
}

export function isSocketRpcTargetFailureV1(value: unknown): value is SocketRpcTargetFailureV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return Object.keys(candidate).length === 3
    && candidate.type === 'socket-rpc-target-failure-v1'
    && typeof candidate.errorCode === 'string'
    && PUBLIC_RPC_HANDLER_ERROR_CODE_SET.has(candidate.errorCode)
    && candidate.error === PUBLIC_RPC_HANDLER_ERROR_GUIDANCE;
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
