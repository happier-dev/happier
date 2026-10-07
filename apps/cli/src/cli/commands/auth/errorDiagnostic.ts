type SafeAuthErrorDiagnostic = Readonly<{
  name: string;
  message: string;
  code?: string | number;
  status?: number;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readSafeErrorCode(value: unknown): string | number | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return /^[A-Za-z0-9_.:-]+$/.test(value) ? value : undefined;
}

function readSafeHttpStatus(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;
}

/** Never serialize attached HTTP configuration, request/response bodies, or credentials. */
export function projectSafeAuthError(error: unknown): SafeAuthErrorDiagnostic {
  const errorRecord = isRecord(error) ? error : null;
  const responseRecord = errorRecord && isRecord(errorRecord.response) ? errorRecord.response : null;
  const name = typeof errorRecord?.name === 'string' && errorRecord.name.length > 0
    ? errorRecord.name
    : 'Error';
  const code = readSafeErrorCode(errorRecord?.code);
  const message = typeof errorRecord?.message === 'string' && errorRecord.message.trim().length > 0
    && errorRecord.message !== 'Unknown error'
    ? errorRecord.message
    : code !== undefined ? String(code) : 'Unknown error';
  const status = readSafeHttpStatus(errorRecord?.status)
    ?? readSafeHttpStatus(responseRecord?.status);
  return {
    name,
    message,
    ...(code !== undefined ? { code } : {}),
    ...(status !== undefined ? { status } : {}),
  };
}
