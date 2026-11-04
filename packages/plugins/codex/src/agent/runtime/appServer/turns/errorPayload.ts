import { readRecord, trimStringValue } from '../wire/fields.js';

export type CodexAppServerErrorPayload = Readonly<{
  message: string | null;
  additionalDetails: string | null;
  codexErrorInfo: string | null;
  transportFailureWithoutResponse: boolean;
  httpStatus?: number;
  providerErrorCode?: 'model_not_found';
}>;

export function readCodexAppServerErrorPayload(
  value: unknown,
): CodexAppServerErrorPayload | null {
  const record = readRecord(value);
  if (!record) return null;

  const directError = readRecord(record.error);
  const turn = readRecord(record.turn);
  const turnError = readRecord(turn?.error);
  const data = readRecord(record.data);
  const dataTurn = readRecord(data?.turn);
  const error =
    directError ??
    turnError ??
    readRecord(data?.error) ??
    readRecord(dataTurn?.error) ??
    data ??
    (value instanceof Error ? record : null);
  if (!error) return null;

  const errorInfo = error.codexErrorInfo ?? error.codex_error_info;
  const structuredInfo = readRecord(errorInfo);
  // Native rust-v0.162.1 v2/shared.rs: all four transport variants carry
  // optional HTTP status; admit them through the same structured reader.
  const transportError = [
    [
      'HttpConnectionFailed',
      structuredInfo?.httpConnectionFailed ??
        structuredInfo?.http_connection_failed,
    ],
    [
      'ResponseStreamConnectionFailed',
      structuredInfo?.responseStreamConnectionFailed ??
        structuredInfo?.response_stream_connection_failed,
    ],
    [
      'ResponseStreamDisconnected',
      structuredInfo?.responseStreamDisconnected ??
        structuredInfo?.response_stream_disconnected,
    ],
    [
      'ResponseTooManyFailedAttempts',
      structuredInfo?.responseTooManyFailedAttempts ??
        structuredInfo?.response_too_many_failed_attempts,
    ],
  ].find(([, details]) => readRecord(details));
  const httpFailure = readRecord(transportError?.[1]);
  const httpStatus =
    httpFailure?.httpStatusCode ?? httpFailure?.http_status_code;
  // Codex 0.162.1 flattens an upstream 400 JSON error into message and labels
  // it `other`. Read the envelope's stable code; never classify its prose.
  let upstreamError = error;
  if (
    upstreamError.code !== 'model_not_found' &&
    typeof error.message === 'string'
  ) {
    const start = error.message.indexOf('{');
    const end = error.message.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        upstreamError =
          readRecord(
            readRecord(JSON.parse(error.message.slice(start, end + 1)))?.error,
          ) ?? error;
      } catch {
        /* Malformed provider text supplies no structured evidence. */
      }
    }
  }

  return {
    message:
      trimStringValue(error.message) ??
      (value instanceof Error ? value.message : null),
    additionalDetails: trimStringValue(
      error.additionalDetails ?? error.additional_details,
    ),
    codexErrorInfo: transportError
      ? trimStringValue(transportError[0])
      : trimStringValue(errorInfo),
    // Retry exhaustion alone does not identify the cause. These native
    // transport variants without an HTTP response do identify endpoint loss.
    transportFailureWithoutResponse: httpFailure !== null &&
      (httpStatus === null || httpStatus === undefined) &&
      transportError?.[0] !== 'ResponseTooManyFailedAttempts',
    ...(upstreamError.code === 'model_not_found'
      ? { providerErrorCode: 'model_not_found' as const }
      : {}),
    ...(typeof httpStatus === 'number' &&
    Number.isInteger(httpStatus) &&
    httpStatus >= 100 &&
    httpStatus <= 599
      ? { httpStatus }
      : {}),
  };
}
