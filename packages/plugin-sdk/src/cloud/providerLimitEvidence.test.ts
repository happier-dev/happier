import { describe, expect, it } from 'vitest';

import {
  classifyProviderLimitEvidence,
  PROVIDER_LIMIT_EVIDENCE_CLASSIFIER_PROJECTION_V1,
} from './providerLimitEvidence.js';

describe('provider limit evidence classification', () => {
  it('classifies nested provider capacity payloads and Error instances through one SDK owner', () => {
    expect(classifyProviderLimitEvidence({
      turn: {
        error: {
          message: 'Selected model is at capacity. Please try a different model.',
          codexErrorInfo: 'other',
        },
      },
    })).toMatchObject({
      category: 'capacity',
      confidence: 'diagnostic',
      quotaScope: 'unknown',
      provenance: { kind: 'stableProviderMessage' },
    });
    expect(classifyProviderLimitEvidence(
      new Error('Selected model is at capacity. Please try a different model.'),
    )).toMatchObject({
      category: 'capacity',
      confidence: 'diagnostic',
      quotaScope: 'unknown',
      provenance: { kind: 'stableProviderMessage' },
    });
    expect(classifyProviderLimitEvidence(
      new Error('The service is currently experiencing high demand. Please try again later.'),
    )).toMatchObject({
      category: 'capacity',
      confidence: 'diagnostic',
      quotaScope: 'unknown',
      provenance: { kind: 'stableProviderMessage' },
    });
    expect(classifyProviderLimitEvidence(
      new Error('Internal Server Error'),
    )).toMatchObject({
      category: 'unknown',
      confidence: 'diagnostic',
    });
  });

  it('preserves structured status and provider-code classifications', () => {
    expect(classifyProviderLimitEvidence({ error: { data: { status: 429 } } })).toEqual({
      category: 'rate_limit',
      confidence: 'high',
      quotaScope: 'unknown',
      provenance: { kind: 'structured', httpStatus: 429 },
    });
    expect(classifyProviderLimitEvidence({ code: 'usage_limit_reached' })).toEqual({
      category: 'usage_limit',
      confidence: 'high',
      quotaScope: 'unknown',
      provenance: { kind: 'structured', providerCode: 'usage_limit_reached' },
    });
    expect(classifyProviderLimitEvidence({ code: 'insufficient_quota' })).toEqual({
      category: 'usage_limit',
      confidence: 'high',
      quotaScope: 'unknown',
      provenance: { kind: 'structured', providerCode: 'insufficient_quota' },
    });
    for (const [providerCode, category] of [
      ['account_disabled', 'disabled'],
      ['not_entitled', 'plan_invalid'],
      ['invalid_request_error', 'validation_failed'],
    ] as const) {
      expect(classifyProviderLimitEvidence({ code: providerCode })).toEqual({
        category,
        confidence: 'high',
        quotaScope: 'unknown',
        provenance: { kind: 'structured', providerCode },
      });
    }
    expect(classifyProviderLimitEvidence({ message: 'account disabled' })).toMatchObject({
      category: 'disabled',
      confidence: 'diagnostic',
    });
    expect(classifyProviderLimitEvidence({ message: 'quota limit: 100 remaining: 95' })).toMatchObject({
      category: 'unknown',
      confidence: 'diagnostic',
    });
    for (const httpStatus of [500, 501, 502, 503, 504, 524, 529, 599]) {
      expect(classifyProviderLimitEvidence({ status: httpStatus })).toEqual({
        category: 'capacity',
        confidence: 'high',
        quotaScope: 'unknown',
        provenance: { kind: 'structured', httpStatus },
      });
    }
    expect(
      PROVIDER_LIMIT_EVIDENCE_CLASSIFIER_PROJECTION_V1
        .structuredResponseStatuses,
    ).toEqual([
      {
        statuses: [400],
        category: 'validation_failed',
        quotaScope: 'unknown',
      },
      {
        statuses: [401],
        category: 'auth_invalid',
        quotaScope: 'unknown',
      },
      {
        statuses: [402],
        category: 'plan_invalid',
        quotaScope: 'unknown',
      },
      {
        statuses: [429],
        category: 'rate_limit',
        quotaScope: 'unknown',
      },
      {
        range: { min: 500, max: 599 },
        category: 'capacity',
        quotaScope: 'unknown',
      },
    ]);
    const retryPredicate =
      PROVIDER_LIMIT_EVIDENCE_CLASSIFIER_PROJECTION_V1
        .piTerminalProviderErrors.retryPredicate;
    expect(retryPredicate.retryableHttpStatuses).toEqual([
      500,
      502,
      503,
      504,
      524,
    ]);
    for (const httpStatus of retryPredicate.retryableHttpStatuses) {
      expect(retryPredicate.commonRetryablePatterns).toContain(
        String(httpStatus),
      );
    }
  });

  it('does not turn broad authentication prose into actionful authentication evidence', () => {
    expect(classifyProviderLimitEvidence({ message: '401 invalid bearer token' })).toEqual({
      category: 'unknown',
      confidence: 'diagnostic',
      quotaScope: 'unknown',
      provenance: { kind: 'stableProviderMessage' },
    });
    expect(classifyProviderLimitEvidence({ code: 'authentication_error' })).toEqual({
      category: 'auth_invalid',
      confidence: 'high',
      quotaScope: 'unknown',
      provenance: { kind: 'structured', providerCode: 'authentication_error' },
    });
  });

  it.each(['0.81.0', '0.81.1', '0.82.0', '0.82.1'])(
    'admits exact Pi %s Anthropic terminal Provider signatures with pinned provenance',
    (producerVersion) => {
      expect(classifyProviderLimitEvidence(
        {
          type: 'error',
          reason: 'error',
          error: {
            role: 'assistant',
            provider: 'anthropic',
            stopReason: 'error',
            content: [],
            errorMessage: '429 {"type":"error","error":{"type":"rate_limit_error","message":"rate limit exceeded"}}',
          },
        },
        {
          kind: 'piTerminalProviderError',
          producerVersion,
          provider: 'anthropic',
        },
      )).toEqual({
        category: 'rate_limit',
        confidence: 'high',
        quotaScope: 'unknown',
        piRetryable: true,
        provenance: {
          kind: 'pinnedProviderTerminal',
          producer: 'pi',
          producerVersion,
          provider: 'anthropic',
          signatureId: 'anthropic-sdk-429-rate-limit-v1',
        },
      });
    },
  );

  it.each(['0.81.0', '0.81.1', '0.82.0', '0.82.1'])(
    'classifies exact retained Pi %s Anthropic 503 evidence through the canonical pinned owner',
    (producerVersion) => {
      expect(classifyProviderLimitEvidence(
        {
          type: 'error',
          reason: 'error',
          error: {
            role: 'assistant',
            provider: 'anthropic',
            stopReason: 'error',
            content: [],
            errorMessage:
              '503 {"type":"error","error":{"type":"api_error","message":"service unavailable"}}',
          },
        },
        {
          kind: 'piTerminalProviderError',
          producerVersion,
          provider: 'anthropic',
        },
      )).toEqual({
        category: 'capacity',
        confidence: 'high',
        quotaScope: 'unknown',
        piRetryable: true,
        provenance: {
          kind: 'pinnedProviderTerminal',
          producer: 'pi',
          producerVersion,
          provider: 'anthropic',
          signatureId: 'anthropic-sdk-503-api-error-v1',
        },
      });
    },
  );

  it('leaves an unretained Pi 503 terminal near-miss diagnostic-only', () => {
    expect(classifyProviderLimitEvidence(
      {
        type: 'error',
        reason: 'error',
        error: {
          role: 'assistant',
          provider: 'anthropic',
          stopReason: 'error',
          content: [],
          errorMessage:
            '503 {"type":"error","error":{"type":"api_error","message":"different outage prose"}}',
        },
      },
      {
        kind: 'piTerminalProviderError',
        producerVersion: '0.82.0',
        provider: 'anthropic',
      },
    )).toEqual({
      category: 'unknown',
      confidence: 'diagnostic',
      quotaScope: 'unknown',
      provenance: { kind: 'stableProviderMessage' },
    });
  });

  it.each([
    [
      'anthropic',
      '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
      'auth_invalid',
      'unknown',
      false,
      'anthropic-sdk-401-authentication-v1',
    ],
    [
      'anthropic',
      '429 {"type":"error","error":{"type":"insufficient_quota","message":"quota exceeded"}}',
      'usage_limit',
      'account',
      false,
      'anthropic-sdk-429-account-exhaustion-v1',
    ],
    [
      'anthropic',
      '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      'capacity',
      'unknown',
      true,
      'anthropic-sdk-529-overloaded-v1',
    ],
    [
      'openai-codex',
      'You have hit your ChatGPT usage limit.',
      'usage_limit',
      'account',
      false,
      'openai-codex-chatgpt-usage-limit-v1',
    ],
    [
      'openai-codex',
      'You have hit your ChatGPT usage limit (plus plan).',
      'usage_limit',
      'account',
      false,
      'openai-codex-chatgpt-usage-limit-v1',
    ],
    [
      'openai-codex',
      'You have hit your ChatGPT usage limit. Try again in ~12 min.',
      'usage_limit',
      'account',
      false,
      'openai-codex-chatgpt-usage-limit-v1',
    ],
    [
      'openai-codex',
      'You have hit your ChatGPT usage limit (team plan). Try again in ~0 min.',
      'usage_limit',
      'account',
      false,
      'openai-codex-chatgpt-usage-limit-v1',
    ],
  ])(
    'classifies exact %s terminal signature %s',
    (provider, errorMessage, category, quotaScope, piRetryable, signatureId) => {
      expect(classifyProviderLimitEvidence({
        type: 'error',
        reason: 'error',
        error: {
          role: 'assistant',
          provider,
          stopReason: 'error',
          content: [],
          errorMessage,
        },
      }, {
        kind: 'piTerminalProviderError',
        producerVersion: '0.82.0',
        provider,
      })).toEqual({
        category,
        confidence: 'high',
        quotaScope,
        piRetryable,
        provenance: {
          kind: 'pinnedProviderTerminal',
          producer: 'pi',
          producerVersion: '0.82.0',
          provider,
          signatureId,
        },
      });
    },
  );

  it('fails closed for unsupported Pi versions and assistant content lookalikes', () => {
    const context = {
      kind: 'piTerminalProviderError' as const,
      producerVersion: '0.82.2',
      provider: 'anthropic',
    };
    expect(classifyProviderLimitEvidence({
      type: 'error',
      reason: 'error',
      error: {
        role: 'assistant',
        provider: 'anthropic',
        stopReason: 'error',
        content: [],
        errorMessage: '429 {"type":"error","error":{"type":"rate_limit_error","message":"rate limit exceeded"}}',
      },
    }, context)).toMatchObject({
      category: 'rate_limit',
      confidence: 'diagnostic',
      provenance: { kind: 'stableProviderMessage' },
    });
    expect(classifyProviderLimitEvidence({
      type: 'done',
      reason: 'stop',
      message: {
        role: 'assistant',
        provider: 'anthropic',
        stopReason: 'stop',
        content: [{
          type: 'text',
          text: '429 {"type":"error","error":{"type":"rate_limit_error","message":"rate limit exceeded"}}',
        }],
      },
    }, {
      ...context,
      producerVersion: '0.82.0',
    })).not.toMatchObject({
      confidence: 'high',
      provenance: { kind: 'pinnedProviderTerminal' },
    });
  });

  it.each([
    '429 this is arbitrary prose',
    '429 {"type":"error","error":{"type":"invalid_request_error","message":"rate limit maybe"}}',
    '401 {"type":"error","error":{"type":"rate_limit_error","message":"wrong status for type"}}',
    '429 {"type":"assistant","error":{"type":"rate_limit_error","message":"assistant content"}}',
  ])('rejects same-status terminal lookalikes: %s', (errorMessage) => {
    expect(classifyProviderLimitEvidence({
      type: 'error',
      reason: 'error',
      error: {
        role: 'assistant',
        provider: 'anthropic',
        stopReason: 'error',
        content: [],
        errorMessage,
      },
    }, {
      kind: 'piTerminalProviderError',
      producerVersion: '0.82.0',
      provider: 'anthropic',
    })).not.toMatchObject({
      confidence: 'high',
      provenance: { kind: 'pinnedProviderTerminal' },
    });
  });

  it('does not infer provider capacity from unrelated unavailable metadata', () => {
    expect(classifyProviderLimitEvidence({
      status: 400,
      request: { status: 429 },
    })).toMatchObject({ category: 'validation_failed' });
    expect(classifyProviderLimitEvidence({
      status: 400,
      request: { note: 'Provider unavailable translation key' },
    })).toMatchObject({ category: 'validation_failed' });
    expect(classifyProviderLimitEvidence({ message: 'Provider unavailable' })).toMatchObject({
      category: 'capacity',
    });
  });
});
