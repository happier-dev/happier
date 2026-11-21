import { log } from '@/log';
import {
  serverFetch,
  ServerFetchConnectivityTimeoutError,
  ServerFetchReadTimeoutError,
  ServerFetchWriteTimeoutError,
  type ServerReadRequestInit,
} from '@/sync/http/client';
import { ServerReachabilityWaitTimeoutError } from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';
import { HappyError } from '@/utils/errors/errors';
import { AsyncTimeoutError } from '@/utils/timing/time';

export type ConnectedServiceNetworkFailureCategory = 'unreachable' | 'timeout';

/**
 * The request never produced an HTTP response. Whether the server saw it is unknown, so this
 * says nothing about the credentials or authorization code that were being sent.
 */
export class ConnectedServiceNetworkError extends HappyError {
  readonly operation: string;
  readonly endpoint: string;
  readonly category: ConnectedServiceNetworkFailureCategory;
  /** Read by the shared backoff: a cause that must not be retried stays non-retryable. */
  readonly retryable?: false;

  constructor(params: Readonly<{
    operation: string;
    endpoint: string;
    category: ConnectedServiceNetworkFailureCategory;
    cause: unknown;
  }>) {
    const code = params.category === 'timeout' ? 'connect_network_timeout' : 'connect_network_unreachable';
    const nonRetryable = (params.cause as { retryable?: unknown } | null)?.retryable === false;
    super(code, !nonRetryable, { kind: 'network', code });
    this.name = 'ConnectedServiceNetworkError';
    this.operation = params.operation;
    this.endpoint = params.endpoint;
    this.category = params.category;
    if (nonRetryable) this.retryable = false;
    this.cause = params.cause;
    Object.setPrototypeOf(this, ConnectedServiceNetworkError.prototype);
  }
}

// Runtime-specific text of the TypeError fetch rejects with when no response arrives.
const FETCH_REJECTION_MESSAGE = /failed to fetch|network request failed|load failed|fetch failed|networkerror when attempting to fetch/i;

/**
 * Returns what can reliably be said about a request that failed before any HTTP response:
 * a timeout, or a rejected fetch whose cause (offline, VPN down, DNS, refused, CORS) the
 * runtime does not reveal. Cancellation, superseded attempts and application errors are not
 * network failures.
 */
export function classifyConnectedServiceTransportFailure(error: unknown): ConnectedServiceNetworkFailureCategory | null {
  if (error instanceof ConnectedServiceNetworkError) return error.category;
  if (
    error instanceof ServerFetchWriteTimeoutError
    || error instanceof ServerFetchReadTimeoutError
    || error instanceof ServerFetchConnectivityTimeoutError
    || error instanceof ServerReachabilityWaitTimeoutError
    || error instanceof AsyncTimeoutError
  ) {
    return 'timeout';
  }
  if (!(error instanceof Error)) return null;
  if (error.name === 'TimeoutError') return 'timeout';
  if (error instanceof HappyError && error.kind === 'network') return 'unreachable';
  if (error instanceof TypeError && FETCH_REJECTION_MESSAGE.test(error.message)) return 'unreachable';
  return null;
}

/** Strips the query and fragment so codes, tokens and other parameters never reach a log or error. */
function toLoggableEndpoint(path: string): string {
  return path.split(/[?#]/, 1)[0] ?? '';
}

function describeCause(cause: unknown): string {
  if (!(cause instanceof Error)) return 'unknown';
  return `${cause.name}: ${cause.message}`.replace(/\?\S*/g, '?').slice(0, 200);
}

// Server error codes are short machine identifiers; anything else may carry arbitrary content.
const SERVER_ERROR_CODE = /^[a-z0-9_]{1,80}$/;

async function readServerErrorCode(response: Response): Promise<string | null> {
  try {
    const json: unknown = await response.clone().json();
    if (!json || typeof json !== 'object') return null;
    const { error, code } = json as { error?: unknown; code?: unknown };
    for (const value of [error, code]) {
      if (typeof value === 'string' && SERVER_ERROR_CODE.test(value)) return value;
    }
  } catch {
    // A non-JSON error body has no code to report.
  }
  return null;
}

/**
 * Canonical transport for every Connected Services request. A dropped connection or timeout is
 * reported as a {@link ConnectedServiceNetworkError}, and each failed attempt is logged with its
 * operation, endpoint, failure category and the server's error code — never request bodies,
 * headers, query parameters or response details beyond that code.
 */
export async function connectedServiceFetch(
  operation: string,
  path: string,
  init?: ServerReadRequestInit,
  options?: Parameters<typeof serverFetch>[2],
): Promise<Response> {
  const method = String(init?.method ?? 'GET').toUpperCase();
  const endpoint = toLoggableEndpoint(path);
  let response: Response;
  try {
    response = await serverFetch(path, init, options);
  } catch (error) {
    const category = classifyConnectedServiceTransportFailure(error);
    if (!category) throw error;
    log.log(`[connectedServices] ${operation} failed: category=${category} request=${method} ${endpoint} cause=${describeCause(error)}`);
    throw new ConnectedServiceNetworkError({ operation, endpoint, category, cause: error });
  }
  if (!response.ok) {
    const serverCode = await readServerErrorCode(response);
    log.log(`[connectedServices] ${operation} rejected: status=${response.status} request=${method} ${endpoint}${serverCode ? ` code=${serverCode}` : ''}`);
  }
  return response;
}
