import { parseTimestampMs } from '@happier-dev/plugin-sdk';
import type {
  AgentAccountUsageRecoveryCredit,
  AgentAccountUsageRecoveryCredits,
} from '@happier-dev/plugin-sdk/agents/runtime';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readNonNegativeInteger(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return Math.trunc(numeric);
}

function readTimestampMs(value: unknown): number | null {
  if (typeof value === 'number') return parseTimestampMs(value);
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 0) {
    return parseTimestampMs(numeric);
  }
  const text = readString(value);
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeStatus(value: unknown): AgentAccountUsageRecoveryCredit['status'] {
  const status = readString(value)?.toLowerCase();
  if (status === 'available') return 'available';
  if (status === 'redeeming' || status === 'redeem_started' || status === 'pending') return 'redeeming';
  if (status === 'redeemed' || status === 'used' || status === 'consumed') return 'redeemed';
  if (status === 'expired') return 'expired';
  if (status === 'unavailable') return 'unavailable';
  return 'unknown';
}

function readCreditsContainer(rawResetCredits: unknown): Record<string, unknown> | null {
  const record = isRecord(rawResetCredits) ? rawResetCredits : null;
  if (!record) return null;
  return record;
}

function readUsageSummaryContainer(rawUsage: unknown): Record<string, unknown> | null {
  const record = isRecord(rawUsage) ? rawUsage : null;
  const summary = record && isRecord(record.rate_limit_reset_credits)
    ? record.rate_limit_reset_credits
    : null;
  return summary;
}

function mapCredit(rawCredit: unknown): AgentAccountUsageRecoveryCredit | null {
  const record = isRecord(rawCredit) ? rawCredit : null;
  if (!record) return null;
  const id = readString(record.id);
  if (!id) return null;
  const grantedAtMs = readTimestampMs(record.granted_at ?? record.grantedAt);
  const expiresAtMs = readTimestampMs(record.expires_at ?? record.expiresAt);
  const redeemStartedAtMs = readTimestampMs(record.redeem_started_at ?? record.redeemStartedAt);
  const redeemedAtMs = readTimestampMs(record.redeemed_at ?? record.redeemedAt);
  return {
    id,
    kind: 'usage_limit_reset',
    status: normalizeStatus(record.status),
    ...(grantedAtMs !== null ? { grantedAtMs } : {}),
    ...(expiresAtMs !== null ? { expiresAtMs } : {}),
    ...(redeemStartedAtMs !== null ? { redeemStartedAtMs } : {}),
    ...(redeemedAtMs !== null ? { redeemedAtMs } : {}),
    ...(readString(record.title) ? { title: readString(record.title) as string } : {}),
    ...(readString(record.description) ? { description: readString(record.description) as string } : {}),
  };
}

export function mapCodexRateLimitResetCredits(params: Readonly<{
  rawUsage?: unknown;
  rawResetCredits?: unknown;
}>): AgentAccountUsageRecoveryCredits | undefined {
  const resetCredits = readCreditsContainer(params.rawResetCredits);
  const usageSummary = readUsageSummaryContainer(params.rawUsage);
  const rawCredits = Array.isArray(resetCredits?.credits) ? resetCredits.credits : [];
  const credits = rawCredits
    .map((credit) => mapCredit(credit))
    .filter((credit): credit is AgentAccountUsageRecoveryCredit => credit !== null);
  const availableCount =
    readNonNegativeInteger(resetCredits?.available_count ?? resetCredits?.availableCount)
    ?? readNonNegativeInteger(usageSummary?.available_count ?? usageSummary?.availableCount)
    ?? (credits.length > 0 ? credits.filter((credit) => credit.status === 'available').length : null);
  if (availableCount === null && credits.length === 0) return undefined;
  return {
    availableCount: availableCount ?? 0,
    credits,
  };
}
