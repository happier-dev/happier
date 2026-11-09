import { classifyServerEndpointError } from '@/api/client/classifyServerEndpointError';
import { isNativeTlsErrorCode } from '@/api/client/tlsError';
import { redactBugReportSensitiveText } from '@happier-dev/protocol/bugs/reports/redaction';
import { readUnexpectedActionErrorDiagnosticV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { formatHomeAuthorityMismatchFailure, readHomeAuthorityMismatchFacts,
  readGuestAuthCategory, type HomeAuthorityMismatchFacts } from '@happier-dev/protocol/ssh/commandFailure';

type SafeAuthErrorDiagnostic = Readonly<{
  name: string;
  message: string;
  code?: string | number;
  status?: number;
  serverCode?: string;
  authCategory?: ReturnType<typeof readGuestAuthCategory>;
}> & Partial<HomeAuthorityMismatchFacts>;

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
  const cause = errorRecord && isRecord(errorRecord.cause) ? errorRecord.cause : null;
  const responseRecord = errorRecord && isRecord(errorRecord.response) ? errorRecord.response : null;
  const name = typeof errorRecord?.name === 'string' && errorRecord.name.length > 0
    ? errorRecord.name
    : 'Error';
  const rawCode = readSafeErrorCode(errorRecord?.code);
  const code = readSafeErrorCode(typeof rawCode === 'string' ? redactBugReportSensitiveText(rawCode) : rawCode);
  const message = typeof errorRecord?.message === 'string' && errorRecord.message.trim().length > 0
    && errorRecord.message !== 'Unknown error'
    ? errorRecord.message
    : code !== undefined ? String(code) : 'Unknown error';
  const status = readSafeHttpStatus(errorRecord?.status)
    ?? readSafeHttpStatus(responseRecord?.status)
    ?? readSafeHttpStatus(cause?.status);
  const transport = classifyServerEndpointError(error);
  const tls = [errorRecord?.code, cause?.code].some(value => typeof value === 'string' && isNativeTlsErrorCode(value, false));
  const authCategory = readGuestAuthCategory(errorRecord?.authCategory ?? cause?.authCategory)
    ?? (tls ? 'tls_error' : transport.kind === 'network' ? 'network_error'
      : transport.kind === 'timeout' ? 'deadline_elapsed' : undefined);
  const serverCode = readUnexpectedActionErrorDiagnosticV1({ response: responseRecord }).errorCode;
  const authority = code === 'HOME_AUTHORITY_MISMATCH' ? readHomeAuthorityMismatchFacts(errorRecord) : undefined;
  return {
    name: redactBugReportSensitiveText(name),
    message: code === 'HOME_AUTHORITY_MISMATCH' ? formatHomeAuthorityMismatchFailure(authority) : redactBugReportSensitiveText(message),
    ...authority,
    ...(code !== undefined ? { code } : {}),
    ...(authCategory ? { authCategory } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(serverCode !== null ? { serverCode } : {}),
  };
}
