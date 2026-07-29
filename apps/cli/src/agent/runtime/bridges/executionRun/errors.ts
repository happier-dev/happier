export type ExecutionRunTimeoutError = Error & Readonly<{
  executionRunErrorCode: string;
  livenessProbe?: unknown;
}>;

export function createExecutionRunTimeoutError(params: Readonly<{
  timeoutMs: number;
  errorCode: string;
  livenessProbe: unknown;
}>): ExecutionRunTimeoutError {
  const error = new Error(`Timed out after ${params.timeoutMs}ms`) as ExecutionRunTimeoutError;
  Object.assign(error, {
    executionRunErrorCode: params.errorCode,
    livenessProbe: params.livenessProbe,
  });
  return error;
}

export function readExecutionRunErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const code = (error as { executionRunErrorCode?: unknown }).executionRunErrorCode;
  return typeof code === 'string' && code.trim() ? code.trim() : null;
}

export function createExecutionRunCodedError(code: string, message: string): Error {
  const error = new Error(message);
  Object.assign(error, { executionRunErrorCode: code });
  return error;
}

export function isExecutionRunTimeoutError(error: unknown): error is ExecutionRunTimeoutError {
  const code = readExecutionRunErrorCode(error);
  return code === 'provider_inactivity_timeout';
}
