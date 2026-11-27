import { ConnectedServiceQuotaSnapshotV1Schema, type ConnectedServiceQuotaMeterV1 } from '@happier-dev/protocol';
import { ConnectedServiceQuotaFetchError, type ConnectedServiceQuotaFetcher, type ConnectedServiceQuotaFetcherDescriptor } from '@/daemon/connectedServices/quotas/types';
import { requestGoogleCodeAssist, type GoogleCodeAssistFetchRuntime } from '@/daemon/connectedServices/quotas/googleCodeAssistRequest';
import { readConnectedServiceQuotaStaleAfterMs } from '@/daemon/connectedServices/quotas/configuration';
import { delayUnrefAbortable } from '@/utils/time';

// The Antigravity ACP 1.3.0 useragent.py client surface. Without this product token Google returns
// UNSUPPORTED_CLIENT instead of the entitlement (re-observed 2026-11-27 against prod and daily while
// agy 1.5.18 was current). It describes these control-plane requests, not a runtime.
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

/** Code Assist reports an account Google must verify as an ineligible tier with this reason code. */
function awaitsGoogleValidation(load: Record<string, unknown> | null): boolean {
  return Array.isArray(load?.ineligibleTiers) && load.ineligibleTiers.some(tier => object(tier)?.reasonCode === 'VALIDATION_REQUIRED');
}

function assignedProject(load: Record<string, unknown> | null): string | null {
  return text(load?.cloudaicompanionProject) ?? text(object(load?.cloudaicompanionProject)?.id);
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

const ONBOARDING_ENDPOINT = 'https://daily-cloudcode-pa.googleapis.com';
// Upstream onboarding exposes an operation resource, not events; match its one-second poll. The
// quota fetch's own deadline/abort signal bounds the wait.
const ONBOARDING_POLL_INTERVAL_MS = 1000;

async function onboardFreeTier(request: Readonly<{ fetchRuntime: GoogleCodeAssistFetchRuntime; accessToken: string; userAgent: string; signal: AbortSignal }>): Promise<void> {
  let operation = object(await requestGoogleCodeAssist({ ...request, endpoint: ONBOARDING_ENDPOINT, method: 'onboardUser',
    body: { tierId: 'free-tier', metadata: { ideType: 'ANTIGRAVITY' } } }));
  while (operation?.done !== true) {
    const name = text(operation?.name);
    if (!name) return malformed('onboarding_operation_without_name');
    await delayUnrefAbortable(ONBOARDING_POLL_INTERVAL_MS, request.signal);
    request.signal.throwIfAborted();
    operation = object(await requestGoogleCodeAssist({ ...request, endpoint: ONBOARDING_ENDPOINT, method: 'operation', operationName: name }));
  }
  // The provider's error text may carry account details; only the fixed code is surfaced.
  if (object(operation.error)) throw new ConnectedServiceQuotaFetchError('antigravity_onboarding_failed', { quotaFetchErrorCode: 'provider_backoff' });
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
    const loadEntitlement = async () => object(await requestGoogleCodeAssist({ ...request, endpoint: 'https://cloudcode-pa.googleapis.com', method: 'loadCodeAssist',
      body: { metadata: { ideType: 'ANTIGRAVITY' }, ...(explicitProject ? { cloudaicompanionProject: explicitProject } : {}) } }));
    let load = await loadEntitlement();
    const offersFreeTier = (value: Record<string, unknown> | null) =>
      Array.isArray(value?.allowedTiers) && value.allowedTiers.some(tier => object(tier)?.id === 'free-tier');
    if (!object(load?.currentTier) && awaitsGoogleValidation(load)) {
      // Google must verify the account first (agy shows "Verification required"). Onboarding cannot
      // proceed and this is not a malformed response; the provider's link and text are not copied.
      throw new ConnectedServiceQuotaFetchError('antigravity_validation_required', {
        quotaFetchErrorCode: 'provider_backoff', providerCode: 'antigravity_validation_required' });
    }
    if (!object(load?.currentTier) && offersFreeTier(load)) {
      // Never onboarded: native agy onboards on its first run, and an account connected through
      // Happier may not have run agy yet. Same Code Assist login contract as native agy and 0.3's
      // discoverAntigravityProject: onboard the free tier (a paid plan stays the account's
      // paidTier), poll the operation, then load the assigned project. Google keeps the result, so
      // every later loadCodeAssist returns the project and this runs once per account.
      await onboardFreeTier(request);
      load = await loadEntitlement();
      if (!object(load?.currentTier) || !assignedProject(load)) return malformed(`onboarded_without_project:${describeEntitlement(load)}`);
    }
    const project = explicitProject ?? assignedProject(load);
    const planLabel = text(object(load?.paidTier)?.name) ?? text(object(load?.currentTier)?.name);
    const snapshot = (meters: ConnectedServiceQuotaMeterV1[]) => ConnectedServiceQuotaSnapshotV1Schema.parse({ v: 1, serviceId: 'antigravity',
      profileId: record.profileId, fetchedAt: now, staleAfterMs: deps.staleAfterMs ?? readConnectedServiceQuotaStaleAfterMs(process.env),
      planLabel, accountLabel: record.oauth.providerEmail ?? record.oauth.providerAccountId, meters });
    if (!project || !object(load?.currentTier)) {
      // A current tier awaiting a user-defined project has no quota to read yet: unknown, never
      // exhausted. An unidentified client is offered no free tier and is not onboarded.
      return object(load?.currentTier) ? snapshot([]) : malformed(`no_project_or_tier:${describeEntitlement(load)}`);
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
