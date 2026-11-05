import { ActionFailureCauseV1Schema, type ActionFailureCauseV1 } from '../actions/actionExecutionResult.js';

export const MACHINE_RPC_TIMEOUT_ERROR_CODE = 'MACHINE_RPC_TIMEOUT';

/** Socket.IO's native ACK deadline and the portable ACK race share this error. */
export function createSocketIoAckTimeoutError(): Error { return new Error('operation has timed out'); }
export function isSocketIoAckTimeoutError(error: unknown): error is Error {
  return error instanceof Error && error.message === 'operation has timed out';
}

/** Content-free progress of the scoped socket's existing connection deadline. */
export const SCOPED_RPC_SOCKET_CONNECTION_PHASES = ['reachability-start', 'reachability-wait', 'socket-connect'] as const;
export type ScopedRpcSocketConnectionPhase = typeof SCOPED_RPC_SOCKET_CONNECTION_PHASES[number];

export function isMachineRpcTimeoutError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && (error as { code?: unknown }).code === MACHINE_RPC_TIMEOUT_ERROR_CODE,
  );
}

export const RPC_ERROR_CODES = {
  CLIENT_AMBIGUOUS: 'RPC_CLIENT_AMBIGUOUS',
  CLIENT_NOT_AVAILABLE: 'RPC_CLIENT_NOT_AVAILABLE',
  UPDATE_REQUIRED: 'RPC_UPDATE_REQUIRED',
  METHOD_NOT_AVAILABLE: 'RPC_METHOD_NOT_AVAILABLE',
  METHOD_NOT_FOUND: 'RPC_METHOD_NOT_FOUND',
  /** Transport unavailable: discovery may have failed before dispatch, or a local issued read lost its socket. Consult request disposition. */
  TRANSPORT_UNAVAILABLE: 'RPC_TRANSPORT_UNAVAILABLE',
  /** Dispatch occurred, but currentness was lost before a result could be admitted. */
  OUTCOME_UNKNOWN: 'RPC_OUTCOME_UNKNOWN',
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
  if (typeof maybe.errorCode === 'string') return maybe.errorCode === RPC_ERROR_CODES.METHOD_NOT_FOUND;
  return maybe.error === RPC_ERROR_MESSAGES.METHOD_NOT_FOUND;
}

export type RpcErrorCarrier = {
  rpcErrorCode?: RpcErrorCode | string;
  message?: string;
};

export class RpcError extends Error {
  readonly rpcErrorCode: RpcErrorCode | string;
  readonly failureCause?: ActionFailureCauseV1;

  constructor(message: string, rpcErrorCode: RpcErrorCode | string, failureCause?: ActionFailureCauseV1) {
    super(message);
    this.name = 'RpcError';
    this.rpcErrorCode = rpcErrorCode;
    if (failureCause !== undefined) this.failureCause = failureCause;
  }
}

export function isRpcError(error: unknown): error is RpcError {
  if (!error || typeof error !== 'object') return false;
  if (error instanceof RpcError) return true;
  if (!(error instanceof Error)) return false;

  const carrier = error as { name?: unknown; rpcErrorCode?: unknown };
  return carrier.name === 'RpcError' && typeof carrier.rpcErrorCode === 'string' && carrier.rpcErrorCode.trim().length > 0;
}

export function createRpcCallError(opts: { error: string; errorCode?: string | null | undefined; failureCause?: unknown }): Error {
  const failureCause = ActionFailureCauseV1Schema.safeParse(opts.failureCause);
  if (typeof opts.errorCode === 'string' && opts.errorCode.length > 0) {
    return new RpcError(opts.error, opts.errorCode, failureCause.success ? failureCause.data : undefined);
  }
  return Object.assign(new Error(opts.error), failureCause.success ? { failureCause: failureCause.data } : {});
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
