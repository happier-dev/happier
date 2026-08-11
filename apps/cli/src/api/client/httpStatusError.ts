export class HttpStatusError extends Error {
  readonly response: Readonly<{ status: number }>;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpStatusError';
    // Keep a minimal Axios-like shape so existing status-based policies can treat it consistently,
    // without carrying request config/headers that may include secrets.
    this.response = { status };
  }
}

export type HttpStatusErrorWithCode = HttpStatusError & {
  code?: string;
};

export function isAuthenticationStatus(status: number | null | undefined): status is 401 | 403 {
  return status === 401 || status === 403;
}

/**
 * The 4xx statuses that explicitly invite another attempt: a request timeout, an early-data
 * rejection, and a rate limit. They are client-error codes by number only.
 */
const RETRYABLE_CLIENT_ERROR_STATUSES: ReadonlySet<number> = new Set([408, 425, 429]);

/**
 * Whether a status means "these exact bytes were understood and rejected", so re-sending them is a
 * write loop rather than resilience.
 *
 * One rule, one owner: every caller that decides whether to retry a server response reads it here
 * instead of restating the 4xx/5xx split. 5xx, redirects and successes are not permanent — only a
 * non-retryable 4xx is.
 */
export function isPermanentRequestStatus(status: number | null | undefined): boolean {
  if (typeof status !== 'number' || !Number.isFinite(status)) return false;
  return status >= 400 && status < 500 && !RETRYABLE_CLIENT_ERROR_STATUSES.has(status);
}

/**
 * The stable code of a response that ARRIVED and was then rejected by this client's own parser.
 *
 * It is a failure of the bytes, not of the connection: the same response produces the same
 * rejection, every time, until one side of the version skew changes. Carrying a code rather than a
 * class keeps the fact readable across module instances and across a serialization boundary, the
 * same way `not_authenticated` and `session_not_found` already travel.
 */
export const INVALID_RESPONSE_SHAPE_CODE = 'invalid_response_shape';

export function createInvalidResponseShapeError(message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.name = 'InvalidResponseShapeError';
  error.code = INVALID_RESPONSE_SHAPE_CODE;
  return error;
}

/**
 * The same rule read off a thrown error.
 *
 * An error that carries NO status — transport, DNS, abort, an unexpected throw — is deliberately
 * NOT permanent: an unclassifiable failure is retried so liveness is never traded for a guess.
 *
 * The ONE statusless exception is a failure a caller has attested is deterministic (above): there
 * the answer is already known to be a pure function of bytes that were already delivered, so
 * retrying it is a write loop rather than resilience. Nothing infers this from a message or a
 * shape — the failure has to be minted as deterministic at the point that knows it is.
 */
export function isPermanentRequestError(error: unknown): boolean {
  if (asRecord(error)?.code === INVALID_RESPONSE_SHAPE_CODE) return true;
  return isPermanentRequestStatus(readHttpStatus(error));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readFiniteStatus(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * A status read off an AMBIGUOUS carrier: `status`/`statusCode` sitting directly on the error.
 * A process exit code and a domain state number use those names too, so only a value in the HTTP
 * range counts. Under `response`/`data` the position itself disambiguates and no range is applied.
 */
function readTopLevelHttpStatus(value: unknown): number | null {
  const status = readFiniteStatus(value);
  return status !== null && status >= 100 && status <= 599 ? status : null;
}

/**
 * Every place a status can live on a real thrown error, in order of how unambiguously it is one.
 *
 * The top-level read is not defensive breadth: `AxiosError` sets `status` on the error itself and
 * it is the only status that survives its `toJSON()`, and a typed terminal error can carry its own
 * (`CliClientUpgradeRequiredError.statusCode = 426`) with no `response` at all. A reader blind to
 * those calls a permanent refusal unclassifiable, and every retry policy downstream believes it.
 */
export function readHttpStatus(error: unknown): number | null {
  const record = asRecord(error);
  if (!record) return null;

  const response = asRecord(record.response);
  const responseStatus = readFiniteStatus(response?.status);
  if (responseStatus !== null) return responseStatus;

  const topLevelStatus = readTopLevelHttpStatus(record.statusCode) ?? readTopLevelHttpStatus(record.status);
  if (topLevelStatus !== null) return topLevelStatus;

  const data = asRecord(record.data);
  return readFiniteStatus(data?.statusCode) ?? readFiniteStatus(data?.status);
}

export function isAuthenticationError(error: unknown): boolean {
  return isAuthenticationStatus(readHttpStatus(error));
}

export function readAuthenticationStatus(error: unknown): 401 | 403 | null {
  const status = readHttpStatus(error);
  return isAuthenticationStatus(status) ? status : null;
}

export function createHttpStatusError(status: number, message: string, code?: string): HttpStatusErrorWithCode {
  const error = new HttpStatusError(status, message) as HttpStatusErrorWithCode;
  if (typeof code === 'string' && code.length > 0) {
    error.code = code;
  }
  return error;
}

export function createAuthenticationHttpStatusError(
  status: 401 | 403,
  message: string,
): HttpStatusErrorWithCode {
  return createHttpStatusError(status, message, 'not_authenticated');
}
