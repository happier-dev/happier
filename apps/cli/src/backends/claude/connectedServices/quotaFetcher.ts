import {
  readClaudeOauthCredentialMetadata,
  readClaudeOauthCredentialOrganizationId,
  type ConnectedServiceCredentialRecordV1,
  type ConnectedServiceQuotaMeterV1,
} from '@happier-dev/protocol';
import { createHash } from 'node:crypto';

import { resolveClaudeCodeUserAgent } from '@/backends/claude/utils/claudeCodeUserAgent';
import { claudeResetRequestId, parseClaudeQuotaResets } from './quotaResets';
import { logger } from '@/ui/logger';

import {
  fetchClaudeSubscriptionProfileContext,
  resolveMissingClaudeSubscriptionClaudeCodeScopes,
} from '@/daemon/connectedServices/descriptors/connectedAccountDescriptors';
import { isRecord, normalizePct, resolveConnectedServiceQuotaAccountLabel } from '@/daemon/connectedServices/quotas/quotaNormalization';
import { parseRetryAfterHeader } from '@/daemon/connectedServices/quotas/normalization';
import {
  ConnectedServiceQuotaFetchError,
  type ConnectedServiceQuotaFetcher,
  type ConnectedServiceQuotaFetcherDescriptor,
} from '@/daemon/connectedServices/quotas/types';

const DEFAULT_BETA_HEADER_VALUE = 'oauth-2025-04-20';
const DEFAULT_CLAUDE_SUBSCRIPTION_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

function parseNonEmptyStringEnv(raw: string | undefined): string | undefined {
  const trimmed = (raw ?? '').trim();
  return trimmed ? trimmed : undefined;
}

function parseDisableQuotaEndpointEnv(raw: string | undefined): boolean {
  const value = (raw ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

export const claudeSubscriptionQuotaFetcherDescriptor: ConnectedServiceQuotaFetcherDescriptor = {
  loadQuota: ({ env, staleAfterMs }) => createClaudeSubscriptionQuotaFetcher({
    usageUrl: parseNonEmptyStringEnv(
      env.HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_USAGE_URL
        ?? env.HAPPIER_CONNECTED_SERVICES_ANTHROPIC_USAGE_URL,
    ),
    staleAfterMs,
    userAgent: parseNonEmptyStringEnv(env.HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_USER_AGENT),
    disablePrivateEndpoint: parseDisableQuotaEndpointEnv(
      env.HAPPIER_CONNECTED_SERVICES_DISABLE_CLAUDE_SUBSCRIPTION_QUOTA_ENDPOINT,
    ),
  }),
};

function parseIsoDateMs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseResetAtMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }
  return parseIsoDateMs(value);
}

function resolveAccountLabel(record: ConnectedServiceCredentialRecordV1): string | null {
  return resolveConnectedServiceQuotaAccountLabel(record);
}

function resolveClaudeSubscriptionPlanLabel(record: ConnectedServiceCredentialRecordV1): string | null {
  if (record.kind !== 'oauth') return null;
  const metadata = readClaudeOauthCredentialMetadata(record.oauth.raw);
  return metadata?.subscriptionType ?? metadata?.rateLimitTier ?? null;
}

function buildCredentialBackoffKey(record: ConnectedServiceCredentialRecordV1): string | null {
  if (record.kind !== 'oauth') return null;
  const profileId = String(record.profileId ?? '').trim();
  if (!profileId) return null;
  const digest = createHash('sha256')
    .update(record.serviceId)
    .update('\0')
    .update(profileId)
    .update('\0')
    .update(record.oauth.accessToken)
    .digest('hex');
  return `${profileId}:${digest}`;
}

function createMissingClaudeCodeScopeQuotaError(): ConnectedServiceQuotaFetchError {
  return new ConnectedServiceQuotaFetchError(
    'Reconnect Claude in Happier before Claude Code quota can be used.',
    {
      status: 403,
      quotaFetchErrorCode: 'auth_failure',
      providerCode: 'missing_claude_code_scope',
      reconnectRequired: true,
    },
  );
}

