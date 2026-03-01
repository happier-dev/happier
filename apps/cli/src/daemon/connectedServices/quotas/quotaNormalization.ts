import type { ConnectedServiceCredentialRecordV1 } from '@happier-dev/protocol';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function normalizePct(value: unknown): number | null {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.max(0, Math.min(100, num));
}

export function resolveConnectedServiceQuotaAccountLabel(record: ConnectedServiceCredentialRecordV1): string | null {
  if (record.kind === 'oauth') return record.oauth.providerEmail ?? null;
  if (record.kind === 'token') return record.token.providerEmail ?? null;
  return null;
}
