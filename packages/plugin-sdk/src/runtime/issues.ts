import type {
  SessionRuntimeIssueSourceV1,
  SessionRuntimeIssueV1,
  SessionRuntimeTemporaryThrottleDetailsV1,
  SessionRuntimeUsageLimitDetailsV1,
} from '@happier-dev/protocol';

export type BuildSessionRuntimeIssueV1Input = Readonly<{
  code: string;
  source: SessionRuntimeIssueSourceV1;
  occurredAt: number;
  sessionSeq?: number | null;
  provider?: string | null;
  providerTurnId?: string | null;
  sanitizedPreview?: string | null;
  usageLimit?: SessionRuntimeUsageLimitDetailsV1 | null;
  temporaryThrottle?: SessionRuntimeTemporaryThrottleDetailsV1 | null;
  providerProcessExitAfterSwitch?: SessionRuntimeIssueV1['providerProcessExitAfterSwitch'] | null;
}>;

function normalizeNonNegativeInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const normalized = Math.trunc(value);
  return normalized >= 0 ? normalized : null;
}

function normalizeString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized) return null;
  return normalized.slice(0, maxLength);
}

export function buildSessionRuntimeIssueV1(
  input: BuildSessionRuntimeIssueV1Input,
): SessionRuntimeIssueV1 {
  const code = normalizeString(input.code, 256) ?? input.source;
  const occurredAt = normalizeNonNegativeInteger(input.occurredAt) ?? Date.now();
  const sessionSeq = normalizeNonNegativeInteger(input.sessionSeq);
  const provider = normalizeString(input.provider, 128);
  const providerTurnId = normalizeString(input.providerTurnId, 256);
  const sanitizedPreview = normalizeString(input.sanitizedPreview, 2_000);

  return {
    v: 1,
    scope: 'primary_session',
    status: 'failed',
    code,
    source: input.source,
    occurredAt,
    ...(sessionSeq === null ? {} : { sessionSeq }),
    ...(provider === null ? {} : { provider }),
    ...(providerTurnId === null ? {} : { providerTurnId }),
    ...(sanitizedPreview === null ? {} : { sanitizedPreview }),
    ...(input.usageLimit ? { usageLimit: input.usageLimit } : {}),
    ...(input.temporaryThrottle ? { temporaryThrottle: input.temporaryThrottle } : {}),
    ...(input.providerProcessExitAfterSwitch
      ? { providerProcessExitAfterSwitch: input.providerProcessExitAfterSwitch }
      : {}),
  };
}
