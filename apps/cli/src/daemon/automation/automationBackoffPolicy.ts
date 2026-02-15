export type AutomationWorkerErrorClass = 'transient' | 'permanent';

const PERMANENT_RETRY_DELAY_MS = 300_000;
const TRANSIENT_ERROR_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ETIMEDOUT',
]);

function getStatusCode(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const response = (error as { response?: { status?: unknown } }).response;
  const status = response?.status;
  return typeof status === 'number' && Number.isFinite(status) ? status : null;
}

function getErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  const raw = (error as { code?: unknown }).code;
  return typeof raw === 'string' ? raw.trim().toUpperCase() : '';
}

export function classifyAutomationWorkerError(error: unknown): AutomationWorkerErrorClass {
  const status = getStatusCode(error);
  if (status !== null) {
    if (status >= 500 || status === 408 || status === 425 || status === 429) {
      return 'transient';
    }
    if (status >= 400 && status < 500) {
      return 'permanent';
    }
  }

  const code = getErrorCode(error);
  if (code && TRANSIENT_ERROR_CODES.has(code)) {
    return 'transient';
  }

  // Unknown errors are retried as transient to preserve liveness.
  return 'transient';
}

export function nextAutomationBackoffMs(failureCount: number): number {
  const normalized = Number.isFinite(failureCount) ? Math.max(0, Math.floor(failureCount)) : 0;
  const base = 500;
  const exp = Math.min(normalized, 8);
  return Math.min(base * (2 ** exp), 60_000);
}

export function nextAutomationRetryDelayMs(params: {
  failureCount: number;
  error: unknown;
}): number {
  const errorClass = classifyAutomationWorkerError(params.error);
  if (errorClass === 'permanent') {
    return PERMANENT_RETRY_DELAY_MS;
  }
  return nextAutomationBackoffMs(params.failureCount);
}
