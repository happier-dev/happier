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

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readFiniteStatus(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function readHttpStatus(error: unknown): number | null {
  const record = asRecord(error);
  if (!record) return null;

  const response = asRecord(record.response);
  const responseStatus = readFiniteStatus(response?.status);
  if (responseStatus !== null) return responseStatus;

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

export function createHttpStatusError(status: number, message: string, code?: string): HttpStatusError & { code?: string } {
  const error = new HttpStatusError(status, message) as HttpStatusError & { code?: string };
  if (typeof code === 'string' && code.length > 0) {
    error.code = code;
  }
  return error;
}

export function createAuthenticationHttpStatusError(
  status: 401 | 403,
  message: string,
): HttpStatusError & { code?: string } {
  return createHttpStatusError(status, message, 'not_authenticated');
}
