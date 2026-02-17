import type { ConnectedServiceQuotaFetcher } from '../types';
import type { ConnectedServiceCredentialRecordV1 } from '@happier-dev/protocol';

const DEFAULT_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const DEFAULT_BETA_HEADER_VALUE = 'oauth-2025-04-20';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizePct(value: unknown): number | null {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.max(0, Math.min(100, num));
}

function parseIsoDateMs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveAccountLabel(record: ConnectedServiceCredentialRecordV1): string | null {
  if (record.kind === 'oauth') return record.oauth.providerEmail ?? null;
  if (record.kind === 'token') return record.token.providerEmail ?? null;
  return null;
}

const WINDOW_LABELS: Readonly<Record<string, string>> = Object.freeze({
  five_hour: '5-hour',
  seven_day: 'Weekly',
  seven_day_oauth_apps: 'Weekly (OAuth apps)',
  seven_day_sonnet: 'Weekly (Sonnet)',
  seven_day_opus: 'Weekly (Opus)',
  iguana_necktie: 'Unknown',
});

export function createAnthropicQuotaFetcher(params?: Readonly<{
  usageUrl?: string;
  betaHeaderValue?: string;
  staleAfterMs?: number;
  userAgent?: string;
}>): ConnectedServiceQuotaFetcher {
  const usageUrl = params?.usageUrl ?? DEFAULT_USAGE_URL;
  const betaHeaderValue = params?.betaHeaderValue ?? DEFAULT_BETA_HEADER_VALUE;
  const staleAfterMs =
    typeof params?.staleAfterMs === 'number' && Number.isFinite(params.staleAfterMs)
      ? Math.max(1, Math.trunc(params.staleAfterMs))
      : 300_000;
  const userAgent = params?.userAgent ?? 'happier';

  return {
    serviceId: 'anthropic',
    fetch: async ({ record, now, signal }) => {
      if (record.kind !== 'oauth') return null;

      const response = await fetch(usageUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${record.oauth.accessToken}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'anthropic-beta': betaHeaderValue,
          'User-Agent': userAgent,
        },
        signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Anthropic usage fetch failed (${response.status}): ${body || response.statusText}`);
      }

      const json: unknown = await response.json();
      const data = isRecord(json) ? json : {};

      const meters: Array<{
        meterId: string;
        label: string;
        used: number | null;
        limit: number | null;
        unit: 'unknown' | 'credits';
        utilizationPct: number | null;
        resetsAt: number | null;
        status: 'ok' | 'unavailable';
        details: Record<string, never>;
      }> = [];
      for (const [key, label] of Object.entries(WINDOW_LABELS)) {
        const window = isRecord(data[key]) ? data[key] : null;
        const utilizationPct = normalizePct(window?.utilization);
        meters.push({
          meterId: key,
          label,
          used: null,
          limit: null,
          unit: 'unknown',
          utilizationPct,
          resetsAt: parseIsoDateMs(window?.resets_at),
          status: utilizationPct === null ? 'unavailable' : 'ok',
          details: {},
        });
      }

      const extra = isRecord(data.extra_usage) ? data.extra_usage : null;
      if (extra?.is_enabled) {
        const utilizationPct = normalizePct(extra.utilization);
        meters.push({
          meterId: 'extra_usage',
          label: 'Extra usage',
          used: typeof extra.used_credits === 'number' && Number.isFinite(extra.used_credits) ? extra.used_credits : null,
          limit: typeof extra.monthly_limit === 'number' && Number.isFinite(extra.monthly_limit) ? extra.monthly_limit : null,
          unit: 'credits',
          utilizationPct,
          resetsAt: null,
          status: utilizationPct === null ? 'unavailable' : 'ok',
          details: {},
        });
      }

      return {
        v: 1,
        serviceId: record.serviceId,
        profileId: record.profileId,
        fetchedAt: now,
        staleAfterMs,
        planLabel: null,
        accountLabel: resolveAccountLabel(record),
        meters,
      };
    },
  };
}