function buildQuotaUnknownMeter(meterId: string, label: string): ConnectedServiceQuotaMeterV1 {
  return {
    meterId,
    label,
    used: null,
    limit: null,
    unit: 'unknown',
    utilizationPct: null,
    resetsAt: null,
    status: 'unavailable',
    details: { code: 'quota_unknown' },
  };
}

const WINDOW_LABELS: Readonly<Record<string, string>> = Object.freeze({
  five_hour: '5-hour',
  seven_day: 'Weekly',
  seven_day_oauth_apps: 'Weekly (OAuth apps)',
  seven_day_sonnet: 'Weekly (Sonnet)',
  seven_day_opus: 'Weekly (Opus)',
  iguana_necktie: 'Unknown',
});

const WINDOW_LABEL_PREFIXES: ReadonlyArray<Readonly<{
  prefix: string;
  label: string;
}>> = [
  { prefix: 'five_hour_', label: '5-hour' },
  { prefix: 'seven_day_', label: 'Weekly' },
];

const WINDOW_LABEL_TOKEN_OVERRIDES: Readonly<Record<string, string>> = Object.freeze({
  api: 'API',
  fable: 'Fable',
  mcp: 'MCP',
  oauth: 'OAuth',
  opus: 'Opus',
  sonnet: 'Sonnet',
});

const USAGE_WINDOW_CONTAINER_KEYS = new Set([
  'limits',
  'quota_limits',
  'quotaLimits',
  'quota_windows',
  'quotaWindows',
  'rate_limits',
  'rateLimits',
  'usage_limits',
  'usageLimits',
  'usage_windows',
  'usageWindows',
  'windows',
]);

const USAGE_WINDOW_ID_KEYS = [
  'meter_id',
  'meterId',
  'provider_limit_id',
  'providerLimitId',
  'limit_id',
  'limitId',
  'id',
  'key',
  'name',
  'rate_limit_type',
  'rateLimitType',
  'type',
] as const;

const USAGE_WINDOW_PROVIDER_LIMIT_ID_KEYS = [
  'provider_limit_id',
  'providerLimitId',
  'limit_id',
  'limitId',
  'id',
] as const;

const USAGE_WINDOW_WINDOW_KEYS = [
  'group',
  'window',
  'period',
  'scope',
  'quota_scope',
  'quotaScope',
  'limit_scope',
  'limitScope',
  'limit_window',
  'limitWindow',
] as const;

const USAGE_WINDOW_MODEL_KEYS = [
  'model',
  'model_id',
  'modelId',
  'model_family',
  'modelFamily',
  'family',
  'category',
  'limit_type',
  'limitType',
] as const;

const USAGE_WINDOW_UTILIZATION_KEYS = [
  'utilization',
  'utilization_pct',
  'utilizationPct',
  'percent',
  'usage_pct',
  'usagePct',
  'used_pct',
  'usedPct',
  'percent_used',
  'percentUsed',
  'percentage',
] as const;

const USAGE_WINDOW_REMAINING_KEYS = [
  'remaining_pct',
  'remainingPct',
  'percent_remaining',
  'percentRemaining',
] as const;

const USAGE_WINDOW_RESET_KEYS = [
  'resets_at',
  'resetsAt',
  'reset_at',
  'resetAt',
  'reset_at_ms',
  'resetAtMs',
  'resets_at_ms',
  'resetsAtMs',
] as const;

const USAGE_WINDOW_USED_KEYS = [
  'used',
  'used_credits',
  'usedCredits',
  'usage',
  'current',
] as const;

const USAGE_WINDOW_LIMIT_KEYS = [
  'limit',
  'max',
  'quota',
  'monthly_limit',
  'monthlyLimit',
] as const;

const GENERIC_USAGE_WINDOW_IDS = new Set([
  'limit',
  'limits',
  'quota',
  'quota_limit',
  'quota_limits',
  'quota_window',
  'quota_windows',
  'rate_limit',
  'rate_limits',
  'usage',
  'usage_limit',
  'usage_limits',
  'usage_window',
  'usage_windows',
  'window',
  'windows',
]);

