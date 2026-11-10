import { QuotaFetchError, type ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { ANTIGRAVITY_CONTROL_PLANE_USER_AGENT, readAntigravityProjectId } from './client.js';

type Context = Parameters<NonNullable<ConnectedAccountRuntime['quota']>>[0];
type Limit = Awaited<ReturnType<NonNullable<ConnectedAccountRuntime['quota']>>>['limits'][number];
function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function text(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function number(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}
function malformed(): never { throw new QuotaFetchError('antigravity_quota_malformed', { quotaFetchErrorCode: 'malformed' }); }
async function request(context: Context, accessToken: string, endpoint: string, method: string, body: unknown): Promise<unknown> {
  let response: Awaited<ReturnType<Context['services']['http']['request']>>;
  try {
    response = await context.services.http.request({ url: `${endpoint}/v1internal:${method}`, method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'User-Agent': ANTIGRAVITY_CONTROL_PLANE_USER_AGENT },
      body: new TextEncoder().encode(JSON.stringify(body)), redirect: 'error' }, { signal: context.signal });
  } catch (error) {
    if (context.signal.aborted) throw error;
    throw new QuotaFetchError('antigravity_quota_network_failed', { quotaFetchErrorCode: 'network' });
  }
  if (response.status < 200 || response.status >= 300) {
    const retryAfter = response.headers['retry-after'];
    const seconds = retryAfter ? Number(retryAfter) : Number.NaN;
    throw new QuotaFetchError(`antigravity_quota_${method}_failed`, { status: response.status,
      quotaFetchErrorCode: response.status === 401 ? 'auth_failure' : 'provider_backoff',
      retryAfterMs: Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null });
  }
  try { return JSON.parse(new TextDecoder().decode(response.body)) as unknown; }
  catch { return malformed(); }
}
function limit(value: unknown, groupName: string | null, modelId?: string): Limit {
  const bucket = object(value);
  const id = text(bucket?.bucketId);
  if (!bucket || !id) return malformed();
  const fraction = number(bucket.remainingFraction);
  if (fraction !== null && fraction > 1) return malformed();
  const remaining = number(bucket.remainingAmount);
  const capacity = remaining !== null && fraction !== null && fraction > 0 ? remaining / fraction : null;
  const resetText = text(bucket.resetTime);
  const reset = resetText ? Date.parse(resetText) : Number.NaN;
  const window = text(bucket.window);
  const disabled = bucket.disabled === true;
  const windowDurationMs = window === 'weekly' ? 604_800_000 : window === '5h' ? 18_000_000 : null;
  return { id, providerLimitId: id,
    ...(modelId ? { modelId, limitScope: 'model' as const } : { limitScope: 'account' as const }),
    scope: modelId ? 'model' : window === 'weekly' ? 'weekly' : window === '5h' ? 'five_hour' : 'unknown',
    ...(windowDurationMs ? { windowDurationMs } : {}),
    confidence: fraction === null && remaining === null ? 'unknown' : 'exact',
    label: [text(bucket.displayName) ?? groupName ?? id, window].filter(Boolean).join(' · '),
    used: capacity !== null && remaining !== null ? Math.max(0, capacity - remaining) : null,
    limit: capacity, remaining, remainingPct: fraction === null ? null : fraction * 100,
    utilizationPct: fraction === null ? null : (1 - fraction) * 100,
    isExhausted: !disabled && (fraction === 0 || remaining === 0),
    unit: modelId ? text(bucket.tokenType) === 'REQUESTS' ? 'requests' : 'unknown'
      : remaining === null ? 'unknown' : 'count',
    resetsAtMs: Number.isFinite(reset) && reset >= 0 ? reset : null,
    status: disabled || (fraction === null && remaining === null) ? 'unavailable' : 'ok',
    details: { ...(disabled ? { code: 'provider_disabled' } : {}), ...(window ? { rawScope: window } : {}),
      ...(text(bucket.description) ? { note: text(bucket.description) } : {}) } };
}
/** Quota-only reads of the ACP 1.3.0 entitlement and bundled CCPA summary contract. */
export const readAntigravityQuota: NonNullable<ConnectedAccountRuntime['quota']> = async context => {
  const accessToken = text(await context.credentials.get('accessToken'));
  if (!accessToken) throw new QuotaFetchError('missing_antigravity_access_token', { quotaFetchErrorCode: 'missing_auth' });
  const explicitProject = text(await context.credentials.get('projectId'));
  const load = object(await request(context, accessToken, 'https://cloudcode-pa.googleapis.com', 'loadCodeAssist',
    { metadata: { ideType: 'ANTIGRAVITY' }, ...(explicitProject ? { cloudaicompanionProject: explicitProject } : {}) }));
  const project = explicitProject ?? readAntigravityProjectId(load?.cloudaicompanionProject);
  if (!project || !object(load?.currentTier)) return malformed();
  // Entitlement reads never invoke onboarding or change the user's billing choice.
  const endpoint = object(load?.paidTier)?.usesGcpTos === true ? 'https://cloudcode-pa.googleapis.com' : 'https://daily-cloudcode-pa.googleapis.com';
  const response = object(await request(context, accessToken, endpoint, 'retrieveUserQuotaSummary', { project }));
  const summary = object(response?.quotaSummary) ?? response;
  let limits: Limit[];
  if (Array.isArray(summary?.groups)) {
    limits = summary.groups.flatMap(value => {
      const group = object(value);
      if (!group || (group.buckets !== undefined && !Array.isArray(group.buckets))) return malformed();
      return Array.isArray(group.buckets) ? group.buckets.map(bucket => limit(bucket, text(group.displayName))) : [];
    });
  } else if (Array.isArray(summary?.buckets)) {
    // Deprecated buckets remain an explicit provider-contract response shape.
    limits = summary.buckets.map(bucket => limit(bucket, null));
  } else return malformed();
  // Empty summaries can expose exact model meters through the provider quota endpoint.
  // Preserve identities: a quota for one model version is never another model's allowance.
  if (limits.length === 0) {
    const quota = object(await request(context, accessToken, endpoint, 'retrieveUserQuota', { project }));
    if (!Array.isArray(quota?.buckets)) return malformed();
    limits = quota.buckets.map(value => {
      const bucket = object(value);
      const modelId = text(bucket?.modelId);
      if (!bucket || !modelId) return malformed();
      const tokenType = text(bucket.tokenType);
      const quotaType = tokenType === 'TOKEN_TYPE_UNSPECIFIED' ? null : tokenType;
      const bucketId = quotaType ? `model:${JSON.stringify([modelId, quotaType])}` : `model:${modelId}`;
      const displayName = [modelId, quotaType === 'REQUESTS' ? 'Requests' : quotaType].filter(Boolean).join(' · ');
      return limit({ ...bucket, bucketId, displayName }, null, modelId);
    });
  }
  return { observedAtMs: Date.now(), planLabel: text(object(load?.paidTier)?.name) ?? text(object(load?.currentTier)?.name), limits };
};
