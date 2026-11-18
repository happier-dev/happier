import { readHttpStatus } from '@happier-dev/plugin-sdk/http';

export { readHttpStatus } from '@happier-dev/plugin-sdk/http';

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

export function isAuthenticationStatus(status: number | null | undefined): status is 401 | 403 {
  return status === 401 || status === 403;
}

export function isAuthenticationError(error: unknown): boolean {
  return isAuthenticationStatus(readHttpStatus(error));
}

export function readAuthenticationStatus(error: unknown): 401 | 403 | null {
  const status = readHttpStatus(error);
  return isAuthenticationStatus(status) ? status : null;
}

export function createHttpStatusError(status: number, message: string, code?: string): HttpStatusError & { code?: string } {
  const error = new HttpStatusError(status, message) as HttpStatusError & { code?: string };
  if (typeof code === 'string' && code.length > 0) {
    error.code = code;
  }
  return error;
}

const SERVER_REFUSAL_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u;

/** The server's typed refusal code from a `{ error: '<code>' }` response body, or null. */
export function readServerRefusalCode(responseBody: unknown): string | null {
  if (!responseBody || typeof responseBody !== 'object' || Array.isArray(responseBody)) return null;
  const code = (responseBody as Readonly<Record<string, unknown>>).error;
  return typeof code === 'string' && SERVER_REFUSAL_CODE_PATTERN.test(code) ? code : null;
}

/**
 * The one CLI owner that turns a 401/403 response into an error. A 403 that
 * carries the server's typed refusal is a refusal, not a sign-in failure: it
 * keeps that code and names it. Everything else is `not_authenticated`. The
 * status is kept either way, so status-based stop conditions are unchanged.
 */
export function createAuthenticationHttpStatusError(
  status: 401 | 403,
  message: string,
  responseBody?: unknown,
): HttpStatusError & { code?: string } {
  const refusalCode = status === 403 ? readServerRefusalCode(responseBody) : null;
  if (refusalCode) return createHttpStatusError(status, `Happier server refused this request: ${refusalCode}`, refusalCode);
  return createHttpStatusError(status, message, 'not_authenticated');
}
