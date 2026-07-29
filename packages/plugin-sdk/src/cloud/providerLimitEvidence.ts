import type {
  ConnectedServiceLimitCategoryV1,
  ProviderAccountUsageQuotaScopeV1,
} from '@happier-dev/protocol';
import {
  PI_REQUEST_AUTH_PINNED_TERMINAL_PRODUCER_VERSIONS_V1,
  PI_REQUEST_AUTH_PINNED_TERMINAL_SIGNATURE_IDS_V1,
  PI_REQUEST_AUTH_PINNED_TERMINAL_SIGNATURES_V1,
} from '@happier-dev/protocol';

export type ProviderLimitCategory = ConnectedServiceLimitCategoryV1;
export type ProviderLimitEvidenceConfidence = 'high' | 'diagnostic' | 'none';
export type ProviderLimitEvidenceContext = Readonly<{
  kind: 'piTerminalProviderError';
  producerVersion: string;
  provider: string;
}>;
export type ProviderLimitEvidenceProvenance =
  | Readonly<{
      kind: 'structured';
      httpStatus?: number;
      providerCode?: string;
    }>
  | Readonly<{
      kind: 'pinnedProviderTerminal';
      producer: 'pi';
      producerVersion: string;
      provider: string;
      signatureId: string;
    }>
  | Readonly<{ kind: 'stableProviderMessage' }>
  | Readonly<{ kind: 'unknown' }>;
export type ProviderLimitEvidenceClassification = Readonly<{
  category: ProviderLimitCategory;
  confidence: ProviderLimitEvidenceConfidence;
  quotaScope: ProviderAccountUsageQuotaScopeV1;
  provenance: ProviderLimitEvidenceProvenance;
  piRetryable?: boolean;
}>;

