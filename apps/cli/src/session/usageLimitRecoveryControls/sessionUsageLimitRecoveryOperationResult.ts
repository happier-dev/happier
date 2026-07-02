import {
  normalizeSessionUsageLimitRecoveryOperationResultV1,
  SessionUsageLimitRecoveryOperationResultV1Schema,
  type ConnectedServiceUxDiagnosticV1,
  type SessionUsageLimitRecoveryOperationResultErrorStatusV1,
  type SessionUsageLimitRecoveryOperationResultOkStatusV1,
  type SessionUsageLimitRecoveryOperationResultV1,
} from '@happier-dev/protocol';

type ResultMetadata = Record<string, unknown>;

type ResultWithLocalMetadata = SessionUsageLimitRecoveryOperationResultV1 & Readonly<{
  metadata?: ResultMetadata;
}>;

function readRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readMetadata(value: unknown): ResultMetadata | null {
  const raw = readRecord(value);
  const metadata = readRecord(raw?.metadata);
  return metadata;
}

function attachLocalMetadata(
  result: SessionUsageLimitRecoveryOperationResultV1,
  metadata: ResultMetadata | null | undefined,
): ResultWithLocalMetadata {
  if (!metadata) return result;
  return Object.defineProperty({ ...result }, 'metadata', {
    enumerable: false,
    configurable: false,
    writable: false,
    value: metadata,
  }) as ResultWithLocalMetadata;
}

export function normalizeUsageLimitRecoveryOperationResult(
  value: unknown,
  params: Readonly<{
    sessionId?: string | null;
    metadata?: ResultMetadata | null;
  }> = {},
): ResultWithLocalMetadata {
  const result = normalizeSessionUsageLimitRecoveryOperationResultV1(value, {
    sessionId: params.sessionId,
  });
  return attachLocalMetadata(result, params.metadata ?? readMetadata(value));
}

export function buildUsageLimitRecoveryOperationSuccess(
  params: Readonly<{
    sessionId: string;
    status: SessionUsageLimitRecoveryOperationResultOkStatusV1;
    issueFingerprint?: string;
    retryAfterMs?: number;
    uxDiagnostic?: ConnectedServiceUxDiagnosticV1;
    metadata?: ResultMetadata | null;
  }>,
): ResultWithLocalMetadata {
  return attachLocalMetadata(
    SessionUsageLimitRecoveryOperationResultV1Schema.parse({
      ok: true,
      status: params.status,
      sessionId: params.sessionId,
      ...(params.issueFingerprint ? { issueFingerprint: params.issueFingerprint } : {}),
      ...(typeof params.retryAfterMs === 'number' ? { retryAfterMs: params.retryAfterMs } : {}),
      ...(params.uxDiagnostic ? { uxDiagnostic: params.uxDiagnostic } : {}),
    }),
    params.metadata,
  );
}

export function buildUsageLimitRecoveryOperationError(
  params: Readonly<{
    errorCode: string;
    status: SessionUsageLimitRecoveryOperationResultErrorStatusV1;
    sessionId?: string | null;
    issueFingerprint?: string;
    retryAfterMs?: number;
    uxDiagnostic?: ConnectedServiceUxDiagnosticV1;
    metadata?: ResultMetadata | null;
  }>,
): ResultWithLocalMetadata {
  return attachLocalMetadata(
    SessionUsageLimitRecoveryOperationResultV1Schema.parse({
      ok: false,
      status: params.status,
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      errorCode: params.errorCode,
      ...(params.issueFingerprint ? { issueFingerprint: params.issueFingerprint } : {}),
      ...(typeof params.retryAfterMs === 'number' ? { retryAfterMs: params.retryAfterMs } : {}),
      ...(params.uxDiagnostic ? { uxDiagnostic: params.uxDiagnostic } : {}),
    }),
    params.metadata,
  );
}
