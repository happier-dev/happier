import type { ConnectedServiceQuotaRecoveryCreditV1, ConnectedServiceQuotaRecoveryCreditsV1,
  ConnectedServiceQuotaRecoveryCreditDetailsByIdV1 } from '@happier-dev/protocol';
import { createHash } from 'node:crypto';

import { isRecord } from '@/daemon/connectedServices/quotas/quotaNormalization';

// Contract basis: can1357/oh-my-pi ca18a903c5d7c946c26c728a66d3a9151f0c26b1,
// packages/ai/src/usage/claude-reset.ts, plus an authenticated October 2026 usage read.
function timestamp(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const result = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(result) || result < 0) throw new Error('Malformed Claude reset timestamp');
  return result;
}

function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new Error('Malformed Claude reset count');
  return value;
}

export function parseClaudeQuotaResets(payload: unknown, now: number): Readonly<{
  recoveryCredits: ConnectedServiceQuotaRecoveryCreditsV1;
  recoveryCreditDetails: ConnectedServiceQuotaRecoveryCreditDetailsByIdV1;
}> | undefined {
  if (!isRecord(payload)) throw new Error('Malformed Claude reset response');
  const cedar = payload.cedar_ember;
  const juniper = payload.juniper_tide;
  // Plain usage includes null blocks until the program query evaluates them.
  if (cedar == null && juniper == null) return undefined;
  const credits: ConnectedServiceQuotaRecoveryCreditV1[] = [];
  const recoveryCreditDetails: ConnectedServiceQuotaRecoveryCreditDetailsByIdV1 = {};
  let availableCount = 0;
  let totalCount: number | undefined = isRecord(cedar) && Array.isArray(cedar.grants) ? 0 : undefined;
  if (cedar != null) {
    if (!isRecord(cedar) || typeof cedar.eligible !== 'boolean'
      || (cedar.grants !== undefined && !Array.isArray(cedar.grants))) throw new Error('Malformed Claude Cedar status');
    const cooldownUntil = timestamp(cedar.cooldown_until);
    for (const raw of cedar.grants ?? []) {
      if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id.trim()
        || (raw.usable_now !== undefined && typeof raw.usable_now !== 'boolean')
        || (raw.paused !== undefined && typeof raw.paused !== 'boolean')
        || (raw.use_requires_limit !== undefined && typeof raw.use_requires_limit !== 'boolean')
        || !Array.isArray(raw.clears) || raw.clears.some((value) => typeof value !== 'string')) throw new Error('Malformed Claude Cedar grant');
      const remaining = count(raw.resets_left);
      if (raw.resets_total === undefined) totalCount = undefined;
      else {
        const total = count(raw.resets_total);
        if (total < remaining) throw new Error('Malformed Claude Cedar balance');
        if (totalCount !== undefined) totalCount += total;
      }
      const grantedAtMs = timestamp(raw.starts_at);
      const expiresAtMs = timestamp(raw.ends_at);
      const expired = expiresAtMs !== null && expiresAtMs <= now;
      // next_grant_id is the provider's default suggestion, not an exclusive selection: Claude Code
      // 2.1.319 offers every grant whose own usable_now is true (verified against a November 2026 read).
      const available = cedar.eligible && raw.usable_now === true
        && raw.paused !== true && remaining > 0 && !expired
        && (grantedAtMs === null || grantedAtMs <= now) && (cooldownUntil === null || cooldownUntil <= now);
      if (available) availableCount += remaining;
      recoveryCreditDetails[raw.id] = { remainingCount: remaining, appliesToProviderLimitIds: raw.clears,
        ...(available ? {} : { unavailableReason: expired ? 'expired' : remaining === 0 ? 'consumed'
          : !cedar.eligible ? 'ineligible' : raw.paused === true ? 'paused'
            : cooldownUntil !== null && cooldownUntil > now ? 'cooldown'
              : grantedAtMs !== null && grantedAtMs > now ? 'not_started'
                : 'provider_unavailable' }) };
      credits.push({ providerCreditId: raw.id, kind: 'quota_reset', providerResetType: 'cedar_ember',
        status: expired ? 'expired' : remaining === 0 ? 'redeemed' : available ? 'available' : 'unknown',
        title: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : null,
        description: typeof raw.description === 'string' && raw.description.trim() ? raw.description.trim() : null,
        ...(raw.clears.length === 1 ? { appliesToProviderLimitId: raw.clears[0] } : {}), grantedAtMs, expiresAtMs });
    }
  }
  if (juniper != null) {
    if (!isRecord(juniper) || typeof juniper.eligible !== 'boolean'
      || (juniper.available !== undefined && typeof juniper.available !== 'boolean')) throw new Error('Malformed Claude Juniper status');
    if (juniper.arm === 'reset') {
      const expiresAtMs = timestamp(juniper.weekly_resets_at);
      const cooldownUntil = timestamp(juniper.next_available_at);
      const available = juniper.eligible && juniper.available === true && (expiresAtMs === null || expiresAtMs > now)
        && (cooldownUntil === null || cooldownUntil <= now);
      if (available) availableCount += 1;
      // resets_per_week is an allowance, not an issued historical balance.
      totalCount = undefined;
      recoveryCreditDetails.juniper_tide = { remainingCount: available ? 1 : 0, appliesToProviderLimitIds: ['five_hour'],
        ...(available ? {} : { unavailableReason: !juniper.eligible ? 'ineligible'
          : expiresAtMs !== null && expiresAtMs <= now ? 'expired'
            : cooldownUntil !== null && cooldownUntil > now ? 'cooldown' : 'provider_unavailable' }) };
      credits.push({ providerCreditId: 'juniper_tide', kind: 'quota_reset', providerResetType: 'juniper_tide',
        status: available ? 'available' : 'unknown', appliesToProviderLimitId: 'five_hour',
        title: typeof juniper.label === 'string' && juniper.label.trim() ? juniper.label.trim() : null,
        description: typeof juniper.description === 'string' && juniper.description.trim() ? juniper.description.trim() : null, expiresAtMs });
    }
  }
  const expirations = credits.filter((credit) => credit.status === 'available').flatMap((credit) => credit.expiresAtMs == null ? [] : [credit.expiresAtMs]);
  return { recoveryCredits: { kind: 'usage_limit_resets', availableCount, ...(totalCount === undefined ? {} : { totalCount }),
    source: 'provider_api', confidence: 'exact', credits, nextExpiresAtMs: expirations.length ? Math.min(...expirations) : null },
    recoveryCreditDetails };
}

/** UUID form of the daemon's account-scoped operation identity; no server retry guarantee is assumed. */
export function claudeResetRequestId(idempotencyKey: string): string {
  const bytes = createHash('sha256').update(idempotencyKey).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