type PinnedPiTerminalSignature = Readonly<{
  id: string;
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

function pinnedTerminalWireSignature(
  signatureId: (typeof PI_REQUEST_AUTH_PINNED_TERMINAL_SIGNATURE_IDS_V1)[
    keyof typeof PI_REQUEST_AUTH_PINNED_TERMINAL_SIGNATURE_IDS_V1
  ],
) {
  const signature = PI_REQUEST_AUTH_PINNED_TERMINAL_SIGNATURES_V1.find(
    (candidate) => candidate.signatureId === signatureId,
  );
  if (!signature) {
    throw new Error(`Missing Pi request-auth terminal wire signature: ${signatureId}`);
  }
  return {
    provider: signature.provider,
    httpStatus: signature.httpStatus,
    category: signature.limitCategory,
    quotaScope: signature.quotaScope,
  };
}

/**
 * Data-only projection embedded in Pi's self-contained request-auth extension.
 *
 * The exact version frontier is intentionally separate from Pi's broader complete-Provider
 * compatibility floor. Adding a supported Pi version does not enable terminal evidence until its
 * emitted Provider-error shape and AgentSession retry predicate have been characterized.
 */
export const PROVIDER_LIMIT_EVIDENCE_CLASSIFIER_PROJECTION_V1 = Object.freeze({
  structuredResponseStatuses: Object.freeze([
    Object.freeze({
      statuses: Object.freeze([400]),
      category: 'validation_failed' as const,
      quotaScope: 'unknown' as const,
    }),
    Object.freeze({
      statuses: Object.freeze([401]),
      category: 'auth_invalid' as const,
      quotaScope: 'unknown' as const,
    }),
    Object.freeze({
      statuses: Object.freeze([402]),
      category: 'plan_invalid' as const,
      quotaScope: 'unknown' as const,
    }),
    Object.freeze({
      statuses: Object.freeze([429]),
      category: 'rate_limit' as const,
      quotaScope: 'unknown' as const,
    }),
    Object.freeze({
      range: Object.freeze({ min: 500, max: 599 }),
      category: 'capacity' as const,
      quotaScope: 'unknown' as const,
    }),
  ]),
  structuredProviderCodes: Object.freeze([
    Object.freeze({
      pattern:
        '\\b(authentication_error|invalid_api_key|invalid_token|token_refresh_failed)\\b',
      category: 'auth_invalid' as const,
      quotaScope: 'unknown' as const,
    }),
    Object.freeze({
      pattern: '\\b(account_disabled|user_disabled|account_suspended)\\b',
      category: 'disabled' as const,
      quotaScope: 'unknown' as const,
    }),
    Object.freeze({
      pattern:
        '\\b(insufficient_quota|usage_limit_reached|usage_limit_exceeded|usagelimitreached|usagelimitexceeded|freeusagelimiterror)\\b',
      category: 'usage_limit' as const,
      quotaScope: 'unknown' as const,
    }),
    Object.freeze({
      pattern:
        '\\b(go_usage_limit|gousagelimiterror|account_rate_limit|rate_limit|rate_limit_error|ratelimit|ratelimiterror)\\b',
      category: 'rate_limit' as const,
      quotaScope: 'unknown' as const,
    }),
    Object.freeze({
      pattern:
        '\\b(overloaded_error|server_overloaded|capacity_exceeded|capacity_unavailable)\\b',
      category: 'capacity' as const,
      quotaScope: 'unknown' as const,
    }),
    Object.freeze({
      pattern:
        '\\b(billing_error|payment_required|plan_invalid|permission_error|not_entitled)\\b',
      category: 'plan_invalid' as const,
      quotaScope: 'unknown' as const,
    }),
    Object.freeze({
      pattern: '\\b(invalid_request_error|validation_error|bad_request)\\b',
      category: 'validation_failed' as const,
      quotaScope: 'unknown' as const,
    }),
  ]),
  piTerminalProviderErrors: Object.freeze({
    producerVersions:
      PI_REQUEST_AUTH_PINNED_TERMINAL_PRODUCER_VERSIONS_V1 as readonly string[],
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
        id: 'anthropic-sdk-network-fetch-failed-v1',
        provider: 'anthropic',
        terminalMessagePattern: '^Connection error\\.$',
      }),
      Object.freeze({
        id: 'openai-codex-network-fetch-failed-v1',
        provider: 'openai-codex',
        terminalMessagePattern: '^fetch failed$',
      }),
    ]),
    signatures: Object.freeze([
      {
        ...pinnedTerminalWireSignature(
          PI_REQUEST_AUTH_PINNED_TERMINAL_SIGNATURE_IDS_V1.openAiCodexChatgptUsageLimit,
        ),
        id: PI_REQUEST_AUTH_PINNED_TERMINAL_SIGNATURE_IDS_V1.openAiCodexChatgptUsageLimit,
        terminalMessagePattern:
          '^You have hit your ChatGPT usage limit(?: \\([a-z0-9][a-z0-9 _-]{0,31} plan\\))?\\.(?: Try again in ~\\d{1,9} min\\.)?$',
        piRetryable: false,
      },
      {
        ...pinnedTerminalWireSignature(
          PI_REQUEST_AUTH_PINNED_TERMINAL_SIGNATURE_IDS_V1.anthropicAccountExhaustion,
        ),
        id: PI_REQUEST_AUTH_PINNED_TERMINAL_SIGNATURE_IDS_V1.anthropicAccountExhaustion,
        providerErrorType: 'insufficient_quota',
        messagePattern: '^quota exceeded$',
        piRetryable: false,
      },
      {
        ...pinnedTerminalWireSignature(
          PI_REQUEST_AUTH_PINNED_TERMINAL_SIGNATURE_IDS_V1.anthropicRateLimit,
        ),
        id: PI_REQUEST_AUTH_PINNED_TERMINAL_SIGNATURE_IDS_V1.anthropicRateLimit,
        providerErrorType: 'rate_limit_error',
        messagePattern: '^rate limit exceeded$',
        piRetryable: true,
      },
      {
        ...pinnedTerminalWireSignature(
          PI_REQUEST_AUTH_PINNED_TERMINAL_SIGNATURE_IDS_V1.anthropicAuthentication,
        ),
        id: PI_REQUEST_AUTH_PINNED_TERMINAL_SIGNATURE_IDS_V1.anthropicAuthentication,
        providerErrorType: 'authentication_error',
        messagePattern: '^invalid x-api-key$',
        piRetryable: false,
      },
      {
        ...pinnedTerminalWireSignature(
          PI_REQUEST_AUTH_PINNED_TERMINAL_SIGNATURE_IDS_V1.anthropicOverloaded,
        ),
        id: PI_REQUEST_AUTH_PINNED_TERMINAL_SIGNATURE_IDS_V1.anthropicOverloaded,
        providerErrorType: 'overloaded_error',
        messagePattern: '^overloaded$',
        piRetryable: true,
      },
      ...([
        PI_REQUEST_AUTH_PINNED_TERMINAL_SIGNATURE_IDS_V1.anthropicApiError500,
        PI_REQUEST_AUTH_PINNED_TERMINAL_SIGNATURE_IDS_V1.anthropicApiError502,
        PI_REQUEST_AUTH_PINNED_TERMINAL_SIGNATURE_IDS_V1.anthropicApiError503,
        PI_REQUEST_AUTH_PINNED_TERMINAL_SIGNATURE_IDS_V1.anthropicApiError504,
      ] as const).map((id) => ({
        ...pinnedTerminalWireSignature(id),
        id,
        providerErrorType: 'api_error',
        messagePattern: '^service unavailable$',
        piRetryable: true,
      })),
    ] as readonly PinnedPiTerminalSignature[]),
  }),
});

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function normalizeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function normalizeStatusCode(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599) return value;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^[1-5]\d{2}$/u.test(trimmed)) return null;
  return Number(trimmed);
}

