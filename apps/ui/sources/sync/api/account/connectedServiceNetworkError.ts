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
 * The wrapper replaces the cause's class, so the stop decisions the shared `backoff` reads from
 * the cause (`retryable`, `canTryAgain`, and the connectivity gate's `endpoint_offline`) are
 * carried over; otherwise callers would start retrying what used to stop immediately.
 */
function isNonRetryableCause(cause: unknown): boolean {
  if (!cause || typeof cause !== 'object') return false;
  const { retryable, canTryAgain, code } = cause as { retryable?: unknown; canTryAgain?: unknown; code?: unknown };
  return retryable === false || canTryAgain === false || code === 'endpoint_offline';
}

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
    const nonRetryable = isNonRetryableCause(params.cause);
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

/** Only a refusal from the connectivity owner proves that the request was never dispatched. */
export function isConnectedServicePreDispatchFailure(error: unknown): boolean {
  const cause = error instanceof ConnectedServiceNetworkError ? error.cause : error;
  return cause instanceof ServerReachabilityWaitTimeoutError
    || (cause instanceof HappyError && cause.code === 'endpoint_offline');
}

export async function connectedServiceFetch(
  operation: string,
  path: string,
  init?: ServerReadRequestInit,
  options?: Parameters<typeof serverFetch>[2],
): Promise<Response> {
  try {
    return await serverFetch(path, init, options);
  } catch (error) {
    const category = classifyConnectedServiceTransportFailure(error);
    if (!category) throw error;
    throw new ConnectedServiceNetworkError({
      operation, endpoint: path.split(/[?#]/, 1)[0] ?? '', category, cause: error,
    });
  }
}
