export type AgentAccountUsageRecordKey = Readonly<{
  providerId: string;
  accountSubjectId: string;
  subjectKind:
    | 'account'
    | 'workspace'
    | 'organization'
    | 'tenant'
    | 'subscription'
    | 'project'
    | 'modelFamily'
    | 'unknown';
  quotaScope:
    | 'account'
    | 'workspace'
    | 'organization'
    | 'project'
    | 'model'
    | 'provider'
    | 'unknown';
  quotaScopeId?: string;
}>;

type AgentAccountUsageQuotaSource =
  | 'provider_api'
  | 'background_fetch'
  | 'runtime_event'
  | 'runtime_probe'
  | 'in_band_snapshot'
  | 'in_band_provider_snapshot'
  | 'manual_refresh'
  | 'user_probe'
  | 'cached'
  | 'unknown';

type AgentAccountUsageQuotaConfidence =
  | 'exact'
  | 'derived'
  | 'estimated'
  | 'stale'
  | 'unknown';

type AgentAccountUsageRecoveryCredit = Readonly<{
  id?: string;
  kind: 'usage_limit_reset' | 'rate_limit_reset' | 'quota_reset' | 'unknown';
  status:
    | 'available'
    | 'redeeming'
    | 'redeemed'
    | 'expired'
    | 'unavailable'
    | 'unknown';
  providerResetType?: string;
  appliesToProviderLimitId?: string | null;
  grantedAtMs?: number | null;
  expiresAtMs?: number | null;
  redeemStartedAtMs?: number | null;
  redeemedAtMs?: number | null;
  title?: string | null;
  description?: string | null;
}>;

type AgentAccountUsageRecoveryCredits = Readonly<{
  availableCount: number;
  totalCount?: number;
  nextExpiresAtMs?: number | null;
  source?: AgentAccountUsageQuotaSource;
  confidence?: AgentAccountUsageQuotaConfidence;
  credits: AgentAccountUsageRecoveryCredit[];
}>;

type AgentAccountUsageMeter = Readonly<{
  meterId: string;
  label: string;
  used: number | null;
  limit: number | null;
  remaining?: number | null;
  remainingPct?: number | null;
  usedPct?: number | null;
  resetAtMs?: number | null;
  resetSource?:
    | 'header'
    | 'body'
    | 'provider_event'
    | 'provider_probe'
    | 'in_band_snapshot'
    | 'computed'
    | 'provider'
    | 'retry_after'
    | 'manual'
    | 'unknown';
  providerLimitId?: string;
  modelId?: string | null;
  isExhausted?: boolean;
  isSoftLimited?: boolean;
  isCapacityLimited?: boolean;
  unit: 'count' | 'tokens' | 'credits' | 'usd' | 'requests' | 'unknown';
  utilizationPct: number | null;
  resetsAt: number | null;
  status: 'ok' | 'unavailable' | 'estimated';
  source?: AgentAccountUsageQuotaSource;
  scope?:
    | 'primary'
    | 'secondary'
    | 'daily'
    | 'weekly'
    | 'monthly'
    | 'five_hour'
    | 'seven_day'
    | 'session'
    | 'rolling'
    | 'model'
    | 'requests'
    | 'tokens'
    | 'unknown';
  limitScope?:
    | 'account'
    | 'workspace'
    | 'organization'
    | 'model'
    | 'provider'
    | 'session'
    | 'unknown';
  confidence?: AgentAccountUsageQuotaConfidence;
  details: Readonly<{
    note?: string | null;
    code?: string;
    rawScope?: string;
    remainingPct?: number | null;
    scope?: AgentAccountUsageMeter['scope'];
    providerLimitId?: string;
    limitCategory?:
      | 'usage_limit'
      | 'rate_limit'
      | 'capacity'
      | 'temporary_throttle'
      | 'auth_invalid'
      | 'plan_invalid'
      | 'validation_failed'
      | 'disabled'
      | 'unknown';
  }>;
}>;

type AgentAccountUsageDiagnostic = Readonly<{
  kind:
    | 'unavailable'
    | 'provider_http'
    | 'runtime_signal'
    | 'projection'
    | 'validation'
    | 'storage'
    | 'unknown';
  code?: string;
  message?: string;
  status?: number;
  headers?: Record<string, string>;
  observedAtMs?: number;
}>;

/**
 * Provider-neutral account-usage observation accepted by the Agent runtime host.
 * The host owns validation and persistence; this type is only the author-facing DTO.
 */
export type AgentAccountUsageSnapshot = Readonly<{
  v: 1;
  recordId: string;
  recordKey: AgentAccountUsageRecordKey;
  providerId: string;
  accountSubject: Readonly<{
    kind: 'providerSubject' | 'provisionalLocalSubject';
    id: string;
    mergeKey?: string;
  }>;
  observedAtMs: number;
  fetchedAtMs: number;
  staleAfterMs: number;
  source:
    | 'runtimeSignal'
    | 'providerHttp'
    | 'proxy'
    | 'connectedServiceProbe'
    | 'cached'
    | 'manual'
    | 'unknown';
  confidence: 'confirmed' | 'estimated' | 'unknown';
  state:
    | 'not_loaded'
    | 'loaded_empty'
    | 'loaded_data'
    | 'stale_data'
    | 'error_last_known_good';
  planLabel?: string | null;
  accountLabel?: string | null;
  recoveryCredits?: AgentAccountUsageRecoveryCredits;
  meters: AgentAccountUsageMeter[];
  diagnostics?: AgentAccountUsageDiagnostic[];
}>;
