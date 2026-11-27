import { ConnectedServiceQuotaSnapshotV1Schema, type ConnectedServiceQuotaMeterV1 } from '@happier-dev/protocol';
import { ConnectedServiceQuotaFetchError, type ConnectedServiceQuotaFetcher, type ConnectedServiceQuotaFetcherDescriptor } from '@/daemon/connectedServices/quotas/types';
import { requestGoogleCodeAssist, type GoogleCodeAssistFetchRuntime } from '@/daemon/connectedServices/quotas/googleCodeAssistRequest';
import { readConnectedServiceQuotaStaleAfterMs } from '@/daemon/connectedServices/quotas/configuration';

// The Antigravity ACP 1.3.0 useragent.py client surface. Without this product token Google returns
// UNSUPPORTED_CLIENT instead of the entitlement (re-observed 2026-11-27 against prod and daily while
// agy 1.5.18 was current). It describes this read-only request, not a runtime.
const QUOTA_USER_AGENT = 'antigravity/acp/1.3.0 (aidev_client; host_path=happier; proxy_client=antigravity/sdk)';

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function text(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function number(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}
/** `reason` names the failed check so the refresh log shows why (fixed codes and provider ids only, never values). */
function malformed(reason: string): never {
  throw new ConnectedServiceQuotaFetchError(`antigravity_quota_malformed:${reason}`, { quotaFetchErrorCode: 'malformed' });
}
/** Provider tier ids and ineligibility reason codes from loadCodeAssist, for the log only. */
function describeEntitlement(load: Record<string, unknown> | null): string {
  const ids = (value: unknown, key: string) => Array.isArray(value) ? value.map(item => text(object(item)?.[key])).filter(Boolean).join('|') : '';
  return `allowed=${ids(load?.allowedTiers, 'id') || '-'};ineligible=${ids(load?.ineligibleTiers, 'reasonCode') || '-'};paid=${text(object(load?.paidTier)?.id) ?? '-'}`;
}

function meter(value: unknown, groupName: string | null, modelId?: string): ConnectedServiceQuotaMeterV1 {
  const bucket = object(value);
  const bucketId = text(bucket?.bucketId);
  if (!bucket || !bucketId) return malformed('bucket_without_id');
  const fraction = number(bucket.remainingFraction);
  if (fraction !== null && fraction > 1) return malformed('remaining_fraction_above_one');
  const remaining = number(bucket.remainingAmount);
  const limit = remaining !== null && fraction !== null && fraction > 0 ? remaining / fraction : null;
  const resetText = text(bucket.resetTime);
  const reset = resetText ? Date.parse(resetText) : Number.NaN;
  const resetsAt = Number.isFinite(reset) && reset >= 0 ? reset : null;
  const window = text(bucket.window);
  const disabled = bucket.disabled === true;
  const windowDurationMs = window === 'weekly' ? 604_800_000 : window === '5h' ? 18_000_000 : null;
  return {
    meterId: bucketId,
    providerLimitId: bucketId,
    ...(modelId ? { modelId, limitScope: 'model' as const } : { limitScope: 'account' as const }),
    scope: modelId ? 'model' : window === 'weekly' ? 'weekly' : window === '5h' ? 'five_hour' : 'unknown',
    ...(windowDurationMs ? { windowDurationMs } : {}),
    source: 'provider_api',
    confidence: fraction === null && remaining === null ? 'unknown' : 'exact',
    label: [text(bucket.displayName) ?? groupName ?? bucketId, window].filter(Boolean).join(' · '),
    used: limit !== null && remaining !== null ? Math.max(0, limit - remaining) : null,
    limit,
    remaining,
    remainingPct: fraction === null ? null : fraction * 100,
    utilizationPct: fraction === null ? null : (1 - fraction) * 100,
    isExhausted: !disabled && (fraction === 0 || remaining === 0),
    unit: modelId ? text(bucket.tokenType) === 'REQUESTS' ? 'requests' : 'unknown'
      : remaining === null ? 'unknown' : 'count',
    resetsAt,
    resetAtMs: resetsAt,
    status: disabled || (fraction === null && remaining === null) ? 'unavailable' : 'ok',
    details: {
      ...(disabled ? { code: 'provider_disabled' } : {}),
      ...(window ? { rawScope: window } : {}),
      ...(text(bucket.description) ? { note: text(bucket.description) } : {}),
    },
  };
}

export function createAgyQuotaFetcher(deps: Readonly<{ fetchRuntime?: GoogleCodeAssistFetchRuntime; staleAfterMs?: number }> = {}): ConnectedServiceQuotaFetcher {
  return { serviceId: 'antigravity', async fetch({ record, now, signal }) {
    if (record.serviceId !== 'antigravity' || record.kind !== 'oauth' || !record.oauth.accessToken) {
      throw new ConnectedServiceQuotaFetchError('missing_antigravity_oauth_record', { quotaFetchErrorCode: 'missing_auth' });
    }
    const explicitProject = text(object(record.oauth.raw)?.project_id);
    const userAgent = QUOTA_USER_AGENT;
    const request = { fetchRuntime: deps.fetchRuntime ?? fetch, accessToken: record.oauth.accessToken, userAgent, signal };
    // ACP 1.3.0 onboard.py bootstraps on prod and selects daily only for consumer tiers.
    // Quota refresh reads the entitlement; it never invokes onboardUser or changes billing.
    const load = object(await requestGoogleCodeAssist({ ...request, endpoint: 'https://cloudcode-pa.googleapis.com', method: 'loadCodeAssist',
      body: { metadata: { ideType: 'ANTIGRAVITY' }, ...(explicitProject ? { cloudaicompanionProject: explicitProject } : {}) } }));
    const project = explicitProject ?? text(load?.cloudaicompanionProject) ?? text(object(load?.cloudaicompanionProject)?.id);
    const planLabel = text(object(load?.paidTier)?.name) ?? text(object(load?.currentTier)?.name);
    const snapshot = (meters: ConnectedServiceQuotaMeterV1[]) => ConnectedServiceQuotaSnapshotV1Schema.parse({ v: 1, serviceId: 'antigravity',
      profileId: record.profileId, fetchedAt: now, staleAfterMs: deps.staleAfterMs ?? readConnectedServiceQuotaStaleAfterMs(process.env),
      planLabel, accountLabel: record.oauth.providerEmail ?? record.oauth.providerAccountId, meters });
    if (!project || !object(load?.currentTier)) {
      // A valid entitlement without an assigned project (never onboarded: native agy onboards
      // on its first run; or a tier awaiting a user-defined project) has no quota to read yet.
      // That is unknown quota, never exhausted. An unidentified client offers no free tier.
      const onboardable = Array.isArray(load?.allowedTiers) && load.allowedTiers.some(tier => object(tier)?.id === 'free-tier');
      return object(load?.currentTier) || onboardable ? snapshot([]) : malformed(`no_project_or_tier:${describeEntitlement(load)}`);
    }
    const endpoint = object(load?.paidTier)?.usesGcpTos === true ? 'https://cloudcode-pa.googleapis.com' : 'https://daily-cloudcode-pa.googleapis.com';
    const response = object(await requestGoogleCodeAssist({ ...request, endpoint, method: 'retrieveUserQuotaSummary', body: { project } }));
    const summary = object(response?.quotaSummary) ?? response;
    let meters: ConnectedServiceQuotaMeterV1[];
    if (Array.isArray(summary?.groups)) {
      meters = summary.groups.flatMap(value => {
        const group = object(value);
        if (!group || (group.buckets !== undefined && !Array.isArray(group.buckets))) return malformed('summary_group_shape');
        return Array.isArray(group.buckets) ? group.buckets.map(bucket => meter(bucket, text(group.displayName))) : [];
      });
    } else if (Array.isArray(summary?.buckets)) {
      // Deprecated shape is explicitly documented by the bundled CCPA discovery schema.
      meters = summary.buckets.map(bucket => meter(bucket, null));
    } else return malformed('summary_without_groups_or_buckets');
    // A successful empty summary has no shared allowance to display. The provider's
    // per-model quota endpoint preserves each exact model identity; no family folding.
    if (meters.length === 0) {
      const quota = object(await requestGoogleCodeAssist({ ...request, endpoint, method: 'retrieveUserQuota', body: { project } }));
      if (!Array.isArray(quota?.buckets)) return malformed('model_quota_without_buckets');
      meters = quota.buckets.map(value => {
        const bucket = object(value);
        const modelId = text(bucket?.modelId);
        if (!bucket || !modelId) return malformed('model_bucket_without_model');
        const tokenType = text(bucket.tokenType);
        const quotaType = tokenType === 'TOKEN_TYPE_UNSPECIFIED' ? null : tokenType;
        // BucketInfo identifies request and weighted-token allowances independently.
        const bucketId = quotaType ? `model:${JSON.stringify([modelId, quotaType])}` : `model:${modelId}`;
        const displayName = [modelId, quotaType === 'REQUESTS' ? 'Requests' : quotaType].filter(Boolean).join(' · ');
        return meter({ ...bucket, bucketId, displayName }, null, modelId);
      });
    }
    return snapshot(meters);
  } };
}
export const agyQuotaFetcherDescriptor: ConnectedServiceQuotaFetcherDescriptor = { loadQuota: ({ staleAfterMs }) => createAgyQuotaFetcher({ staleAfterMs }) };
