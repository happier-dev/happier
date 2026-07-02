import {
  ConnectedServiceQuotaSnapshotV1Schema,
  type ConnectedServiceCredentialRecordV1,
  type ConnectedServiceQuotaMeterV1,
  type ConnectedServiceQuotaSnapshotV1,
} from '@happier-dev/protocol';

import type {
  ConnectedServiceProviderRuntimeAuthAdapter,
  ConnectedServiceRuntimeAuthFailureKind,
  ConnectedServiceRuntimeFailureClassification,
  ConnectedServiceRuntimeAuthTargetInput,
} from '@/daemon/connectedServices/runtimeAuth/types';
import {
  classifyProviderLimitEvidence,
  parseProviderResetAt,
  type ProviderLimitCategory,
} from '@/daemon/connectedServices/quotas/normalization';

const GEMINI_CODE_ASSIST_ENDPOINT = 'https://cloudcode-pa.googleapis.com';
const GEMINI_CODE_ASSIST_API_VERSION = 'v1internal';
const GEMINI_QUOTA_SNAPSHOT_STALE_AFTER_MS = 5 * 60 * 1000;

type FetchRuntime = (url: string, init: RequestInit) => Promise<Response>;

type RuntimeQuotaSnapshotStore = Readonly<{
  recordSnapshot(input: Readonly<{
    serviceId: string;
    groupId: string;
    profileId: string;
    snapshot: ConnectedServiceQuotaSnapshotV1;
  }>): void;
}>;

export type GeminiConnectedServiceRuntimeAuthAdapterDeps = Readonly<{
  fetchRuntime?: FetchRuntime;
  now?: () => number;
}>;