function readProviderCode(value: unknown): string | null {
  const record = readRecord(value);
  if (!record) return null;
  return normalizeString(record.code ?? record.type ?? record.reason ?? record.name);
}

function isStatusCodeKey(key: string): boolean {
  return ['code', 'errorcode', 'httpstatus', 'status', 'statuscode'].includes(
    key.replace(/[_-]/gu, '').toLowerCase(),
  );
}

const PROVIDER_ERROR_EVIDENCE_FIELDS = [
  'name',
  'code',
  'type',
  'reason',
  'status',
  'message',
  'errorMessage',
  'error_message',
  'detail',
  'details',
  'additionalDetails',
  'additional_details',
  'error',
  'errors',
  'data',
  'body',
  'response',
  'cause',
  'innerError',
  'turn',
] as const;

function readStatusCode(value: unknown, seen = new Set<object>()): number | null {
  if (!value || typeof value !== 'object') return null;
  if (seen.has(value)) return null;
  seen.add(value);

  let fallback: number | null = null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const status = readStatusCode(item, seen);
      if (status === 429) return status;
      fallback ??= status;
    }
    return fallback;
  }

  const record = readRecord(value);
  if (!record) return null;
  for (const [key, nested] of Object.entries(record)) {
    if (!isStatusCodeKey(key)) continue;
    const status = normalizeStatusCode(nested);
    if (status === 429) return status;
    fallback ??= status;
  }
  for (const field of PROVIDER_ERROR_EVIDENCE_FIELDS) {
    const status = readStatusCode(record[field], seen);
    if (status === 429) return status;
    fallback ??= status;
  }
  return fallback;
}

function collectEvidenceText(value: unknown, output: string[], seen = new Set<object>()): void {
  if (typeof value === 'string') {
    output.push(value);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);

  if (value instanceof Error) {
    output.push(value.name, value.message);
  }
  if (Array.isArray(value)) {
    for (const item of value) collectEvidenceText(item, output, seen);
    return;
  }
  const record = readRecord(value);
  if (!record) return;
  for (const field of PROVIDER_ERROR_EVIDENCE_FIELDS) {
    collectEvidenceText(record[field], output, seen);
  }
}

