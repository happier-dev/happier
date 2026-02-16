import type { ConnectedServiceQuotaFetcher } from '../types';
import type { ConnectedServiceCredentialRecordV1 } from '@happier-dev/protocol';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizePct(value: unknown): number | null {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.max(0, Math.min(100, num));
}

function normalizeResetAtMs(value: unknown): number | null {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  // Heuristic: usage APIs commonly return unix seconds.
  return num > 1_000_000_000_000 ? Math.trunc(num) : Math.trunc(num * 1000);
}

function resolveAccountLabel(record: ConnectedServiceCredentialRecordV1): string | null {
  if (record.kind === 'oauth') return record.oauth.providerEmail ?? null;
  if (record.kind === 'token') return record.token.providerEmail ?? null;
  return null;
}

export function createOpenAiCodexQuotaFetcher(params?: Readonly<{
  usageUrl?: string;
  staleAfterMs?: number;
  userAgent?: string;
}>): ConnectedServiceQuotaFetcher {
  const usageUrl = params?.usageUrl ?? 'https://chatgpt.com/backend-api/wham/usage';
  const staleAfterMs = typeof params?.staleAfterMs === 'number' && Number.isFinite(params.staleAfterMs) ? Math.max(1, Math.trunc(params.staleAfterMs)) : 300_000;
  const userAgent = params?.userAgent ?? 'happier';

  return {
    serviceId: 'openai-codex',
    fetch: async ({ record, now, signal }) => {
      if (record.kind !== 'oauth') return null;

      const response = await fetch(usageUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${record.oauth.accessToken}`,
          ...(record.oauth.providerAccountId ? { 'ChatGPT-Account-Id': record.oauth.providerAccountId } : {}),
          'Accept': 'application/json',
          'User-Agent': userAgent,
        },
        signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`OpenAI usage fetch failed (${response.status}): ${body || response.statusText}`);
      }

      const json: unknown = await response.json();
      const data = isRecord(json) ? json : {};

      const planLabel = normalizeNonEmptyString(data.plan_type);
      const rateLimit = isRecord(data.rate_limit) ? data.rate_limit : null;
      const primary = rateLimit && isRecord(rateLimit.primary_window) ? rateLimit.primary_window : null;
      const secondary = rateLimit && isRecord(rateLimit.secondary_window) ? rateLimit.secondary_window : null;

      const sessionPct = normalizePct(primary?.used_percent);
      const weeklyPct = normalizePct(secondary?.used_percent);

      return {
        v: 1,
        serviceId: record.serviceId,
        profileId: record.profileId,
        fetchedAt: now,
        staleAfterMs,
        planLabel,
        accountLabel: resolveAccountLabel(record),
        meters: [
          {
            meterId: 'session',
            label: 'Session',
            used: null,
            limit: null,
            unit: 'unknown',
            utilizationPct: sessionPct,
            resetsAt: normalizeResetAtMs(primary?.reset_at),
            status: sessionPct === null ? 'unavailable' : 'ok',
            details: {},
          },
          {
            meterId: 'weekly',
            label: 'Weekly',
            used: null,
            limit: null,
            unit: 'unknown',
            utilizationPct: weeklyPct,
            resetsAt: normalizeResetAtMs(secondary?.reset_at),
            status: weeklyPct === null ? 'unavailable' : 'ok',
            details: {},
          },
        ],
      };
    },
  };
}