function readRecord(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readFiniteNumber(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function readCredentialRecord(input: ConnectedServiceRuntimeAuthTargetInput): ConnectedServiceCredentialRecordV1 | null {
  const selection = readRecord(input.selection);
  const record = readRecord(selection?.record);
  return record as ConnectedServiceCredentialRecordV1 | null;
}

function mapLimitCategoryToFailureKind(category: ProviderLimitCategory): ConnectedServiceRuntimeAuthFailureKind | null {
  if (category === 'usage_limit') return 'usage_limit';
  if (category === 'rate_limit') return 'rate_limit';
  if (category === 'capacity') return 'capacity';
  if (category === 'temporary_throttle') return 'temporary_throttle';
  if (category === 'auth_invalid') return 'auth_expired';
  if (category === 'plan_invalid') return 'plan';
  if (category === 'validation_failed') return 'validation';
  if (category === 'disabled') return 'account_disabled';
  return null;
}

function quotaScopeForLimitCategory(category: ProviderLimitCategory): 'account' | 'provider' {
  return category === 'capacity' ? 'provider' : 'account';
}

function hasStructuredProviderEvidence(value: unknown): boolean {
  const record = readRecord(value);
  if (!record || value instanceof Error) return false;
  return [
    record.code,
    record.type,
    record.reason,
    record.status,
    record.statusCode,
    record.status_code,
    record.error,
  ].some((field) => field !== undefined && field !== null);
}

function classifyGeminiRuntimeAuthFailure(
  input: Parameters<ConnectedServiceProviderRuntimeAuthAdapter['classifyRuntimeAuthFailure']>[0],
  nowMs: number,
): ConnectedServiceRuntimeFailureClassification | null {
  if (!hasStructuredProviderEvidence(input.error)) return null;
  const category = classifyProviderLimitEvidence(input.error);
  const kind = mapLimitCategoryToFailureKind(category);
  if (!kind) return null;

  const selection = readRecord(input.selection);
  const timing = parseProviderResetAt({
    nowMs,
    body: input.error,
  });
  const quotaScope = quotaScopeForLimitCategory(category);

  return {
    kind,
    limitCategory: category,
    serviceId: readString(selection?.serviceId) ?? 'gemini',
    profileId: readString(selection?.activeProfileId ?? selection?.profileId),
    groupId: readString(selection?.groupId),
    resetsAtMs: timing.resetAtMs,
    retryAfterMs: timing.retryAfterMs,
    quotaScope,
    planType: null,
    rateLimits: {
      limitCategory: category,
      quotaScope,
      resetAtMs: timing.resetAtMs,
      retryAfterMs: timing.retryAfterMs,
    },
    source: 'structured_provider_error',
  };
}

function readRuntimeQuotaSnapshotStore(value: unknown): RuntimeQuotaSnapshotStore | null {
  const record = readRecord(value);
  return record && typeof record.recordSnapshot === 'function'
    ? {
        recordSnapshot: (record.recordSnapshot as RuntimeQuotaSnapshotStore['recordSnapshot']).bind(record),
      }
    : null;
}

function readResetAtMs(value: unknown): number | null {
  const text = readString(value);
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function buildCodeAssistUrl(method: string): string {
  return `${GEMINI_CODE_ASSIST_ENDPOINT}/${GEMINI_CODE_ASSIST_API_VERSION}:${method}`;
}

async function requestGeminiCodeAssist(params: Readonly<{
  fetchRuntime: FetchRuntime;
  accessToken: string;
  method: 'loadCodeAssist' | 'retrieveUserQuota';
  body: unknown;
}>): Promise<unknown> {
  const response = await params.fetchRuntime(buildCodeAssistUrl(params.method), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${params.accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(params.body),
  });
  if (!response.ok) {
    throw new Error(`gemini_code_assist_${params.method}_failed:${response.status}`);
  }
  return await response.json() as unknown;
}

function resolveQuotaProject(loadCodeAssistResponse: unknown): string | null {
  return readString(readRecord(loadCodeAssistResponse)?.cloudaicompanionProject);
}

function buildMeter(bucket: unknown): ConnectedServiceQuotaMeterV1 | null {
  const record = readRecord(bucket);
  if (!record) return null;
  const modelId = readString(record.modelId);
  const remainingFraction = readFiniteNumber(record.remainingFraction);
  if (!modelId || remainingFraction === null) return null;

  const remainingAmount = readFiniteNumber(record.remainingAmount);
  const normalizedLimit = 100;
  const limit = remainingAmount !== null && remainingFraction > 0
    ? Math.round(remainingAmount / remainingFraction)
    : normalizedLimit;
  const remaining = remainingAmount !== null
    ? Math.max(0, Math.min(limit, remainingAmount))
    : Math.round(clampPercent(remainingFraction * normalizedLimit));
  const used = Math.max(0, limit - remaining);
  const utilizationPct = clampPercent((1 - remainingFraction) * 100);

  return {
    meterId: modelId,
    label: modelId,
    used,
    limit,
    unit: remainingAmount !== null ? 'count' : 'unknown',
    utilizationPct,
    resetsAt: readResetAtMs(record.resetTime),
    status: 'ok',
    details: {},
  };
}

function mapGeminiQuotaResponseToSnapshot(params: Readonly<{
  profileId: string;
  fetchedAt: number;
  quotaResponse: unknown;
}>): ConnectedServiceQuotaSnapshotV1 {
  const buckets = readRecord(params.quotaResponse)?.buckets;
  const meters = Array.isArray(buckets)
    ? buckets.map(buildMeter).filter((meter): meter is ConnectedServiceQuotaMeterV1 => meter !== null)
    : [];

  return ConnectedServiceQuotaSnapshotV1Schema.parse({
    v: 1,
    serviceId: 'gemini',
    profileId: params.profileId,
    fetchedAt: Math.max(0, Math.trunc(params.fetchedAt)),
    staleAfterMs: GEMINI_QUOTA_SNAPSHOT_STALE_AFTER_MS,
    planLabel: null,
    accountLabel: null,
    meters,
  });
}

export function createGeminiConnectedServiceRuntimeAuthAdapter(
  deps: GeminiConnectedServiceRuntimeAuthAdapterDeps = {},
): ConnectedServiceProviderRuntimeAuthAdapter {
  const fetchRuntime = deps.fetchRuntime ?? fetch;
  const now = deps.now ?? Date.now;

  return {
    classifyRuntimeAuthFailure(input) {
      return classifyGeminiRuntimeAuthFailure(input, now());
    },
    async materializeActiveProfile() {
      return { supported: true };
    },
    canHotApply() {
      return { supported: false, recovery: 'restart_rematerialize' };
    },
    async hotApply() {
      return { applied: false, reason: 'hot_apply_unsupported' };
    },
    async recoverAfterRuntimeAuthSwitch() {
      return { recovered: false, recovery: 'restart_rematerialize' };
    },
    async verifyActiveAccount() {
      return { status: 'verified', reason: 'provider_restart_rematerialization_authoritative' };
    },
    async probeQuota(input) {
      const record = readCredentialRecord(input);
      if (!record || record.serviceId !== 'gemini' || record.kind !== 'oauth' || !record.oauth?.accessToken) {
        return { status: 'unsupported', reason: 'missing_gemini_oauth_record' };
      }

      let quotaSnapshot: ConnectedServiceQuotaSnapshotV1;
      try {
        const loadCodeAssistResponse = await requestGeminiCodeAssist({
          fetchRuntime,
          accessToken: record.oauth.accessToken,
          method: 'loadCodeAssist',
          body: { metadata: {} },
        });
        const project = resolveQuotaProject(loadCodeAssistResponse);
        if (!project) {
          return { status: 'unsupported', reason: 'gemini_code_assist_project_unavailable' };
        }

        const quotaResponse = await requestGeminiCodeAssist({
          fetchRuntime,
          accessToken: record.oauth.accessToken,
          method: 'retrieveUserQuota',
          body: { project },
        });
        quotaSnapshot = mapGeminiQuotaResponseToSnapshot({
          profileId: record.profileId,
          fetchedAt: now(),
          quotaResponse,
        });
      } catch {
        return { status: 'unsupported', reason: 'gemini_code_assist_request_failed' };
      }
      const selection = readRecord(input.selection);
      const groupId = readString(selection?.groupId);
      const runtimeQuotaSnapshots = readRuntimeQuotaSnapshotStore(selection?.runtimeQuotaSnapshots);
      if (groupId && runtimeQuotaSnapshots) {
        runtimeQuotaSnapshots.recordSnapshot({
          serviceId: 'gemini',
          groupId,
          profileId: record.profileId,
          snapshot: quotaSnapshot,
        });
      }
      return {
        status: 'available',
        quotaSnapshot,
      };
    },
    async refreshActiveProfile() {
      return { status: 'unsupported' };
    },
  };
}