function classifyPinnedPiTerminalProviderError(
  value: unknown,
  context: ProviderLimitEvidenceContext | undefined,
): ProviderLimitEvidenceClassification | null {
  if (!context || context.kind !== 'piTerminalProviderError') return null;
  const projection = PROVIDER_LIMIT_EVIDENCE_CLASSIFIER_PROJECTION_V1.piTerminalProviderErrors;
  if (!projection.producerVersions.includes(context.producerVersion)) return null;

  const event = readRecord(value);
  const error = readRecord(event?.error);
  const content = error?.content;
  const errorMessage = normalizeString(error?.errorMessage);
  if (
    event?.type !== 'error'
    || event.reason !== 'error'
    || error?.role !== 'assistant'
    || error?.stopReason !== 'error'
    || error?.provider !== context.provider
    || !Array.isArray(content)
    || content.length !== 0
    || !errorMessage
  ) {
    return null;
  }

  for (const signature of projection.signatures) {
    if (signature.provider !== context.provider) continue;
    if (signature.terminalMessagePattern) {
      if (!new RegExp(signature.terminalMessagePattern, 'u').test(errorMessage)) continue;
    } else {
      const envelopeMatch = /^([1-5]\d{2})\s+(\{.*\})$/u.exec(errorMessage);
      if (!envelopeMatch) continue;
      const httpStatus = Number(envelopeMatch[1]);
      let envelope: unknown;
      try {
        envelope = JSON.parse(envelopeMatch[2] ?? '');
      } catch {
        continue;
      }
      const envelopeRecord = readRecord(envelope);
      const providerError = readRecord(envelopeRecord?.error);
      const providerErrorType = normalizeString(providerError?.type);
      const providerErrorMessage = normalizeString(providerError?.message);
      if (
        envelopeRecord?.type !== 'error'
        || signature.httpStatus !== httpStatus
        || signature.providerErrorType !== providerErrorType
        || !providerErrorMessage
        || (
          signature.messagePattern
          && !new RegExp(signature.messagePattern, 'iu').test(providerErrorMessage)
        )
      ) {
        continue;
      }
    }
    return {
      category: signature.category,
      confidence: 'high',
      quotaScope: signature.quotaScope,
      piRetryable: signature.piRetryable,
      provenance: {
        kind: 'pinnedProviderTerminal',
        producer: 'pi',
        producerVersion: context.producerVersion,
        provider: context.provider,
        signatureId: signature.id,
      },
    };
  }
  return null;
}

function structuredClassification(
  category: ProviderLimitCategory,
  params: Readonly<{
    status?: number | null;
    providerCode?: string | null;
    quotaScope?: ProviderAccountUsageQuotaScopeV1;
  }>,
): ProviderLimitEvidenceClassification {
  return {
    category,
    confidence: 'high',
    quotaScope: params.quotaScope ?? 'unknown',
    provenance: {
      kind: 'structured',
      ...(params.status !== null && params.status !== undefined
        ? { httpStatus: params.status }
        : {}),
      ...(params.providerCode ? { providerCode: params.providerCode } : {}),
    },
  };
}

function classifyStructuredResponseStatus(
  status: number | null,
): Readonly<{
  category: ProviderLimitCategory;
  quotaScope: ProviderAccountUsageQuotaScopeV1;
}> | null {
  if (status === null) return null;
  for (
    const rule
    of PROVIDER_LIMIT_EVIDENCE_CLASSIFIER_PROJECTION_V1
      .structuredResponseStatuses
  ) {
    if (
      ('statuses' in rule && rule.statuses.some((candidate) => candidate === status))
      || (
        'range' in rule
        && status >= rule.range.min
        && status <= rule.range.max
      )
    ) {
      return {
        category: rule.category,
        quotaScope: rule.quotaScope,
      };
    }
  }
  return null;
}

