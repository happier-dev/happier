export const RPC_ERROR_CODES = {
  UPDATE_REQUIRED: 'RPC_UPDATE_REQUIRED',
  METHOD_NOT_AVAILABLE: 'RPC_METHOD_NOT_AVAILABLE',
  METHOD_NOT_FOUND: 'RPC_METHOD_NOT_FOUND',
  FORBIDDEN: 'RPC_FORBIDDEN',
  SESSION_MACHINE_CONTROL_UNAVAILABLE: 'RPC_SESSION_MACHINE_CONTROL_UNAVAILABLE',
  /**
   * The Session is reachable but the caller's Team policy is not satisfied by
   * the credential it presented. It is the socket-RPC spelling of the HTTP
   * Session routes' `team_authentication_required` (403), and it exists because
   * collapsing it into `FORBIDDEN` or `METHOD_NOT_AVAILABLE` hides the one
   * recovery the caller can perform: go and authenticate for that Team.
   */
  TEAM_AUTHENTICATION_REQUIRED: 'RPC_TEAM_AUTHENTICATION_REQUIRED',
  /** Nothing the caller could present satisfies the policy right now (HTTP 503). */
  TEAM_AUTHENTICATION_UNAVAILABLE: 'RPC_TEAM_AUTHENTICATION_UNAVAILABLE',
} as const;

export type RpcErrorCode = (typeof RPC_ERROR_CODES)[keyof typeof RPC_ERROR_CODES];

export const RPC_ERROR_MESSAGES = {
  METHOD_NOT_AVAILABLE: 'RPC method not available',
  METHOD_NOT_FOUND: 'Method not found',
  FORBIDDEN: 'Forbidden',
  SESSION_MACHINE_CONTROL_UNAVAILABLE: 'Session machine control unavailable',
  TEAM_AUTHENTICATION_REQUIRED: 'Team authentication required',
  TEAM_AUTHENTICATION_UNAVAILABLE: 'Team authentication unavailable',
} as const;

export function isRpcMethodNotFoundResult(value: unknown): value is { error: string; errorCode?: string } {
  if (!value || typeof value !== 'object') return false;
  const maybe = value as { error?: unknown; errorCode?: unknown };
  if (maybe.errorCode === RPC_ERROR_CODES.METHOD_NOT_FOUND) return true;
  return maybe.error === RPC_ERROR_MESSAGES.METHOD_NOT_FOUND;
}

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

export function isRpcSessionMachineControlUnavailableError(error: unknown): boolean {
  return readRpcErrorCode(error) === RPC_ERROR_CODES.SESSION_MACHINE_CONTROL_UNAVAILABLE;
}