const USAGE_WINDOW_SEGMENT_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ['five_hour', 'five_hour'],
  ['five_hours', 'five_hour'],
  ['5_hour', 'five_hour'],
  ['5_hours', 'five_hour'],
  ['5h', 'five_hour'],
  ['session', 'five_hour'],
  ['seven_day', 'seven_day'],
  ['seven_days', 'seven_day'],
  ['7_day', 'seven_day'],
  ['7_days', 'seven_day'],
  ['7d', 'seven_day'],
  ['weekly', 'seven_day'],
  ['week', 'seven_day'],
];

const QUOTA_UNITS = new Set<ConnectedServiceQuotaMeterV1['unit']>([
  'count',
  'tokens',
  'credits',
  'usd',
  'requests',
  'unknown',
]);

function formatWindowLabelSuffix(raw: string): string {
  return raw
    .split('_')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .map((part) => WINDOW_LABEL_TOKEN_OVERRIDES[part] ?? `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

/** Label for a Claude subscription usage window (`five_hour`, `seven_day_*`, …); null for other ids. */
export function resolveClaudeUsageWindowLabel(meterId: string): string | null {
  const known = WINDOW_LABELS[meterId];
  if (known) return known;
  for (const { prefix, label } of WINDOW_LABEL_PREFIXES) {
    if (meterId.startsWith(prefix)) {
      const suffix = formatWindowLabelSuffix(meterId.slice(prefix.length));
      return suffix ? `${label} (${suffix})` : label;
    }
  }
  return null;
}

function resolveUsageWindowLabel(meterId: string): string {
  return resolveClaudeUsageWindowLabel(meterId) ?? (formatWindowLabelSuffix(meterId) || meterId);
}

function readNonEmptyStringProperty(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function readScopedUsageWindowModel(record: Record<string, unknown>): string | null {
  const direct = readNonEmptyStringProperty(record, USAGE_WINDOW_MODEL_KEYS);
  if (direct) return direct;
  for (const key of USAGE_WINDOW_MODEL_KEYS) {
    const value = record[key];
    if (isRecord(value)) {
      const nested = readNonEmptyStringProperty(value, [
        'display_name',
        'displayName',
        'name',
        'id',
      ]);
      if (nested) return nested;
    }
  }
  const scope = isRecord(record.scope) ? record.scope : null;
  if (!scope) return null;
  const scopedModel = scope.model;
  if (typeof scopedModel === 'string' && scopedModel.trim()) {
    return scopedModel.trim();
  }
  if (isRecord(scopedModel)) {
    return readNonEmptyStringProperty(scopedModel, [
      'display_name',
      'displayName',
      'name',
      'id',
    ]);
  }
  return readNonEmptyStringProperty(scope, [
    'model_display_name',
    'modelDisplayName',
    'model_name',
    'modelName',
    'model_id',
    'modelId',
  ]);
}

function readScopedUsageWindowModelId(record: Record<string, unknown>): string | null {
  const direct = readNonEmptyStringProperty(record, ['model_id', 'modelId']);
  if (direct) return direct;
  const directModel = record.model;
  if (typeof directModel === 'string' && directModel.trim()) return directModel.trim();
  if (isRecord(directModel)) {
    const id = readNonEmptyStringProperty(directModel, ['id', 'model_id', 'modelId']);
    if (id) return id;
  }
  const scope = isRecord(record.scope) ? record.scope : null;
  if (!scope) return null;
  const scopedModel = scope.model;
  if (typeof scopedModel === 'string' && scopedModel.trim()) return scopedModel.trim();
  if (isRecord(scopedModel)) return readNonEmptyStringProperty(scopedModel, ['id', 'model_id', 'modelId']);
  return readNonEmptyStringProperty(scope, ['model_id', 'modelId']);
}

function readScopedUsageWindowModelDisplayName(record: Record<string, unknown>): string | null {
  const direct = readNonEmptyStringProperty(record, ['model_display_name', 'modelDisplayName', 'model_name', 'modelName']);
  if (direct) return direct;
  const directModel = record.model;
  if (isRecord(directModel)) {
    const displayName = readNonEmptyStringProperty(directModel, ['display_name', 'displayName', 'name']);
    if (displayName) return displayName;
  }
  const scope = isRecord(record.scope) ? record.scope : null;
  if (!scope) return null;
  const scopedModel = scope.model;
  if (isRecord(scopedModel)) {
    const displayName = readNonEmptyStringProperty(scopedModel, ['display_name', 'displayName', 'name']);
    if (displayName) return displayName;
  }
  return readNonEmptyStringProperty(scope, ['model_display_name', 'modelDisplayName', 'model_name', 'modelName']);
}

function readFiniteNumberProperty(
  record: Record<string, unknown>,
  keys: readonly string[],
): number | null {
  for (const key of keys) {
    const value = record[key];
    const numeric = typeof value === 'number' ? value : Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

function readPctProperty(record: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = normalizePct(record[key]);
    if (value !== null) return value;
  }
  return null;
}

function resolveUsageWindowUtilizationPct(window: Record<string, unknown> | null): number | null {
  if (!window) return null;
  const utilizationPct = readPctProperty(window, USAGE_WINDOW_UTILIZATION_KEYS);
  if (utilizationPct !== null) return utilizationPct;
  const remainingPct = readPctProperty(window, USAGE_WINDOW_REMAINING_KEYS);
  if (remainingPct !== null) return Math.max(0, Math.min(100, 100 - remainingPct));
  const used = readFiniteNumberProperty(window, USAGE_WINDOW_USED_KEYS);
  const limit = readFiniteNumberProperty(window, USAGE_WINDOW_LIMIT_KEYS);
  if (used !== null && limit !== null && limit > 0) {
    return Math.max(0, Math.min(100, (used / limit) * 100));
  }
  return null;
}

function resolveUsageWindowResetAtMs(window: Record<string, unknown> | null): number | null {
  if (!window) return null;
  for (const key of USAGE_WINDOW_RESET_KEYS) {
    const parsed = parseResetAtMs(window[key]);
    if (parsed !== null) return parsed;
  }
  return null;
}

function normalizeUsageWindowSegment(value: string | null | undefined): string | null {
  const normalized = (value ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
  return normalized ? normalized : null;
}

function canonicalizeUsageWindowSegment(segment: string | null): string | null {
  if (!segment) return null;
  return USAGE_WINDOW_SEGMENT_ALIASES.find(([alias]) => alias === segment)?.[1] ?? segment;
}

function canonicalizeUsageWindowMeterId(meterId: string | null): string | null {
  if (!meterId) return null;
  for (const [alias, canonical] of USAGE_WINDOW_SEGMENT_ALIASES) {
    if (meterId === alias) return canonical;
    if (meterId.startsWith(`${alias}_`)) {
      return `${canonical}_${meterId.slice(alias.length + 1)}`;
    }
  }
  return meterId;
}

function isGenericUsageWindowId(value: string): boolean {
  return GENERIC_USAGE_WINDOW_IDS.has(value);
}

function deriveUsageWindowMeterId(
  fallbackKey: string | null,
  record: Record<string, unknown>,
): string | null {
  const windowSegment = canonicalizeUsageWindowSegment(
    normalizeUsageWindowSegment(readNonEmptyStringProperty(record, USAGE_WINDOW_WINDOW_KEYS)),
  );
  const modelSegment = normalizeUsageWindowSegment(readScopedUsageWindowModel(record));
  const explicitSegment = canonicalizeUsageWindowMeterId(
    normalizeUsageWindowSegment(readNonEmptyStringProperty(record, USAGE_WINDOW_ID_KEYS))
      ?? normalizeUsageWindowSegment(fallbackKey),
  );

  if (windowSegment && modelSegment && !isGenericUsageWindowId(modelSegment)) {
    return `${windowSegment}_${modelSegment}`;
  }
  if (windowSegment && explicitSegment && !isGenericUsageWindowId(explicitSegment)) {
    if (explicitSegment === windowSegment || explicitSegment.startsWith(`${windowSegment}_`)) {
      return explicitSegment;
    }
    return `${windowSegment}_${explicitSegment}`;
  }
  if (windowSegment) {
    return windowSegment;
  }
  if (explicitSegment && !isGenericUsageWindowId(explicitSegment)) {
    return explicitSegment;
  }
  return null;
}

function isUsageWindowRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  return resolveUsageWindowUtilizationPct(value) !== null || resolveUsageWindowResetAtMs(value) !== null;
}

function resolveUsageWindowUnit(window: Record<string, unknown> | null): ConnectedServiceQuotaMeterV1['unit'] {
  const raw = typeof window?.unit === 'string' ? window.unit.trim().toLowerCase() : '';
  return QUOTA_UNITS.has(raw as ConnectedServiceQuotaMeterV1['unit'])
    ? raw as ConnectedServiceQuotaMeterV1['unit']
    : 'unknown';
}

function buildUsageWindowMeter(
  meterId: string,
  window: Record<string, unknown> | null,
): ConnectedServiceQuotaMeterV1 {
  const utilizationPct = resolveUsageWindowUtilizationPct(window);
  const used = window ? readFiniteNumberProperty(window, USAGE_WINDOW_USED_KEYS) : null;
  const limit = window ? readFiniteNumberProperty(window, USAGE_WINDOW_LIMIT_KEYS) : null;
  const providerLimitId = window
    ? readNonEmptyStringProperty(window, USAGE_WINDOW_PROVIDER_LIMIT_ID_KEYS) ?? meterId
    : meterId;
  const modelId = window ? readScopedUsageWindowModelId(window) : null;
  const modelDisplayName = window ? readScopedUsageWindowModelDisplayName(window) : null;
  const rawKind = window ? readNonEmptyStringProperty(window, ['kind', 'type']) : null;
  return {
    meterId,
    label: resolveUsageWindowLabel(meterId),
    ...(meterId === 'seven_day' || meterId.startsWith('seven_day_') ? { windowDurationMs: 604_800_000 }
      : meterId === 'five_hour' || meterId.startsWith('five_hour_') ? { windowDurationMs: 18_000_000 } : {}),
    used,
    limit,
    unit: resolveUsageWindowUnit(window),
    utilizationPct,
    providerLimitId,
    ...(modelId ? { modelId } : {}),
    resetsAt: resolveUsageWindowResetAtMs(window),
    status: utilizationPct === null ? 'unavailable' : 'ok',
    details: {
      ...(rawKind ? { rawScope: rawKind } : {}),
      ...(modelDisplayName ? { modelDisplayName } : {}),
    },
  };
}

function collectUsageWindowMeterEntries(
  data: Record<string, unknown>,
): ReadonlyArray<Readonly<{
  meterId: string;
  window: Record<string, unknown> | null;
}>> {
  const windowsByMeterId = new Map<string, Record<string, unknown> | null>();
  const setWindow = (meterId: string | null, window: Record<string, unknown> | null): void => {
    if (!meterId) return;
    const existing = windowsByMeterId.get(meterId);
    if (existing && window) return;
    windowsByMeterId.set(meterId, window);
  };

  for (const meterId of Object.keys(WINDOW_LABELS)) {
    setWindow(meterId, isRecord(data[meterId]) ? data[meterId] : null);
  }

  const visitContainer = (value: unknown, depth: number): void => {
    if (depth > 3) return;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (!isRecord(item)) continue;
        if (isUsageWindowRecord(item)) {
          setWindow(deriveUsageWindowMeterId(null, item), item);
          continue;
        }
        visitContainer(item, depth + 1);
      }
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (isUsageWindowRecord(child)) {
        setWindow(deriveUsageWindowMeterId(key, child), child);
        continue;
      }
      if (USAGE_WINDOW_CONTAINER_KEYS.has(key)) {
        visitContainer(child, depth + 1);
      }
    }
  };

  for (const [key, value] of Object.entries(data)) {
    if (key === 'extra_usage') continue;
    if (isUsageWindowRecord(value)) {
      setWindow(deriveUsageWindowMeterId(key, value), value);
      continue;
    }
    if (USAGE_WINDOW_CONTAINER_KEYS.has(key)) {
      visitContainer(value, 1);
    }
  }
  return Array.from(windowsByMeterId, ([meterId, window]) => ({ meterId, window }));
}

export function createClaudeSubscriptionQuotaFetcher(params?: Readonly<{
  usageUrl?: string;
  betaHeaderValue?: string;
  staleAfterMs?: number;
  userAgent?: string;
  nowMs?: () => number;
  /**
   * When true, skip the private Anthropic OAuth usage endpoint and return a
   * quota_unknown snapshot. A custom usageUrl takes precedence over this flag.
   */
  disablePrivateEndpoint?: boolean;
}>): ConnectedServiceQuotaFetcher {
  const usageUrl = typeof params?.usageUrl === 'string' && params.usageUrl.trim()
    ? params.usageUrl.trim()
    : DEFAULT_CLAUDE_SUBSCRIPTION_USAGE_URL;
  const disablePrivateEndpoint = params?.disablePrivateEndpoint === true
    && usageUrl === DEFAULT_CLAUDE_SUBSCRIPTION_USAGE_URL;
  const betaHeaderValue = params?.betaHeaderValue ?? DEFAULT_BETA_HEADER_VALUE;
  const staleAfterMs =
    typeof params?.staleAfterMs === 'number' && Number.isFinite(params.staleAfterMs)
      ? Math.max(1, Math.trunc(params.staleAfterMs))
      : 300_000;
  const userAgent = resolveClaudeCodeUserAgent(params?.userAgent);
  const nowMs = params?.nowMs ?? (() => Date.now());
  const retryAfterBackoffByCredentialKey = new Map<string, number>();
  const providerBackoffCredentialKeys = new Set<string>();
  const resetUsageUrl = new URL(usageUrl);
  resetUsageUrl.searchParams.set('cedar_ember', '1');
  resetUsageUrl.searchParams.set('at_wall', '1');
  resetUsageUrl.searchParams.set('skip_spend', '1');

  function observeRateLimit(response: Response, record: ConnectedServiceCredentialRecordV1, now: number): void {
    const key = buildCredentialBackoffKey(record);
    if (!key || response.status !== 429) return;
    const retryAfter = parseRetryAfterHeader(response.headers?.get?.('retry-after'), { nowMs: nowMs() });
    retryAfterBackoffByCredentialKey.set(key, now + Math.max(15 * 60_000, retryAfter.retryAfterMs ?? 5 * 60_000));
    providerBackoffCredentialKeys.add(key);
  }

  async function fetchProfileContext(record: Extract<ConnectedServiceCredentialRecordV1, { kind: 'oauth' }>, now: number, signal: AbortSignal) {
    return await fetchClaudeSubscriptionProfileContext({
      accessToken: record.oauth.accessToken,
      expectedProviderAccountId: record.oauth.providerAccountId,
      profileUrl: new URL('./profile', usageUrl).toString(),
      signal,
      fetcher: async (url, init) => {
        const headers = new Headers(init?.headers);
        headers.set('User-Agent', userAgent);
        headers.set('anthropic-beta', betaHeaderValue);
        const response = await fetch(url, { ...init, headers });
        observeRateLimit(response, record, now);
        return response;
      },
    });
  }

  async function discoverResets(record: ConnectedServiceCredentialRecordV1, now: number, signal: AbortSignal) {
    if (record.kind !== 'oauth') return undefined;
    const response = await fetchUsage({ usageUrl: resetUsageUrl.toString(), accessToken: record.oauth.accessToken,
      betaHeaderValue, userAgent, signal });
    observeRateLimit(response, record, now);
    if (!response.ok) await throwUsageError(response);
    const payload: unknown = await response.json();
    return { inventory: parseClaudeQuotaResets(payload, now), payload };
  }

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
    if (response.status === 401) {
      throw new ConnectedServiceQuotaFetchError(
        'Anthropic usage fetch failed (401): reconnect Claude in Happier and retry.',
        { status: 401, quotaFetchErrorCode: 'auth_failure' },
      );
    }
    if (response.status === 403) {
      const scopeMatch = body.match(/scope requirement\s+([a-z0-9:_-]+)/i);
      const requiredScope = scopeMatch?.[1] ? String(scopeMatch[1]).trim() : '';
      if (requiredScope) {
        throw createMissingClaudeCodeScopeQuotaError();
      }
    }
    throw new Error(`Anthropic usage fetch failed (${response.status}): ${response.statusText}`);
  }

  return {
    serviceId: 'claude-subscription',
    pollPolicy: {
      minPollIntervalMs: 30 * 60_000,
      retryAfterBackoffMinMs: 15 * 60_000,
    },
    consumeRecoveryCredit: async ({ record, now, idempotencyKey, providerCreditId, providerLimitIds, signal }) => {
      if (record.kind !== 'oauth' || disablePrivateEndpoint) return 'not_available';
      if (resolveMissingClaudeSubscriptionClaudeCodeScopes(record.oauth.scope).length > 0) {
        throw createMissingClaudeCodeScopeQuotaError();
      }
      const backoffKey = buildCredentialBackoffKey(record);
      if (backoffKey && providerBackoffCredentialKeys.has(backoffKey)
        && (retryAfterBackoffByCredentialKey.get(backoffKey) ?? 0) > now) return 'not_available';
      signal.throwIfAborted();
      const resets = await discoverResets(record, now, signal);
      const selected = resets?.inventory?.recoveryCredits.credits.find((credit) => credit.status === 'available'
        && (!providerCreditId || credit.providerCreditId === providerCreditId));
      if (!selected || !selected.providerCreditId) return 'not_available';
      if (providerLimitIds !== undefined) {
        const clears = resets?.inventory?.recoveryCreditDetails[selected.providerCreditId].appliesToProviderLimitIds ?? [];
        const freshMeters = isRecord(resets?.payload) ? collectUsageWindowMeterEntries(resets.payload)
          .map(({ meterId, window }) => buildUsageWindowMeter(meterId, window)) : [];
        const exhaustedIds = new Set(freshMeters.filter((meter) => meter.utilizationPct !== null && meter.utilizationPct >= 100)
          .map((meter) => meter.providerLimitId ?? meter.meterId));
        if (!providerLimitIds.some((id) => clears.includes(id) && exhaustedIds.has(id))) return 'not_available';
      }
      signal.throwIfAborted();
      const profile = await fetchProfileContext(record, now, signal);
      if (profile.status === 'rejected') {
        throw new ConnectedServiceQuotaFetchError('Claude reset profile authentication failed.', {
          status: profile.providerStatus, quotaFetchErrorCode: 'auth_failure',
        });
      }
      const organizationId = profile.status === 'accepted' ? readClaudeOauthCredentialOrganizationId(profile.raw) : null;
      if (!organizationId) throw new ConnectedServiceQuotaFetchError('Claude reset organization is unavailable.', { quotaFetchErrorCode: 'malformed' });
      const credentialOrganizationId = readClaudeOauthCredentialOrganizationId(record.oauth.raw);
      if (credentialOrganizationId && organizationId !== credentialOrganizationId) {
        throw new ConnectedServiceQuotaFetchError('Claude reset organization does not match the selected credential.', { quotaFetchErrorCode: 'malformed' });
      }
      const resetUrl = new URL(`/api/organizations/${encodeURIComponent(organizationId)}/reset_rate_limits`, usageUrl).toString();
      signal.throwIfAborted();
      let response: Response;
      try {
        response = await fetch(resetUrl, { method: 'POST', headers: {
          Authorization: `Bearer ${record.oauth.accessToken}`, Accept: 'application/json', 'Content-Type': 'application/json',
          'anthropic-beta': betaHeaderValue, 'User-Agent': userAgent },
          body: JSON.stringify(selected.providerResetType === 'cedar_ember'
            ? { program: 'cedar_ember', grant_id: selected.providerCreditId, request_id: claudeResetRequestId(idempotencyKey) }
            : { program: 'juniper_tide' }), signal });
      } catch {
        throw new ConnectedServiceQuotaFetchError('Claude reset outcome is unknown after a transport failure.', {
          quotaFetchErrorCode: 'network', recoveryCreditConsumeOutcomeUnknown: true });
      }
      observeRateLimit(response, record, now);
      if (!response.ok) {
        throw new ConnectedServiceQuotaFetchError('Claude reset request failed.', {
          status: response.status, quotaFetchErrorCode: response.status === 401 || response.status === 403 ? 'auth_failure' : 'provider_backoff',
          recoveryCreditConsumeOutcomeUnknown: response.status >= 500 || (response.status !== 401 && response.status !== 403 && response.status !== 429),
        });
      }
      let result: unknown;
      try { result = await response.json(); } catch { result = null; }
      if (!isRecord(result) || (result.reason !== undefined && result.reason !== null && typeof result.reason !== 'string')
        || (result.cleared !== undefined && (!Array.isArray(result.cleared) || result.cleared.some((id) => typeof id !== 'string')))) {
        throw new ConnectedServiceQuotaFetchError('Claude reset response is malformed.', {
          quotaFetchErrorCode: 'malformed', recoveryCreditConsumeOutcomeUnknown: true });
      }
      if (result.result === 'reset') {
        if (backoffKey && !providerBackoffCredentialKeys.has(backoffKey)) retryAfterBackoffByCredentialKey.delete(backoffKey);
        return 'consumed';
      }
      if (result.result === 'already_used') return 'already_consumed';
      if (result.result === 'not_limited') return 'nothing_to_reset';
      if (result.result === 'ineligible' || result.result === 'unavailable' || result.result === 'cooldown') return 'not_available';
      throw new ConnectedServiceQuotaFetchError('Claude reset returned an unknown outcome.', {
        quotaFetchErrorCode: 'malformed', recoveryCreditConsumeOutcomeUnknown: true });
    },
    fetch: async ({ record, now, signal }) => {
      if (record.kind !== 'oauth') return null;
      const planLabel = resolveClaudeSubscriptionPlanLabel(record);
      const providerAccountId = record.oauth.providerAccountId?.trim() || null;
      const providerOrganizationId = readClaudeOauthCredentialOrganizationId(record.oauth.raw);
      if (resolveMissingClaudeSubscriptionClaudeCodeScopes(record.oauth.scope).length > 0) {
        throw createMissingClaudeCodeScopeQuotaError();
      }
      if (disablePrivateEndpoint) {
        return {
          v: 1,
          serviceId: record.serviceId,
          profileId: record.profileId,
          providerId: 'claude',
          ...(providerAccountId ? { activeAccountId: providerAccountId } : {}),
          ...(providerOrganizationId ? { providerOrganizationId } : {}),
          fetchedAt: now,
          staleAfterMs,
          planLabel,
          accountLabel: resolveAccountLabel(record),
          meters: Object.entries(WINDOW_LABELS).map(([meterId, label]) =>
            buildQuotaUnknownMeter(meterId, label),
          ),
        };
      }
      const backoffKey = buildCredentialBackoffKey(record);
      const backoffUntil = backoffKey ? (retryAfterBackoffByCredentialKey.get(backoffKey) ?? 0) : 0;
      if (backoffUntil > now) {
        return null;
      }
      if (backoffKey) providerBackoffCredentialKeys.delete(backoffKey);
      if (backoffKey) {
        retryAfterBackoffByCredentialKey.set(backoffKey, now + 15 * 60_000);
      }

      let response = await fetchUsage({
        usageUrl,
        accessToken: record.oauth.accessToken,
        betaHeaderValue,
        userAgent,
        signal,
      });

      if (!response.ok && response.status === 429) {
        observeRateLimit(response, record, now);
        return null;
      }

      if (!response.ok && response.status >= 500 && response.status < 600) {
        response = await fetchUsage({
          usageUrl,
          accessToken: record.oauth.accessToken,
          betaHeaderValue,
          userAgent,
          signal,
        });
      }

      if (!response.ok) await throwUsageError(response);

      const json: unknown = await response.json();
      const data = isRecord(json) ? json : {};

      const meters: ConnectedServiceQuotaMeterV1[] = collectUsageWindowMeterEntries(data)
        .map(({ meterId, window }) => buildUsageWindowMeter(meterId, window));

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
      let resetInventory: ReturnType<typeof parseClaudeQuotaResets>;
      try { resetInventory = (await discoverResets(record, now, signal))?.inventory; } catch {
        logger.infoFile('[WARN] [Claude quota] Reset discovery failed; ordinary usage remains available.');
      }
      if (backoffKey && !providerBackoffCredentialKeys.has(backoffKey)) {
        retryAfterBackoffByCredentialKey.delete(backoffKey);
      }

      return {
        v: 1,
        serviceId: record.serviceId,
        profileId: record.profileId,
        providerId: 'claude',
        ...(providerAccountId ? { activeAccountId: providerAccountId } : {}),
        ...(providerOrganizationId ? { providerOrganizationId } : {}),
        fetchedAt: now,
        staleAfterMs,
        planLabel,
        accountLabel: resolveAccountLabel(record),
        meters,
        ...resetInventory,
      };
    },
  };
}