function classifyStructuredProviderCode(
  code: string,
): Readonly<{
  category: ProviderLimitCategory;
  quotaScope: ProviderAccountUsageQuotaScopeV1;
}> | null {
  for (
    const rule
    of PROVIDER_LIMIT_EVIDENCE_CLASSIFIER_PROJECTION_V1
      .structuredProviderCodes
  ) {
    if (!new RegExp(rule.pattern, 'u').test(code)) continue;
    return {
      category: rule.category,
      quotaScope: rule.quotaScope,
    };
  }
  return null;
}

function diagnosticClassification(
  category: ProviderLimitCategory,
  hasText: boolean,
): ProviderLimitEvidenceClassification {
  return {
    category,
    confidence: category === 'unknown' && !hasText ? 'none' : 'diagnostic',
    quotaScope: 'unknown',
    provenance: hasText ? { kind: 'stableProviderMessage' } : { kind: 'unknown' },
  };
}

export function classifyProviderLimitEvidence(
  value: unknown,
  context?: ProviderLimitEvidenceContext,
): ProviderLimitEvidenceClassification {
  const pinned = classifyPinnedPiTerminalProviderError(value, context);
  if (pinned) return pinned;

  const record = readRecord(value);
  const status = readStatusCode(value);
  const textParts: string[] = [];
  collectEvidenceText(value, textParts);
  const text = textParts.join(' ').toLowerCase();
  const rawCode = readProviderCode(record);
  const code = rawCode?.toLowerCase() ?? '';
  const evidenceText = `${code} ${text}`;

  const structuredProviderCode = classifyStructuredProviderCode(code);
  if (structuredProviderCode) {
    return structuredClassification(structuredProviderCode.category, {
      providerCode: rawCode,
      quotaScope: structuredProviderCode.quotaScope,
    });
  }

  const structuredResponseStatus = classifyStructuredResponseStatus(status);
  if (structuredResponseStatus) {
    return structuredClassification(structuredResponseStatus.category, {
      status,
      quotaScope: structuredResponseStatus.quotaScope,
    });
  }
  if (status === 403 && /\b(scope|permission|auth|token|credential|forbidden)\b/u.test(text)) {
    return structuredClassification('auth_invalid', { status });
  }
  if (status === 402) return structuredClassification('plan_invalid', { status });
  if (status === 400) return structuredClassification('validation_failed', { status });

  if (/\b(account|user)\s+(disabled|banned|suspended|deactivated)\b/u.test(text)) {
    return diagnosticClassification('disabled', true);
  }
  if (/\b(go_usage_limit|gousagelimiterror|account_rate_limit|rate_limit|rate_limit_error|ratelimit|ratelimiterror|rate limit|too many requests)\b/u.test(evidenceText)) {
    return diagnosticClassification('rate_limit', true);
  }
  if (/\b(resource_exhausted|usage limit|limit reached|out of credits|credits exhausted)\b|\bquota(?:[_\s-]*(?:exceeded|exhausted|reached)|[_\s-]*limit[_\s-]*(?:exceeded|exhausted|reached))\b/u.test(evidenceText)) {
    return diagnosticClassification('usage_limit', true);
  }
  if (/\b(upgrade|plan|billing|payment required|subscription|permission denied|not entitled|entitlement)\b/u.test(text)) {
    return diagnosticClassification('plan_invalid', true);
  }
  if (/\b(capacity|overloaded|server[_\s-]*(?:is[_\s-]*)?overloaded|model[_\s-]*(?:is[_\s-]*)?overloaded|capacity[_\s-]*(?:exceeded|unavailable)|(?:model|server|provider|service)[_\s-]*(?:is[_\s-]*)?unavailable)\b/u.test(evidenceText)) {
    return diagnosticClassification('capacity', true);
  }
  if (/\b(validation|invalid request|bad request|malformed)\b/u.test(text)) {
    return diagnosticClassification('validation_failed', true);
  }
  return diagnosticClassification('unknown', textParts.length > 0);
}
