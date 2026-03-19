import type { ConnectedServiceQuotaFetcher } from '../types';
import type { ConnectedServiceCredentialRecordV1 } from '@happier-dev/protocol';

const DEFAULT_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const DEFAULT_BETA_HEADER_VALUE = 'oauth-2025-04-20';
const DEFAULT_OAUTH_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const DEFAULT_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

import { isRecord, normalizePct, resolveConnectedServiceQuotaAccountLabel } from '../quotaNormalization';
import {
  resolveClaudeSubscriptionOauthClientId,
  resolveClaudeSubscriptionOauthTokenUrl,
} from '@/daemon/connectedServices/shared/oauthConfig';

function parseIsoDateMs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveAccountLabel(record: ConnectedServiceCredentialRecordV1): string | null {
  return resolveConnectedServiceQuotaAccountLabel(record);
}

const WINDOW_LABELS: Readonly<Record<string, string>> = Object.freeze({
  five_hour: '5-hour',
  seven_day: 'Weekly',
  seven_day_oauth_apps: 'Weekly (OAuth apps)',
  seven_day_sonnet: 'Weekly (Sonnet)',
  seven_day_opus: 'Weekly (Opus)',
  iguana_necktie: 'Unknown',
});

export function createClaudeSubscriptionQuotaFetcher(params?: Readonly<{
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
  const oauthOverrideByProfileId = new Map<string, Readonly<{ accessToken: string; refreshToken: string }>>();
  const tokenUrl = resolveClaudeSubscriptionOauthTokenUrl(process.env) || DEFAULT_OAUTH_TOKEN_URL;
  const oauthClientId = resolveClaudeSubscriptionOauthClientId(process.env) || DEFAULT_OAUTH_CLIENT_ID;

  async function fetchUsage(params: Readonly<{
    usageUrl: string;
    accessToken: string;
    betaHeaderValue: string;
    userAgent: string;
    signal: AbortSignal;
  }>): Promise<Response> {
    return fetch(params.usageUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${params.accessToken}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'anthropic-beta': params.betaHeaderValue,
        'User-Agent': params.userAgent,
      },
      signal: params.signal,
    });
  }

  async function throwUsageError(response: Response): Promise<never> {
    const body = await response.text().catch(() => '');
    if (response.status === 403) {
      const scopeMatch = body.match(/scope requirement\s+([a-z0-9:_-]+)/i);
      const requiredScope = scopeMatch?.[1] ? String(scopeMatch[1]).trim() : '';
      if (requiredScope) {
        throw new Error(
          `Claude quota fetch requires OAuth scope '${requiredScope}'. Reconnect Claude in Happier and retry.`,
        );
      }
    }
    throw new Error(`Anthropic usage fetch failed (${response.status}): ${body || response.statusText}`);
  }

  async function refreshOauthToken(params: Readonly<{ refreshToken: string; now: number }>): Promise<Readonly<{
    accessToken: string;
    refreshToken: string;
    expiresAt: number | null;
  }>> {
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: params.refreshToken,
        client_id: oauthClientId,
      }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Claude subscription refresh failed (${response.status}): ${body || response.statusText}`);
    }
    const json: unknown = await response.json();
    const data = isRecord(json) ? json : {};
    const accessToken = typeof data.access_token === 'string' ? data.access_token.trim() : '';
    if (!accessToken) {
      throw new Error('Claude subscription refresh response missing access_token');
    }
    const expiresAt =
      typeof data.expires_in === 'number' && Number.isFinite(data.expires_in)
        ? params.now + Math.max(0, Math.trunc(data.expires_in)) * 1000
        : null;
    return {
      accessToken,
      refreshToken: typeof data.refresh_token === 'string' && data.refresh_token.trim()
        ? data.refresh_token
        : params.refreshToken,
      expiresAt,
    };
  }

  return {
    serviceId: 'claude-subscription',
    fetch: async ({ record, now, signal }) => {
      if (record.kind !== 'oauth') return null;
      const profileId = String(record.profileId ?? '').trim();
      const oauthOverride = profileId ? (oauthOverrideByProfileId.get(profileId) ?? null) : null;

      const recordExpiresAt = typeof record.expiresAt === 'number' && Number.isFinite(record.expiresAt) ? record.expiresAt : null;
      const recordLooksFresh = recordExpiresAt !== null && recordExpiresAt > now + 5_000;
      let accessToken = recordLooksFresh
        ? record.oauth.accessToken
        : (oauthOverride?.accessToken ?? record.oauth.accessToken);
      let refreshToken = oauthOverride?.refreshToken ?? record.oauth.refreshToken;
      if (recordLooksFresh && oauthOverride && oauthOverride.accessToken !== record.oauth.accessToken && profileId) {
        oauthOverrideByProfileId.delete(profileId);
      }

      let response = await fetchUsage({
        usageUrl,
        accessToken,
        betaHeaderValue,
        userAgent,
        signal,
      });

      if (!response.ok && response.status === 401) {
        const trimmedRefreshToken = String(refreshToken ?? '').trim();
        if (trimmedRefreshToken) {
          const refreshed = await refreshOauthToken({
            refreshToken: trimmedRefreshToken,
            now,
          });
          accessToken = refreshed.accessToken;
          refreshToken = refreshed.refreshToken;
          if (profileId) {
            oauthOverrideByProfileId.set(profileId, { accessToken, refreshToken });
          }
          response = await fetchUsage({
            usageUrl,
            accessToken,
            betaHeaderValue,
            userAgent,
            signal,
          });
        }
      }

      if (!response.ok && response.status >= 500 && response.status < 600) {
        response = await fetchUsage({
          usageUrl,
          accessToken,
          betaHeaderValue,
          userAgent,
          signal,
        });
      }

      if (!response.ok) await throwUsageError(response);

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
