import type {
  ConnectedServiceCredentialRecordV1,
  ConnectedServiceId,
  ConnectedServiceQuotaRecoveryCreditConsumeReceiptStatusV1,
  ConnectedServiceQuotaSnapshotV1,
  ProviderAccountSubscriptionV1,
} from '@happier-dev/protocol';

export type ConnectedServiceSubscriptionFetcher = Readonly<{
  serviceId: ConnectedServiceId;
  pollPolicy?: Readonly<{ minPollIntervalMs?: number; retryAfterBackoffMinMs?: number }>;
  fetch: (params: Readonly<{
    record: ConnectedServiceCredentialRecordV1;
    now: number;
    signal: AbortSignal;
  }>) => Promise<ProviderAccountSubscriptionV1 | null>;
}>;

export type ConnectedServiceQuotaRecoveryCreditConsumeOutcome = Exclude<
  ConnectedServiceQuotaRecoveryCreditConsumeReceiptStatusV1,
  'unknown_after_timeout'
>;

export type ConnectedServiceQuotaFetcher = Readonly<{
  serviceId: ConnectedServiceId;
  pollPolicy?: Readonly<{
    minPollIntervalMs?: number;
    retryAfterBackoffMinMs?: number;
  }>;
  fetch: (params: Readonly<{
    record: ConnectedServiceCredentialRecordV1;
    now: number;
    signal: AbortSignal;
    /**
     * Offers acquired readings for the coordinator's fetch-deadline fallback, without publishing immediately.
     * Caller cancellation and publications after this invocation settles cannot produce a snapshot.
     */
    onPartialSnapshot?: (snapshot: ConnectedServiceQuotaSnapshotV1) => void;
  }>) => Promise<ConnectedServiceQuotaSnapshotV1 | null>;
  consumeRecoveryCredit?: (params: Readonly<{
    record: ConnectedServiceCredentialRecordV1;
    now: number;
    idempotencyKey: string;
    providerCreditId?: string;
    signal: AbortSignal;
  }>) => Promise<ConnectedServiceQuotaRecoveryCreditConsumeOutcome>;
}>;

export type ConnectedServiceQuotaFetcherHostParams = Readonly<{
  env: NodeJS.ProcessEnv;
  staleAfterMs: number;
}>;

export type ConnectedServiceQuotaFetcherDescriptor = Readonly<{
  loadQuota?: (params: ConnectedServiceQuotaFetcherHostParams) => ConnectedServiceQuotaFetcher;
  loadSubscription?: (params: ConnectedServiceQuotaFetcherHostParams) => ConnectedServiceSubscriptionFetcher;
}>;

/**
 * Stable machine codes for quota fetch failures. Do not change existing values;
 * add new ones only.
 *
 * - auth_failure   : HTTP 401 / missing or expired credentials
 * - missing_auth   : credential record is of the wrong kind (e.g. token instead of oauth)
 * - network        : underlying fetch threw a network-level error (no HTTP response)
 * - malformed      : HTTP 2xx but response body could not be parsed / schema invalid
 * - provider_backoff : any other non-2xx HTTP status (4xx except 401, 5xx, 429)
 */
export type ConnectedServiceQuotaFetchErrorCode =
  | 'auth_failure'
  | 'missing_auth'
  | 'network'
  | 'malformed'
  | 'provider_backoff';

export class ConnectedServiceQuotaFetchError extends Error {
  readonly status: number | null;
  readonly retryAfterMs: number | null;
  readonly quotaFetchErrorCode: ConnectedServiceQuotaFetchErrorCode;
  /** Provider-supplied machine code extracted from the error response body, when present. */
  readonly providerCode: string | null;
  /** Provider-owned classification that this auth failure cannot be fixed by retry/refresh. */
  readonly reconnectRequired: boolean;
  /** The provider may have applied the debit even though no consume outcome was received. */
  readonly recoveryCreditConsumeOutcomeUnknown: boolean;

  constructor(message: string, options: Readonly<{
    status?: number | null;
    retryAfterMs?: number | null;
    quotaFetchErrorCode: ConnectedServiceQuotaFetchErrorCode;
    providerCode?: string | null;
    reconnectRequired?: boolean;
    recoveryCreditConsumeOutcomeUnknown?: boolean;
  }>) {
    super(message);
    this.name = 'ConnectedServiceQuotaFetchError';
    this.status = typeof options.status === 'number' && Number.isFinite(options.status)
      ? Math.trunc(options.status)
      : null;
    this.retryAfterMs = typeof options.retryAfterMs === 'number' && Number.isFinite(options.retryAfterMs)
      ? Math.max(0, Math.trunc(options.retryAfterMs))
      : null;
    this.quotaFetchErrorCode = options.quotaFetchErrorCode;
    this.providerCode = typeof options.providerCode === 'string' && options.providerCode.trim()
      ? options.providerCode.trim()
      : null;
    this.reconnectRequired = options.reconnectRequired === true;
    this.recoveryCreditConsumeOutcomeUnknown = options.recoveryCreditConsumeOutcomeUnknown === true;
  }
}
