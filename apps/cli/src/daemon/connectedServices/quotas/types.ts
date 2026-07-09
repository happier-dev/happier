import type {
  ConnectedServiceCredentialRecordV1,
  ConnectedServiceId,
  ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1,
  ConnectedServiceQuotaSnapshotV1,
} from '@happier-dev/protocol';

export {
  ConnectedServiceQuotaFetchError,
} from '@happier-dev/plugin-sdk/experimental/cloud/auth';
export type {
  ConnectedServiceQuotaFetchErrorCode,
} from '@happier-dev/plugin-sdk/experimental/cloud/auth';

/**
 * Provider-issued error codes (`ConnectedServiceQuotaFetchError#providerCode`) that are
 * standard OAuth2 failure codes (RFC 6749 §5.2 plus the refresh-token-missing case Happier
 * itself synthesizes) and therefore genuinely cross-provider. Any provider's quota fetcher
 * error carrying one of these codes is treated as a terminal (reconnect-required) auth
 * failure by `ConnectedServiceQuotasCoordinator`. Provider-SPECIFIC failure codes (e.g.
 * Claude's missing-scope codes) must NOT be added here — declare them on the owning
 * provider's `ConnectedServiceQuotaFetcherDescriptor.terminalAuthFailureProviderCodes`
 * instead, per the plugin-SDK "provider specifics live in provider plugins, never in
 * core/daemon" thesis.
 */
export const STANDARD_OAUTH_TERMINAL_AUTH_PROVIDER_CODES: readonly string[] = Object.freeze([
  'invalid_grant',
  'invalid_client',
  'missing_refresh_token',
]);

export type ConnectedServiceQuotaFetcher = Readonly<{
  serviceId: ConnectedServiceId;
  loadQuota: (params: Readonly<{
    record: ConnectedServiceCredentialRecordV1;
    now: number;
    signal: AbortSignal;
  }>) => Promise<ConnectedServiceQuotaSnapshotV1 | null>;
  consumeRecoveryCredit?: (params: Readonly<{
    record: ConnectedServiceCredentialRecordV1;
    now: number;
    idempotencyKey: string;
    providerCreditId?: string;
    signal: AbortSignal;
  }>) => Promise<ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1 | void>;
  /**
   * Provider-specific `providerCode` values (see `ConnectedServiceQuotaFetchError`) that
   * this provider's quota fetcher can produce and that should be classified as a terminal
   * (reconnect-required) auth failure. Scoped to this fetcher's `serviceId` only — the
   * coordinator never applies one provider's codes to another provider's errors. Carried
   * through unchanged from the descriptor that created this fetcher; see
   * `ConnectedServiceQuotaFetcherDescriptor.terminalAuthFailureProviderCodes`.
   */
  terminalAuthFailureProviderCodes?: readonly string[];
}>;

export type ConnectedServiceQuotaFetcherDescriptorParams = Readonly<{
  env: NodeJS.ProcessEnv;
  staleAfterMs: number;
  userAgent?: string;
}>;

export type ConnectedServiceQuotaFetcherDescriptor = Readonly<{
  id: string;
  createFetcher: (params: ConnectedServiceQuotaFetcherDescriptorParams) => ConnectedServiceQuotaFetcher;
  /**
   * Provider-specific `providerCode` values that this provider's quota fetcher can produce
   * and that should be classified as a terminal (reconnect-required) auth failure — e.g.
   * Claude's `missing_claude_code_scope` / `claude_subscription_missing_claude_code_scope`.
   * Do NOT list standard OAuth2 codes here; those are centralized in
   * `STANDARD_OAUTH_TERMINAL_AUTH_PROVIDER_CODES` and apply to every provider already.
   * Threaded onto the created `ConnectedServiceQuotaFetcher` by
   * `createConnectedServiceQuotaFetchers` so the coordinator can scope classification by
   * `serviceId` without any provider-specific literal living in core/daemon code.
   */
  terminalAuthFailureProviderCodes?: readonly string[];
}>;
