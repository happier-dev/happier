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

export function readHttpStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const response = (error as { response?: { status?: unknown } }).response;
  const status = response?.status;
  return typeof status === 'number' && Number.isFinite(status) ? status : null;
}
