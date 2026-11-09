import type {
  ProviderLimitCategory,
  ProviderAccountUsageQuotaScopeV1,
} from '@happier-dev/plugin-sdk/connected-accounts';

type PinnedPiTerminalSignature = Readonly<{
  provider: 'anthropic' | 'openai-codex';
  terminalMessagePattern?: string;
  httpStatus?: number;
  providerErrorType?: string;
  messagePattern?: string;
  category: ProviderLimitCategory;
  quotaScope: ProviderAccountUsageQuotaScopeV1;
  piRetryable: boolean;
}>;

const PI_REQUEST_AUTH_OBSERVED_RETRYABLE_HTTP_STATUSES = Object.freeze([
  500,
  502,
  503,
  504,
  524,
]);

/** Characterized native Pi formats and retry behavior used by its generated extension. */
export const PI_TERMINAL_PROVIDER_EVIDENCE_V1 = Object.freeze({
  producerVersions:
    Object.freeze(['0.81.0', '0.81.1', '0.82.0', '0.82.1']),
  retryPredicate: Object.freeze({
    retryableHttpStatuses:
      PI_REQUEST_AUTH_OBSERVED_RETRYABLE_HTTP_STATUSES,
    nonRetryablePatterns: Object.freeze([
      'GoUsageLimitError',
      'FreeUsageLimitError',
      'Monthly usage limit reached',
      'available balance',
      'insufficient_quota',
      'out of budget',
      'quota exceeded',
      'billing',
    ]),
    commonRetryablePatterns: Object.freeze([
      'overloaded',
      'rate.?limit',
      'too many requests',
      '429',
      ...PI_REQUEST_AUTH_OBSERVED_RETRYABLE_HTTP_STATUSES.map(String),
      'service.?unavailable',
      'server.?error',
      'internal.?error',
      'provider.?returned.?error',
      'network.?error',
      'connection.?error',
      'connection.?refused',
      'connection.?lost',
      'other side closed',
      'fetch failed',
      'upstream.?connect',
      'reset before headers',
      'socket hang up',
      'socket connection was closed',
      'timed? out',
      'timeout',
      'terminated',
      'websocket.?closed',
      'websocket.?error',
      'ended without',
      'stream ended before message_stop',
      'stream ended before a terminal response event',
      'http2 request did not get a response',
      'retry delay',
      'you can retry your request',
      'try your request again',
      'please retry your request',
      'ResourceExhausted',
    ]),
    retryablePatternsByVersion: Object.freeze({
      '0.81.0': Object.freeze([]),
      '0.81.1': Object.freeze([]),
      '0.82.0': Object.freeze(['getaddrinfo', 'ENOTFOUND', 'EAI_AGAIN']),
      '0.82.1': Object.freeze(['getaddrinfo', 'ENOTFOUND', 'EAI_AGAIN']),
    }),
  }),
  transientSignatures: Object.freeze([
    Object.freeze({
      provider: 'anthropic',
      terminalMessagePattern: '^Connection error\\.$',
    }),
    Object.freeze({
      provider: 'openai-codex',
      terminalMessagePattern: '^fetch failed$',
    }),
  ]),
  signatures: Object.freeze([
    {
      provider: 'openai-codex',
      httpStatus: 429,
      category: 'usage_limit',
      quotaScope: 'account',
      terminalMessagePattern: '^You have hit your ChatGPT usage limit(?: \\([a-z0-9][a-z0-9 _-]{0,31} plan\\))?\\.(?: Try again in ~\\d{1,9} min\\.)?$',
      piRetryable: false,
    },
    {
      provider: 'anthropic',
      httpStatus: 429,
      category: 'usage_limit',
      quotaScope: 'account',
      providerErrorType: 'insufficient_quota',
      messagePattern: '^quota exceeded$',
      piRetryable: false,
    },
    {
      provider: 'anthropic',
      httpStatus: 429,
      category: 'rate_limit',
      quotaScope: 'unknown',
      providerErrorType: 'rate_limit_error',
      messagePattern: '^rate limit exceeded$',
      piRetryable: true,
    },
    {
      provider: 'anthropic',
      httpStatus: 401,
      category: 'auth_invalid',
      quotaScope: 'unknown',
      providerErrorType: 'authentication_error',
      messagePattern: '^invalid x-api-key$',
      piRetryable: false,
    },
    {
      provider: 'anthropic',
      httpStatus: 529,
      category: 'capacity',
      quotaScope: 'unknown',
      providerErrorType: 'overloaded_error',
      messagePattern: '^overloaded$',
      piRetryable: true,
    },
    ...([500, 502, 503, 504] as const).map((httpStatus) => ({
      provider: 'anthropic' as const,
      httpStatus,
      category: 'capacity' as const,
      quotaScope: 'unknown' as const,
      providerErrorType: 'api_error',
      messagePattern: '^service unavailable$',
      piRetryable: true,
    })),
  ] satisfies readonly PinnedPiTerminalSignature[]),
});
