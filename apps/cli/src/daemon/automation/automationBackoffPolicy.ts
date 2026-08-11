import { isPermanentRequestStatus, readHttpStatus } from '@/api/client/httpStatusError';
import { readNormalizedErrorCode } from '@/api/offline/serverConnectionErrors';

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

function getErrorCode(error: unknown): string {
  return readNormalizedErrorCode(error) ?? '';
}

export function classifyAutomationWorkerError(error: unknown): AutomationWorkerErrorClass {
  // The 4xx/5xx split has ONE owner (`httpStatusError#isPermanentRequestStatus`); this policy adds
  // only the transport-code vocabulary and the delay curve on top of it.
  if (isPermanentRequestStatus(readHttpStatus(error))) {
    return 'permanent';
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
