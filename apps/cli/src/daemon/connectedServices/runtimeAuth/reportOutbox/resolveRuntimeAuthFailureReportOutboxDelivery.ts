export type RuntimeAuthFailureReportOutboxDeliveryDisposition = 'delivered' | 'drop' | 'retry';

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readBoundedString(value: unknown, maxLength: number): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized.length > 0 && normalized.length <= maxLength ? normalized : null;
}

/**
 * Runner reports remain durable until the daemon proves custody of this exact report.
 * The only receipt-free terminal outcomes are emitted by the dedicated temporary-throttle
 * owner: either it has armed its own retry, or it has made retry explicitly user-owned.
 * Other projected progress cannot authorize deletion after an ambiguous response boundary.
 */
export function resolveRuntimeAuthFailureReportOutboxDelivery(input: Readonly<{
  expectedReportId: string;
  response: unknown;
}>): RuntimeAuthFailureReportOutboxDeliveryDisposition {
  const envelope = readRecord(input.response);
  const recoveryReceipt = readRecord(envelope?.recoveryReceipt);
  if (
    readBoundedString(recoveryReceipt?.reportId, 256) === input.expectedReportId
  ) {
    return 'delivered';
  }

  const result = envelope?.ok === true ? readRecord(envelope.result) : null;
  if (
    result?.status === 'recovery_superseded'
    || result?.status === 'session_not_found'
    || result?.status === 'temporary_retry_armed'
    || result?.status === 'temporary_retry_unavailable'
  ) {
    return 'drop';
  }

  return 'retry';
}
